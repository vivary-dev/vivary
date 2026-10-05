"""Block merge readiness until required reviews finish and every review thread is resolved.

The Codex GitHub connector keeps one summary comment per pull request. Its hidden marker
`<!-- codex-security-review:v1 {...} -->` and status table say which commit each review
covers and whether it is still running. A pull request is ready only when:

- the Codex Code Review (and the Security Review, when listed) is Completed for the
  pull request's exact head commit, and
- every review thread is resolved, outdated ones included, so each finding has an answered
  disposition.

Reviews run when a pull request opens, becomes ready, or someone comments
"@codex review"; a later push needs a new review of the final commit.

With --wait-seconds the check polls while a review is running, so its CI status stays
pending instead of passing early. A review of an earlier commit or an unresolved thread fails
at once. No GitHub event re-runs the check when a thread is resolved or a review finishes
later: re-run the check right before merging. It exits 0 only when both conditions hold.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

SUMMARY_MARKER = "<!-- codex-pull-request-review-summary -->"
CODEX_BOT = "chatgpt-codex-connector[bot]"
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


STALE = "stale"


COMPLETED_AT = re.compile(r'datetime="([0-9T:.\-+Z]+)"')


def _instant(text: str) -> datetime.datetime:
    return datetime.datetime.fromisoformat(text.replace("Z", "+00:00"))


def review_status(comments: list[dict], head_sha: str, base_changed_at: str | None = None) -> tuple[bool | str, str]:
    """Return (True | False | STALE, reason) for the Codex reviews of head_sha.

    False means a review is pending (running or not started); STALE means the latest
    review covers another commit and only a new "@codex review" can change that.
    """
    # Only the connector's own comment counts; anyone can post text containing the marker.
    summaries = [c for c in comments if SUMMARY_MARKER in (c.get("body") or "")
                 and (c.get("user") or {}).get("login") == CODEX_BOT and (c.get("user") or {}).get("type") == "Bot"]
    if not summaries:
        return False, "no Codex review summary yet; open the PR for review or comment \"@codex review\""
    body = max(summaries, key=lambda c: c.get("updated_at") or "")["body"]
    rows = {m.group("review"): m for m in ROW.finditer(body)}
    if "Code Review" not in rows:
        return False, "the Codex summary lists no Code Review"
    for name, row in rows.items():
        if not head_sha.startswith(row.group("commit")):
            return STALE, f"Codex {name} covers {row.group('commit')}, not head {head_sha[:7]}; comment \"@codex review\" on the final commit"
        if "Completed" not in row.group("status"):
            status = re.sub(r"<[^>]+>|\*", "", row.group("status")).strip()
            return False, f"Codex {name} for {head_sha[:7]} is not complete ({status})"
        # Retargeting a pull request changes what was reviewed without changing the head.
        done = COMPLETED_AT.search(row.group("status"))
        try:
            stale = bool(base_changed_at) and (not done or _instant(done.group(1)) < _instant(base_changed_at))
        except ValueError:
            return STALE, f"Codex {name} has an unreadable completion time; comment \"@codex review\""
        if stale:
            return STALE, f"Codex {name} finished before the base branch changed at {base_changed_at}; comment \"@codex review\""
    marker = STATE_MARKER.search(body)
    if marker and "Security Review" not in rows:
        return False, "the Codex summary has a security-review marker but no Security Review row"
    if marker:
        state = json.loads(marker.group(1))
        if state.get("headSha") and state["headSha"] != head_sha:
            return STALE, f"Codex review state is for {state['headSha'][:7]}, not head {head_sha[:7]}"
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


def fetch_pull(repository: str, number: int, token: str) -> dict:
    api = os.environ.get("GITHUB_API_URL", "https://api.github.com")
    return _request(f"{api}/repos/{repository}/pulls/{number}", token)


def fetch_timeline(repository: str, number: int, token: str) -> list[dict]:
    api = os.environ.get("GITHUB_API_URL", "https://api.github.com")
    events, page = [], 1
    while True:
        batch = _request(f"{api}/repos/{repository}/issues/{number}/timeline?per_page=100&page={page}", token)
        events += batch
        if len(batch) < 100:
            return events
        page += 1


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


def latest_base_change(events: list[dict]) -> str | None:
    """ISO time of the latest base-branch change in a pull request timeline, if any."""
    times = [e.get("created_at") for e in events if e.get("event") == "base_ref_changed" and e.get("created_at")]
    return max(times) if times else None


def evaluate(comments: list[dict], threads: list[dict], head_sha: str,
             base_changed_at: str | None = None) -> tuple[bool, bool, list[str]]:
    """Return (ready, review_pending, messages)."""
    complete, reason = review_status(comments, head_sha, base_changed_at)
    unresolved = unresolved_threads(threads)
    messages = [reason] + [f"unresolved review thread: {item}" for item in unresolved]
    return complete is True and not unresolved, complete is False, messages


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
        try:
            pull = fetch_pull(args.repository, args.pr, token)
            # The check attaches to the commit it ran on; never let an input name another commit.
            live = pull.get("head", {}).get("sha")
            if live != args.head_sha:
                print(f"required review gate: head {args.head_sha[:7]} is not PR #{args.pr}'s live head {str(live)[:7]}; BLOCKED")
                return 1
            if pull.get("draft"):
                print(f"required review gate: PR #{args.pr} is a draft; Codex reviews start when it is marked ready. BLOCKED")
                return 1
            comments, threads = fetch(args.repository, args.pr, token)
            base_changed_at = latest_base_change(fetch_timeline(args.repository, args.pr, token))
        except urllib.error.HTTPError as error:
            if 400 <= error.code < 500 and error.code != 429:
                print(f"required review gate: GitHub API refused the request: HTTP {error.code}", file=sys.stderr)
                return 1
            if time.monotonic() >= deadline:
                print(f"required review gate: GitHub API unavailable: HTTP {error.code}", file=sys.stderr)
                return 1
            print(f"required review gate: retrying after API error: HTTP {error.code}")
            time.sleep(args.interval)
            continue
        except (OSError, RuntimeError, ValueError, KeyError, TypeError) as error:
            if time.monotonic() >= deadline:
                print(f"required review gate: GitHub API unavailable: {error}", file=sys.stderr)
                return 1
            print(f"required review gate: retrying after API error: {error}")
            time.sleep(args.interval)
            continue
        ready, pending, messages = evaluate(comments, threads, args.head_sha, base_changed_at)
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
