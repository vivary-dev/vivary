"""Block merge readiness until the required review finishes and every review thread is resolved.

Required review source: the server-side independent reviewer
(`vivary-independent-review` on the Vivary host, outside this repository) publishes
`<!-- vivary-independent-review:v1 {...} -->` comments under an allowed GitHub identity and
opens one review thread per finding. A pull request is ready only when:

- the latest independent result for the pull request's exact head and base is completed,
  and posted a review thread for every finding it reported, and
- every review thread is resolved, outdated ones included, so each finding has an answered
  disposition.

A running result, or none yet for the exact head, waits. A failed result for the head, or one
against another base, blocks until the final commit is reviewed again. A Codex connector
review still in progress on the exact head also waits; finished, failed or quota-limited
Codex reviews, quota notices and Codex reviews of other commits are ignored.

With --wait-seconds the check polls while a review is running, so its CI status stays
pending instead of passing early. No GitHub event re-runs the check when a thread is
resolved or a review finishes later: re-run the check right before merging. It exits 0 only
when both conditions hold.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

SUMMARY_MARKER = "<!-- codex-pull-request-review-summary -->"
INDEPENDENT_MARKER = re.compile(r"<!-- vivary-independent-review:v1 (\{.*?\}) -->")
# Identities allowed to publish independent review results. A workflow's GITHUB_TOKEN acts as
# github-actions, so pull request code cannot act as them; anyone holding one of these accounts'
# credentials can, which is why the owner's Entire approval stays required before merging.
REVIEW_PUBLISHERS = {"Jeff-Kazzee"}
CODEX_BOT = "chatgpt-codex-connector[bot]"
STATE_MARKER = re.compile(r"<!-- codex-security-review:v1 (\{.*?\}) -->")
ROW = re.compile(r"^\|\s*[^|]*\*\*(?P<review>Code Review|Security Review)\*\*\s*\|(?P<status>[^|]*)\|\s*`(?P<commit>[0-9a-f]{7,40})`\s*\|", re.M)
THREADS_QUERY = """query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved comments(first: 1) { nodes { databaseId url author { login } } } }
      }
    }
  }
}"""


COMMENTS_QUERY = """query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { databaseId editor { login } }
      }
    }
  }
}"""
STALE = "stale"
# Row statuses that mean a Codex review is still in progress; any other status is terminal.
CODEX_IN_PROGRESS = ("Running", "In progress", "Queued", "Pending", "\U0001f504")
# Marks a comment whose last editor could not be read; such a comment never counts as a result.
UNKNOWN_EDITOR = object()


def codex_running(comments: list[dict], head_sha: str) -> str | None:
    """A reason if a Codex connector review is still running on head_sha, else None."""
    summaries = [c for c in comments if SUMMARY_MARKER in (c.get("body") or "")
                 and (c.get("user") or {}).get("login") == CODEX_BOT and (c.get("user") or {}).get("type") == "Bot"]
    if not summaries:
        return None
    body = max(summaries, key=lambda c: c.get("updated_at") or "")["body"]
    for row in ROW.finditer(body):
        if head_sha.startswith(row.group("commit")) and any(word in row.group("status") for word in CODEX_IN_PROGRESS):
            return f"Codex {row.group('review')} is still running on {head_sha[:7]}"
    return None


def _trusted(comment: dict) -> bool:
    """Written by an allowed publisher and, if edited, last edited by one."""
    editor = comment.get("editor", UNKNOWN_EDITOR)
    return ((comment.get("user") or {}).get("login") in REVIEW_PUBLISHERS
            and (editor is None or editor in REVIEW_PUBLISHERS))


def review_status(comments: list[dict], head_sha: str, base_sha: str,
                  threads: list[dict] | None = None) -> tuple[bool | str, str]:
    """Return (True | False | STALE, reason) for the required independent review of head and base.

    False means pending (missing or running); STALE means a failed result or one for another
    head or base, which only a new review of the final commit can replace.
    """
    results = []
    for comment in comments:
        if not _trusted(comment):
            continue
        for match in INDEPENDENT_MARKER.finditer(comment.get("body") or ""):
            try:
                state = json.loads(match.group(1))
            except ValueError:
                continue
            results.append((comment.get("updated_at") or "", state))
    if not results:
        return False, "no independent review yet; run `vivary-independent-review --pr N` on the Vivary host for the final head"
    current = [(t, s) for t, s in results if s.get("headSha") == head_sha]
    if not current:
        latest = max(results, key=lambda r: r[0])[1]
        # Waiting, not failing: a push always leaves an older result, and the new review starts after it.
        return False, (f"the latest independent review covers {str(latest.get('headSha'))[:7]}, not head {head_sha[:7]}; "
                       "waiting for a review of the final commit")
    state = max(current, key=lambda r: r[0])[1]
    if state.get("baseSha") != base_sha:
        return STALE, f"the independent review of {head_sha[:7]} used base {str(state.get('baseSha'))[:7]}, not {base_sha[:7]}"
    status = state.get("status")
    if status == "running":
        return False, f"the independent review of {head_sha[:7]} is still running"
    if status != "completed":
        return STALE, f"the independent review of {head_sha[:7]} is {status}; run it again"
    posted = state.get("threadComments")
    if not isinstance(state.get("findings"), int) or not isinstance(posted, list) or len(posted) != state["findings"]:
        return STALE, (f"the independent review of {head_sha[:7]} reported {state.get('findings')} finding(s) but "
                       f"recorded {len(posted) if isinstance(posted, list) else 'no'} review thread(s); "
                       "every finding needs a thread to resolve")
    started = {(((t.get("comments") or {}).get("nodes") or [{}])[0].get("databaseId")) for t in (threads or [])
               if ((((t.get("comments") or {}).get("nodes") or [{}])[0].get("author") or {}).get("login")
                   in REVIEW_PUBLISHERS)}
    missing = [i for i in posted if i not in started]
    if missing:
        return STALE, (f"the independent review of {head_sha[:7]} lists {len(missing)} review thread(s) that do not exist "
                       "on the pull request; run the review again")
    reason = codex_running(comments, head_sha)
    if reason:
        return False, reason
    return True, (f"independent review completed for {head_sha[:7]} on base {base_sha[:7]} "
                  f"({state.get('findings', 0)} finding(s), {state.get('model', 'unknown model')})")


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
    editors, after = {}, None
    while True:
        result = _request(f"{api}/graphql", token, {"query": COMMENTS_QUERY, "variables": {
            "owner": owner, "name": name, "number": number, "after": after}})
        if result.get("errors"):
            raise RuntimeError(f"GraphQL error: {result['errors']}")
        page_data = result["data"]["repository"]["pullRequest"]["comments"]
        editors.update({node["databaseId"]: (node.get("editor") or {}).get("login") for node in page_data["nodes"]})
        if not page_data["pageInfo"]["hasNextPage"]:
            break
        after = page_data["pageInfo"]["endCursor"]
    for comment in comments:
        comment["editor"] = editors.get(comment.get("id"), UNKNOWN_EDITOR)
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


def evaluate(comments: list[dict], threads: list[dict], head_sha: str, base_sha: str) -> tuple[bool, bool, list[str]]:
    """Return (ready, review_pending, messages)."""
    complete, reason = review_status(comments, head_sha, base_sha, threads)
    unresolved = unresolved_threads(threads)
    messages = [reason] + [f"unresolved review thread: {item}" for item in unresolved]
    return complete is True and not unresolved, complete is False, messages


def _rate_limited(error: urllib.error.HTTPError) -> bool:
    """GitHub signals an exhausted rate limit with 429, or with 403 and a retry or remaining-zero header."""
    headers = error.headers or {}
    return error.code == 429 or (error.code == 403 and (headers.get("retry-after") is not None
                                                        or headers.get("x-ratelimit-remaining") == "0"))


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
                print(f"required review gate: PR #{args.pr} is a draft; review it once it is marked ready. BLOCKED")
                return 1
            base_sha = pull.get("base", {}).get("sha")
            comments, threads = fetch(args.repository, args.pr, token)
        except urllib.error.HTTPError as error:
            if 400 <= error.code < 500 and not _rate_limited(error):
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
        ready, pending, messages = evaluate(comments, threads, args.head_sha, base_sha)
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
