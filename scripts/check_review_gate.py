"""Block merge readiness until required reviews finish and every review thread is resolved.

The Codex GitHub connector keeps one summary comment per pull request. Its hidden marker
`<!-- codex-security-review:v1 {...} -->` and status table say which commit each review
covers and whether it is still running. A pull request is ready only when:

- the Codex Code Review (and the Security Review, when listed) is Completed for the
  pull request's exact head commit, and
- every review thread is resolved, so each finding has an answered disposition.

Reviews run when a pull request opens, becomes ready, or someone comments
"@codex review"; a later push needs a new review of the final commit.

With --wait-seconds the check polls while a review is pending, so its CI status stays
pending instead of passing early. It exits 0 only when both conditions hold.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.request

SUMMARY_MARKER = "<!-- codex-pull-request-review-summary -->"
STATE_MARKER = re.compile(r"<!-- codex-security-review:v1 (\{.*?\}) -->")
ROW = re.compile(r"^\|\s*[^|]*\*\*(?P<review>Code Review|Security Review)\*\*\s*\|(?P<status>[^|]*)\|\s*`(?P<commit>[0-9a-f]{7,40})`\s*\|", re.M)
THREADS_QUERY = """query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved comments(first: 1) { nodes { url author { login } } } }
      }
    }
  }
}"""


def review_status(comments: list[dict], head_sha: str) -> tuple[bool, str]:
    """Return (complete, reason) for the Codex reviews of head_sha from issue comments."""
    summaries = [c for c in comments if SUMMARY_MARKER in (c.get("body") or "")]
    if not summaries:
        return False, "no Codex review summary yet; open the PR for review or comment \"@codex review\""
    body = max(summaries, key=lambda c: c.get("updated_at") or "")["body"]
    rows = {m.group("review"): m for m in ROW.finditer(body)}
    if "Code Review" not in rows:
        return False, "the Codex summary lists no Code Review"
    for name, row in rows.items():
        if not head_sha.startswith(row.group("commit")):
            return False, f"Codex {name} covers {row.group('commit')}, not head {head_sha[:7]}; comment \"@codex review\" on the final commit"
        if "Completed" not in row.group("status"):
            status = re.sub(r"<[^>]+>|\*", "", row.group("status")).strip()
            return False, f"Codex {name} for {head_sha[:7]} is not complete ({status})"
    marker = STATE_MARKER.search(body)
    if marker:
        state = json.loads(marker.group(1))
        if state.get("headSha") and state["headSha"] != head_sha:
            return False, f"Codex review state is for {state['headSha'][:7]}, not head {head_sha[:7]}"
        if state.get("status") not in (None, "completed"):
            return False, f"Codex review state is {state.get('status')}"
    return True, f"Codex reviews completed for {head_sha[:7]}"


def unresolved_threads(threads: list[dict]) -> list[str]:
    """Return a description for each unresolved review thread."""
    out = []
    for thread in threads:
        if thread.get("isResolved"):
            continue
        first = ((thread.get("comments") or {}).get("nodes") or [{}])[0]
        out.append(f"{(first.get('author') or {}).get('login', 'unknown')}: {first.get('url', 'thread')}")
    return out


def _request(url: str, token: str, payload: dict | None = None) -> object:
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(url, data=data, headers={
        "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
        "User-Agent": "vivary-review-gate"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def fetch(repository: str, number: int, token: str) -> tuple[list[dict], list[dict]]:
    api = os.environ.get("GITHUB_API_URL", "https://api.github.com")
    comments, page = [], 1
    while True:
        batch = _request(f"{api}/repos/{repository}/issues/{number}/comments?per_page=100&page={page}", token)
        comments += batch
        if len(batch) < 100:
            break
        page += 1
    owner, name = repository.split("/", 1)
    threads, after = [], None
    while True:
        result = _request(f"{api}/graphql", token, {"query": THREADS_QUERY, "variables": {
            "owner": owner, "name": name, "number": number, "after": after}})
        if result.get("errors"):
            raise RuntimeError(f"GraphQL error: {result['errors']}")
        page_data = result["data"]["repository"]["pullRequest"]["reviewThreads"]
        threads += page_data["nodes"]
        if not page_data["pageInfo"]["hasNextPage"]:
            break
        after = page_data["pageInfo"]["endCursor"]
    return comments, threads


def evaluate(comments: list[dict], threads: list[dict], head_sha: str) -> tuple[bool, bool, list[str]]:
    """Return (ready, review_pending, messages)."""
    complete, reason = review_status(comments, head_sha)
    unresolved = unresolved_threads(threads)
    messages = [reason] + [f"unresolved review thread: {item}" for item in unresolved]
    return complete and not unresolved, not complete, messages


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repository", default=os.environ.get("REPOSITORY"))
    parser.add_argument("--pr", type=int, default=int(os.environ.get("PR_NUMBER", "0")))
    parser.add_argument("--head-sha", default=os.environ.get("HEAD_SHA"))
    parser.add_argument("--wait-seconds", type=int, default=0)
    parser.add_argument("--interval", type=int, default=30)
    args = parser.parse_args()
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not (args.repository and args.pr and args.head_sha and token):
        print("required review gate: missing repository, PR number, head SHA or token", file=sys.stderr)
        return 2
    deadline = time.monotonic() + args.wait_seconds
    while True:
        comments, threads = fetch(args.repository, args.pr, token)
        ready, pending, messages = evaluate(comments, threads, args.head_sha)
        for message in messages:
            print(f"required review gate: {message}")
        # Wait only while a review is still running; unresolved threads need people, not time.
        if ready or not pending or time.monotonic() >= deadline:
            break
        time.sleep(args.interval)
    print(f"required review gate: {'READY' if ready else 'BLOCKED'} for PR #{args.pr} at {args.head_sha[:7]}")
    return 0 if ready else 1


if __name__ == "__main__":
    sys.exit(main())
