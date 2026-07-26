"""Read-only checkout observation. This is the only impure module in the
slice: it may run read-only git queries and stat files, and nothing else. It
never fetches, never writes the index (--no-optional-locks), and never
crawls - it observes exactly the explicit allowlisted roots it is handed.

Reference-guided Python port of src/workspace/observe.mjs (slice 2, ticket
#84/#88, decision 0008). The Node module is the frozen executable oracle:
every fact, reason string, and dict shape here must match its Node
counterpart exactly for the same git topology.

Language mapping (documented, deliberate; see python/README.md): Node's
async is an I/O style, not a contract - this module is synchronous and calls
the system git binary only (via subprocess), exactly as
vivary_core.evidence_sync does.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from vivary_core.canonical import (
    _utf16_sort_key,
    is_absolute_root,
    is_within,
    normalize_path,
)
from vivary_core.collation import locale_cmp_key
from vivary_core.event_contract import _default_clock

OBSERVATION_SCHEMA = "vivary.workspace-observation/v0"

# Ambient git-discovery env vars must never override the explicit -C target:
# this tool always names its repository root directly, so honoring an
# inherited GIT_DIR/GIT_WORK_TREE/etc. would let an environment variable
# silently redirect an entire observation to a different repository than
# the one the caller (and the allowlist check) actually asked about.
AMBIENT_GIT_ENV_KEYS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]

# The four keys above are not sufficient. Command-scope configuration
# (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*`), alternate
# object stores, ceiling directories and namespaces can each redirect what Git
# reports without naming a directory at all — a repository with no remotes can be
# made to observe as having an attacker-supplied origin, and that forged URL then
# becomes the repository identity used for grouping, conflicts and fingerprints.
# So the environment is pinned rather than filtered: every GIT_* variable is
# dropped, then the few that make the run deterministic are set explicitly.
_PINNED_GIT_ENV = {
    # Read only the repository's own config. Global/system config cannot add a
    # remote, but `url.<base>.insteadOf` can rewrite one, and an observation is
    # supposed to report the repository's ground truth.
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_SYSTEM": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    # Never block on a credential prompt: observation is read-only and unattended.
    "GIT_TERMINAL_PROMPT": "0",
}

_MAX_BUFFER = 4 * 1024 * 1024

RunGit = Callable[[str, List[str]], Dict[str, Any]]


def _sanitized_git_env() -> Dict[str, str]:
    """A narrowly pinned environment for read-only observation.

    Drops every `GIT_*` variable — an allowlist, not a denylist, because the set of
    Git variables that can change repository, config or object resolution grows with
    Git itself — then restores only the pins above.
    """
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")}
    env.update(_PINNED_GIT_ENV)
    return env


_CREDENTIAL_URL_RE = re.compile(r"\A([a-zA-Z][a-zA-Z0-9+.-]*://)(?:[^/@]*@)?(.*)\Z", re.DOTALL)
_SCP_CREDENTIAL_RE = re.compile(r"\A([^/@]*:[^/@]*)@([^/]+:.*)\Z", re.DOTALL)


def _redact_remote_url(url: str) -> str:
    """Strip credential-bearing userinfo from a remote URL.

    `git remote -v` returns `https://user:token@host/repo.git` verbatim, and the
    result is stored as both a fact and the repository identity, which capsule
    compilation later repeats in a human-readable claim — so an unredacted value
    reaches serialized observations, graphs, capsules and fingerprints alike.

    Userinfo is removed entirely rather than masked so that the same repository
    reached with and without embedded credentials canonicalizes to one identity.
    An scp-style `git@host:path` keeps its user — that is a well-known account name,
    not a secret — but `user:password@host:path` loses the whole userinfo.
    """
    match = _CREDENTIAL_URL_RE.match(url)
    if match:
        return match.group(1) + match.group(2)
    scp = _SCP_CREDENTIAL_RE.match(url)
    if scp:
        return scp.group(2)
    return url


def _default_run_git(checkout_path: str, args: List[str]) -> Dict[str, Any]:
    full_args = ["--no-optional-locks", "-C", checkout_path, *args]
    command = f"git {' '.join(full_args)}"
    try:
        proc = subprocess.run(
            ["git", *full_args],
            capture_output=True,
            env=_sanitized_git_env(),
        )
    except OSError as error:
        return {"ok": False, "stdout": "", "stderr": str(error)[:400], "command": command}

    stdout_bytes = proc.stdout or b""
    # Replicate Node's execFile maxBuffer: if the captured stdout exceeds the
    # buffer limit, execFile treats the whole invocation as failed (it never
    # silently returns truncated output) - mirrored here as a post-hoc length
    # check since Python's subprocess has no equivalent capture ceiling.
    if len(stdout_bytes) > _MAX_BUFFER:
        return {
            "ok": False,
            "stdout": "",
            "stderr": "stdout maxBuffer length exceeded"[:400],
            "command": command,
        }

    if proc.returncode != 0:
        stderr_bytes = proc.stderr or b""
        stderr_text = stderr_bytes.decode("utf-8", errors="replace")
        return {"ok": False, "stdout": "", "stderr": stderr_text[:400], "command": command}

    stdout_text = stdout_bytes.decode("utf-8", errors="replace")
    return {"ok": True, "stdout": stdout_text.replace("\r\n", "\n"), "command": command}


def _known(value: Any, command: str) -> Dict[str, Any]:
    return {"status": "known", "value": value, "evidence": {"command": command}}


def _unknown(reason: str, command: str) -> Dict[str, Any]:
    return {"status": "unknown", "reason": reason, "evidence": {"command": command}}


def _parse_porcelain(stdout: str) -> List[Dict[str, str]]:
    entries = []
    for line in stdout.split("\n"):
        if len(line) == 0:
            continue
        state = line[:2].strip() or "??"
        entries.append({"state": state, "path": line[3:]})
    return entries


_REMOTE_RE = re.compile(r"^(\S+)\t(.+) \((fetch|push)\)$")


def _parse_remotes(stdout: str) -> List[Dict[str, str]]:
    remotes: Dict[str, Dict[str, str]] = {}
    order: List[str] = []
    for line in stdout.split("\n"):
        match = _REMOTE_RE.match(line)
        if not match:
            continue
        name = match.group(1)
        entry = remotes.get(name)
        if entry is None:
            entry = {"name": name}
            remotes[name] = entry
            order.append(name)
        key = "fetch_url" if match.group(3) == "fetch" else "push_url"
        entry[key] = _redact_remote_url(normalize_path(match.group(2)))
    values = [remotes[name] for name in order]
    # Node sorts remotes with String.prototype.localeCompare. We use
    # locale_cmp_key (the cmp_to_key-wrapped comparator), NOT
    # collation.locale_sort_key: locale_sort_key eagerly computes collation
    # weights for every element even in a single-element list, so it raises
    # CollationDomainError on a remote name containing a character outside
    # the pinned collation domain (e.g. CJK) even though no comparison is
    # ever performed against it - a spurious failure Node's lazy
    # Array.prototype.sort comparator never exhibits (localeCompare is only
    # invoked when two elements are actually compared). locale_cmp_key's key
    # step only wraps each element; the comparator itself is deferred to
    # actual pairwise comparisons, matching Node's laziness exactly.
    return sorted(values, key=lambda r: locale_cmp_key(r["name"]))


def _to_iso_string(mtime_ns: int) -> str:
    # JS Date#toISOString for a Date constructed from stat mtime milliseconds
    # (Node's fetchHead.mtime.toISOString()): "YYYY-MM-DDTHH:MM:SS.mmmZ",
    # UTC, milliseconds truncated (not rounded) toward zero from mtime_ns.
    total_ms = mtime_ns // 1_000_000
    seconds, ms = divmod(total_ms, 1000)
    dt = datetime.fromtimestamp(seconds, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms:03d}Z"


def _observe_one(raw_path: str, run_git: RunGit) -> Dict[str, Any]:
    path = normalize_path(raw_path)
    facts: Dict[str, Any] = {}

    toplevel = run_git(path, ["rev-parse", "--show-toplevel"])
    if toplevel["ok"]:
        facts["is_git_repository"] = _known(True, toplevel["command"])
        facts["worktree_root"] = _known(normalize_path(toplevel["stdout"].strip()), toplevel["command"])
    else:
        # `--show-toplevel` fails for a bare repository too (it has no working
        # tree) - that is not the same fact as "not a git repository at all".
        # Check explicitly so a bare repo is honestly reported as a repository
        # with an unknown (structurally absent) worktree, not conflated with a
        # path that isn't a git repository.
        bare_check = run_git(path, ["rev-parse", "--is-bare-repository"])
        # A bare `git` subprocess inherits the caller's environment (see
        # _default_run_git below). If the calling process happens to have an
        # ambient GIT_DIR set, `--is-bare-repository` can answer "true" for
        # *some other, unrelated* bare repository reachable via that env var -
        # not the path we were actually asked to observe. A positive answer
        # alone is not enough: confirm the resolved git-dir genuinely IS this
        # path (a real bare repo's git-dir equals its own directory) before
        # trusting the classification. This is a positive confirmation that
        # the observed path itself is the bare repo, not just "some bare repo
        # is reachable from here".
        git_dir_check = None
        if bare_check["ok"] and bare_check["stdout"].strip() == "true":
            git_dir_check = run_git(path, ["rev-parse", "--absolute-git-dir"])
        if (
            git_dir_check is not None
            and git_dir_check["ok"]
            and normalize_path(git_dir_check["stdout"].strip()) == path
        ):
            facts["is_git_repository"] = _known(True, bare_check["command"])
            facts["worktree_root"] = _unknown("bare_repository_has_no_worktree", bare_check["command"])
        else:
            return {
                "raw_path": raw_path,
                "path": path,
                "status": "observed",
                "facts": {
                    "is_git_repository": _unknown(
                        "not_a_git_repository_or_git_failed", toplevel["command"]
                    )
                },
            }

    head = run_git(path, ["rev-parse", "HEAD"])
    facts["head_revision"] = (
        _known(head["stdout"].strip(), head["command"])
        if head["ok"]
        else _unknown("head_unresolvable_possibly_unborn_branch", head["command"])
    )

    branch = run_git(path, ["symbolic-ref", "--short", "-q", "HEAD"])
    facts["head_ref"] = (
        _known({"kind": "branch", "name": branch["stdout"].strip()}, branch["command"])
        if branch["ok"] and branch["stdout"].strip()
        else _known({"kind": "detached"}, branch["command"])
    )

    status = run_git(path, ["status", "--porcelain"])
    if status["ok"]:
        entries = _parse_porcelain(status["stdout"])
        facts["dirty_entries"] = _known(entries, status["command"])
        facts["is_dirty"] = _known(len(entries) > 0, status["command"])
    else:
        facts["dirty_entries"] = _unknown("status_unavailable", status["command"])
        facts["is_dirty"] = _unknown("status_unavailable", status["command"])

    remote = run_git(path, ["remote", "-v"])
    facts["remotes"] = (
        _known(_parse_remotes(remote["stdout"]), remote["command"])
        if remote["ok"]
        else _unknown("remotes_unreadable", remote["command"])
    )

    upstream = run_git(path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    facts["upstream"] = (
        _known(upstream["stdout"].strip(), upstream["command"])
        if upstream["ok"]
        else _unknown("no_upstream_configured", upstream["command"])
    )

    git_dir = run_git(path, ["rev-parse", "--absolute-git-dir"])
    if git_dir["ok"]:
        fetch_head_path = os.path.join(git_dir["stdout"].strip(), "FETCH_HEAD")
        try:
            st = os.stat(fetch_head_path)
        except OSError:
            facts["last_fetch"] = _unknown("no_fetch_recorded", "fs.stat FETCH_HEAD")
        else:
            facts["last_fetch"] = _known(_to_iso_string(st.st_mtime_ns), "fs.stat FETCH_HEAD")
    else:
        facts["last_fetch"] = _unknown("git_dir_unresolvable", git_dir["command"])

    return {"raw_path": raw_path, "path": path, "status": "observed", "facts": facts}


def observe_checkouts(
    paths: List[str],
    *,
    allowlist: Optional[List[str]] = None,
    now: Optional[Callable[[], str]] = None,
    run_git: Optional[RunGit] = None,
) -> Dict[str, Any]:
    """Observe explicit checkout roots read-only.

    paths      checkout roots to observe
    allowlist  explicit allowed roots; a path outside every allowlist entry
               is refused without running git.
    now        injectable clock for determinism.
    run_git    injectable git runner for tests.
    """
    if run_git is None:
        run_git = _default_run_git

    if not isinstance(allowlist, list) or len(allowlist) == 0:
        raise ValueError(
            "observeCheckouts requires an explicit non-empty allowlist of repository roots"
        )
    # #71: reject a bad allowlist ENTRY (empty, whitespace-only, or not an
    # absolute path) at construction time. An empty-string entry would
    # otherwise act as a silent wildcard inside is_within (normalize_path("") +
    # "/" === "/", which every absolute child path starts with) - fixed here,
    # at the allowlist layer, without changing is_within's pure lexical
    # contract at all.
    bad_entry_index = None
    for index, root in enumerate(allowlist):
        if not is_absolute_root(root):
            bad_entry_index = index
            break
    if bad_entry_index is not None:
        raise ValueError(
            "observeCheckouts requires every allowlist entry to be a non-empty absolute path "
            f"(entry {bad_entry_index}: {json.dumps(allowlist[bad_entry_index])})"
        )

    clock = now if now is not None else _default_clock
    checkouts: List[Dict[str, Any]] = []
    refusals: List[Dict[str, Any]] = []

    for raw_path in paths:
        if not any(is_within(root, raw_path) for root in allowlist):
            refusals.append(
                {
                    "raw_path": raw_path,
                    "path": normalize_path(raw_path),
                    "status": "refused",
                    "reason": "outside_allowlist",
                }
            )
            continue

        result = _observe_one(raw_path, run_git)

        # #67: post-resolution re-check. The fast lexical pre-git refusal above
        # stays first-line and unchanged (is_within/normalize_path remain pure
        # and never touch disk). But a raw path admitted only because it is a
        # DESCENDANT of an allowlisted directory (not the allowlist entry
        # itself) can still be a symlink/junction that resolves, via real git,
        # to a repository nobody ever allowlisted - the escape #67 was opened
        # for. Once _observe_one has resolved the real worktree_root (git
        # `--show-toplevel` follows symlinks), re-verify that resolved path is
        # ALSO within some allowlist entry; if it escaped, refuse instead of
        # returning the foreign repository's facts.
        #
        # A raw path that matches an allowlist entry EXACTLY is deliberately
        # exempt from this re-check: the operator named that precise path, so
        # wherever it resolves is the operator's own trust decision - this is
        # the same trust boundary an allowlist always represents, not a new
        # hole, and preserves the (pre-existing, still-desired) case where a
        # symlinked/junctioned root is itself the allowlisted path (see
        # test_topology.py's "symlink_root" case).
        path = normalize_path(raw_path)
        trusted_exactly = any(normalize_path(root) == path for root in allowlist)
        worktree_root_fact = result["facts"].get("worktree_root")
        if (
            not trusted_exactly
            and worktree_root_fact is not None
            and worktree_root_fact.get("status") == "known"
        ):
            resolved = worktree_root_fact["value"]
            if not any(is_within(root, resolved) for root in allowlist):
                refusals.append(
                    {
                        "raw_path": raw_path,
                        "path": path,
                        "status": "refused",
                        "reason": "resolved_outside_allowlist",
                    }
                )
                continue

        checkouts.append(result)

    return {
        "schema": OBSERVATION_SCHEMA,
        "observed_at": clock(),
        "allowlist": sorted((normalize_path(root) for root in allowlist), key=_utf16_sort_key),
        "checkouts": checkouts,
        "refusals": refusals,
    }
