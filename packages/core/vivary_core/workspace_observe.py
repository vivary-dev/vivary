"""Read-only checkout observation. This is the only impure module in the
slice: it may run read-only git queries and stat files, and nothing else. It
never fetches, never writes the index (--no-optional-locks), never honors
repository fsmonitor hooks, and never crawls - it observes exactly the explicit
allowlisted roots it is handed.

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
import stat
import subprocess
import threading
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from vivary_core.canonical import (
    _utf16_sort_key,
    is_absolute_root,
    is_within,
    is_within_allowlist,
    normalize_path,
)
from vivary_core.collation import CollationDomainError, locale_sort_key
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
_READ_CHUNK = 64 * 1024
_MAX_STDERR_BYTES = 8 * 1024
_MAX_MANIFEST_BYTES = 1024 * 1024
_SUBPROCESS_CLEANUP_TIMEOUT = 2.0

RunGit = Callable[[str, List[str]], Dict[str, Any]]


def _sanitized_git_env(
    worktree_config: Optional[Dict[str, str]] = None,
) -> Dict[str, str]:
    """A narrowly pinned environment for read-only observation.

    Drops every ambient `GIT_*` variable, restores only the fixed safety pins,
    then optionally injects validated worktree-filter values. The latter are
    carried in the environment so evidence command strings remain canonical
    across machines.
    """
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.upper().startswith("GIT_")
    }
    env.update(_PINNED_GIT_ENV)
    if worktree_config:
        env["GIT_CONFIG_COUNT"] = str(len(worktree_config))
        for index, (key, value) in enumerate(worktree_config.items()):
            env[f"GIT_CONFIG_KEY_{index}"] = key
            env[f"GIT_CONFIG_VALUE_{index}"] = value
    return env


def _config_discovery_git_env() -> Dict[str, str]:
    """Read the user's normal Git config without honoring `GIT_*` injection."""
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")}
    env["GIT_TERMINAL_PROMPT"] = "0"
    return env


def _capped_run(argv: List[str], env: Dict[str, str], limit: int) -> Dict[str, Any]:
    """Run ``argv`` with bounded stdout while draining stderr concurrently."""
    try:
        proc = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
    except OSError as error:
        return {
            "error": str(error),
            "stdout": b"",
            "stderr": b"",
            "code": None,
            "exceeded": False,
        }

    stderr_chunks: List[bytes] = []
    stderr_errors: List[Exception] = []

    def drain_stderr() -> None:
        captured = 0
        try:
            assert proc.stderr is not None
            while True:
                chunk = proc.stderr.read(_READ_CHUNK)
                if not chunk:
                    break
                room = _MAX_STDERR_BYTES - captured
                if room > 0:
                    kept = chunk[:room]
                    stderr_chunks.append(kept)
                    captured += len(kept)
        except (OSError, ValueError) as error:
            stderr_errors.append(error)

    stderr_reader = threading.Thread(target=drain_stderr, daemon=True)
    stderr_reader.start()

    stdout_chunks: List[bytes] = []
    total = 0
    exceeded = False
    stdout_error: Optional[Exception] = None
    try:
        assert proc.stdout is not None
        while True:
            chunk = proc.stdout.read(_READ_CHUNK)
            if not chunk:
                break
            room = limit - total
            if room > 0:
                kept = chunk[:room]
                stdout_chunks.append(kept)
                total += len(kept)
            if len(chunk) > room:
                exceeded = True
                proc.kill()
                break
    except (OSError, ValueError) as error:
        stdout_error = error
        try:
            proc.kill()
        except OSError:
            pass
    finally:
        try:
            code = proc.wait(timeout=_SUBPROCESS_CLEANUP_TIMEOUT)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except OSError:
                pass
            try:
                code = proc.wait(timeout=_SUBPROCESS_CLEANUP_TIMEOUT)
            except (OSError, subprocess.TimeoutExpired) as error:
                code = proc.returncode
                if stdout_error is None:
                    stdout_error = error
        except OSError as error:
            code = proc.returncode
            if stdout_error is None:
                stdout_error = error

        stderr_reader.join(_SUBPROCESS_CLEANUP_TIMEOUT)
        stderr_drain_timed_out = stderr_reader.is_alive()
        if stderr_drain_timed_out:
            # Closing BufferedReader here can block on the same lock held by its
            # read. The daemon already caps captured bytes, so report the timeout
            # and return rather than turning cleanup itself into an unbounded wait.
            stderr_errors.append(RuntimeError("stderr drain timed out"))

        for pipe in (proc.stdout, proc.stderr):
            if pipe is None or (pipe is proc.stderr and stderr_drain_timed_out):
                continue
            try:
                pipe.close()
            except (OSError, ValueError):
                pass

    run_error = stdout_error or (stderr_errors[0] if stderr_errors else None)
    return {
        "error": str(run_error) if run_error is not None else None,
        "stdout": b"".join(stdout_chunks),
        "stderr": b"".join(stderr_chunks),
        "code": code,
        "exceeded": exceeded,
    }


_WORKTREE_SEMANTIC_CONFIG = (
    ("core.autocrlf", {"true", "false", "input"}),
    ("core.eol", {"lf", "crlf", "native"}),
)


def _worktree_semantic_config(checkout_path: str) -> Dict[str, str]:
    """Preserve validated host worktree/ignore policy across the hardened Git boundary.

    The enum filters affect checkout bytes; ``core.excludesFile`` affects privacy.
    Restoring either means observations and fingerprints can legitimately vary with
    host Git policy, just as ordinary Git status does.
    """
    config: Dict[str, str] = {}
    env = _config_discovery_git_env()
    for key, allowed_values in _WORKTREE_SEMANTIC_CONFIG:
        outcome = _capped_run(
            ["git", "--no-optional-locks", "-C", checkout_path, "config", "--get", key],
            env,
            1024,
        )
        if (
            outcome["error"] is not None
            or outcome["exceeded"]
            or outcome["code"] != 0
        ):
            continue
        try:
            value = outcome["stdout"].decode("utf-8", "strict").strip().lower()
        except UnicodeDecodeError:
            continue
        if key == "core.autocrlf" and value != "input":
            parsed = _capped_run(
                [
                    "git",
                    "--no-optional-locks",
                    "-C",
                    checkout_path,
                    "config",
                    "--type=bool",
                    "--get",
                    key,
                ],
                env,
                1024,
            )
            if (
                parsed["error"] is not None
                or parsed["exceeded"]
                or parsed["code"] != 0
            ):
                continue
            try:
                value = parsed["stdout"].decode("utf-8", "strict").strip().lower()
            except UnicodeDecodeError:
                continue
        if value in allowed_values:
            config[key] = value

    # First ask the hardened process whether repository/worktree-scoped config
    # already supplies this key (including config.worktree and local includes).
    # Command-scope injection must never override a value that process can see.
    repo_excludes = _capped_run(
        [
            "git",
            "--no-optional-locks",
            "-C",
            checkout_path,
            "config",
            "--path",
            "--get",
            "core.excludesFile",
        ],
        _sanitized_git_env(),
        1024,
    )
    if (
        repo_excludes["error"] is not None
        or repo_excludes["exceeded"]
        or repo_excludes["code"] not in (0, 1)
    ):
        return config
    if repo_excludes["code"] == 0:
        return config

    # Query broader scopes explicitly: an observed repository must not choose
    # the path injected at command scope. `--path` gives Git ownership of `~`
    # expansion. A present but unusable higher-precedence value suppresses the
    # lower scope, matching Git's effective-config semantics.
    for scope in ("--global", "--system"):
        excludes = _capped_run(
            [
                "git",
                "--no-optional-locks",
                "config",
                scope,
                "--path",
                "--get",
                "core.excludesFile",
            ],
            env,
            1024,
        )
        if (
            excludes["error"] is not None
            or excludes["exceeded"]
            or excludes["code"] not in (0, 1)
        ):
            return config
        if excludes["code"] == 1:
            continue
        try:
            value = excludes["stdout"].decode("utf-8", "strict").rstrip("\r\n")
        except UnicodeDecodeError:
            return config
        if os.path.isfile(value) and os.access(value, os.R_OK):
            config["core.excludesFile"] = os.path.abspath(value)
        return config
    return config


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


def _default_run_git(
    checkout_path: str,
    args: List[str],
    *,
    worktree_config: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    # `core.fsmonitor` is repository configuration and can name an executable.
    # Override it on every Git invocation rather than trusting an observed
    # worktree's hook while performing a governed, read-only observation.
    #
    # Global/system config remains blocked from the governed command. The narrow
    # worktree-semantics allowlist is discovered separately, validated, and
    # re-applied through the pinned environment so Git-for-Windows autocrlf
    # worktrees are not falsely reported as dirty.
    semantic_config = (
        _worktree_semantic_config(checkout_path)
        if worktree_config is None
        else worktree_config
    )
    full_args = [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-C",
        checkout_path,
        *args,
    ]
    command = f"git {' '.join(full_args)}"
    outcome = _capped_run(
        ["git", *full_args],
        _sanitized_git_env(semantic_config),
        _MAX_BUFFER,
    )
    if outcome["error"] is not None:
        return {
            "ok": False,
            "stdout": "",
            "stderr": outcome["error"][:400],
            "command": command,
            "code": outcome["code"],
        }
    if outcome["exceeded"]:
        return {
            "ok": False,
            "stdout": "",
            "stderr": "stdout maxBuffer length exceeded",
            "command": command,
            "code": outcome["code"],
        }
    if outcome["code"] != 0:
        stderr_text = outcome["stderr"].decode("utf-8", errors="replace")
        return {
            "ok": False,
            "stdout": "",
            "stderr": stderr_text[:400],
            "command": command,
            "code": outcome["code"],
        }

    stdout_text = outcome["stdout"].decode("utf-8", errors="replace")
    return {"ok": True, "stdout": stdout_text.replace("\r\n", "\n"), "command": command}


# Marker files that say something about how a workspace is verified. They are
# stat-only after the repository's ignore policy has admitted their names;
# `package.json` is the one file whose *contents* are read, because presence
# alone is too weak a signal — a `package.json` for a docs site or a lint hook
# is common, and telling that workspace to run `npm test` produces a confusing
# failure rather than a check.
WORKSPACE_MARKERS = (
    "tropo.toml",
    "package.json",
    "pyproject.toml",
    "AGENTS.md",
    "STRATO.md",
    "tox.ini",
    "noxfile.py",
    "Cargo.toml",
    "go.mod",
    "Makefile",
)

# npm scaffolds this as `scripts.test`. It is a placeholder, not a check.
_NPM_PLACEHOLDER_TEST = 'echo "Error: no test specified" && exit 1'


def _is_safe_workspace_file(path: str) -> bool:
    """Reject reparse points and multiply linked files before marker admission."""
    try:
        info = os.lstat(path)
    except OSError:
        return False
    return (
        stat.S_ISREG(info.st_mode)
        and info.st_nlink == 1
        and not getattr(info, "st_reparse_tag", 0)
    )


def _observe_workspace_markers(
    worktree_root: str,
    run_git: RunGit,
) -> tuple[Optional[List[str]], set[str], str]:
    """Known root markers admitted by repository ignore policy.

    A marker can derive a required command, so it is governed data just like a
    dirty path or content match. Check every allowlisted name with
    `check-ignore --no-index` before statting or reading it: this applies the
    policy to tracked names too and leaves real tracked and untracked,
    non-ignored markers observable. An unavailable or malformed policy fails
    closed for the whole marker set.
    """
    ignored, ignore_command = _ignored_paths(
        worktree_root,
        list(WORKSPACE_MARKERS),
        run_git,
    )
    if ignored is None:
        return None, set(), ignore_command

    found = []
    for marker in WORKSPACE_MARKERS:
        if marker in ignored:
            continue
        path = os.path.join(worktree_root, marker)
        if _is_safe_workspace_file(path):
            found.append(marker)
            continue
    return sorted(found), ignored, ignore_command


def _observe_npm_test_script(worktree_root: str) -> Optional[str]:
    """`scripts.test` from one bounded, in-root regular file, or None.

    Open the descriptor without following POSIX symlinks, then bind it to the
    lstat identity observed before and after the open. The identity checks cover
    Windows reparse-point swaps where `O_NOFOLLOW` is unavailable. Single-link
    files only: an in-root hardlink can otherwise disclose a manifest owned
    outside the governed workspace.
    """
    path = os.path.join(worktree_root, "package.json")
    try:
        before = os.lstat(path)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or getattr(before, "st_reparse_tag", 0)
        ):
            return None
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
    except OSError:
        return None

    try:
        opened = os.fstat(descriptor)
        after = os.lstat(path)
        identities = {
            (before.st_dev, before.st_ino),
            (opened.st_dev, opened.st_ino),
            (after.st_dev, after.st_ino),
        }
        if (
            len(identities) != 1
            or not stat.S_ISREG(opened.st_mode)
            or opened.st_nlink != 1
            or opened.st_size > _MAX_MANIFEST_BYTES
            or not stat.S_ISREG(after.st_mode)
            or after.st_nlink != 1
            or getattr(after, "st_reparse_tag", 0)
        ):
            return None
        with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
            descriptor = -1
            manifest = json.load(handle)
    except (OSError, ValueError, RecursionError):
        return None
    finally:
        if descriptor >= 0:
            os.close(descriptor)

    if not isinstance(manifest, dict):
        return None
    scripts = manifest.get("scripts")
    if not isinstance(scripts, dict):
        return None
    script = scripts.get("test")
    if not isinstance(script, str) or not script.strip():
        return None
    return None if script.strip() == _NPM_PLACEHOLDER_TEST else script.strip()


def _known(value: Any, command: str) -> Dict[str, Any]:
    return {"status": "known", "value": value, "evidence": {"command": command}}


def _unknown(reason: str, command: str) -> Dict[str, Any]:
    return {"status": "unknown", "reason": reason, "evidence": {"command": command}}


def _parse_porcelain(stdout: str) -> Optional[List[Dict[str, str]]]:
    """Parse `git status --porcelain=v1 -z` without filename ambiguity."""
    if stdout == "":
        return []
    fields = stdout.split("\0")
    if fields[-1] != "":
        return None

    entries: List[Dict[str, str]] = []
    index = 0
    while index < len(fields) - 1:
        record = fields[index]
        if len(record) < 3 or record[2] != " ":
            return None
        state = record[:2].strip() or "??"
        path = record[3:]
        index += 1
        if "R" in state or "C" in state:
            # With `-z`, Git emits the destination in `record` and the source as
            # the following field. The source is consumed but never disclosed.
            if index >= len(fields) - 1:
                return None
            index += 1
        entries.append({"state": state, "path": path})
    return entries

def _ignored_paths(
    checkout_path: str,
    paths: List[str],
    run_git: RunGit,
) -> tuple[Optional[set[str]], str]:
    """Return tracked or untracked paths excluded by repository ignore policy.

    `--no-index` is the security-critical part: Git normally stops considering an
    ignored path once it is tracked, but governed observation must not disclose a
    path merely because it was committed before the privacy rule was added.
    Bounded argv chunks avoid one process per dirty path. Paths whose line-oriented
    `check-ignore` output would be ambiguous, and output real Git cannot produce,
    fail closed.
    """
    unique_paths = list(dict.fromkeys(path for path in paths if path))
    evidence_command = (
        f"git -c core.quotePath=false check-ignore --no-index -- "
        f"<{len(unique_paths)} paths>"
    )
    if any(
        any(ord(char) < 32 for char in path)
        or (path.startswith('"') and path.endswith('"'))
        for path in unique_paths
    ):
        return None, evidence_command

    chunks: List[List[str]] = []
    chunk: List[str] = []
    chunk_chars = 0
    for path in unique_paths:
        path_chars = len(path) + 3
        if path_chars > 6500:
            return None, evidence_command
        if chunk and (len(chunk) >= 128 or chunk_chars + path_chars > 6500):
            chunks.append(chunk)
            chunk = []
            chunk_chars = 0
        chunk.append(f"./{path}" if not path.startswith("./") else path)
        chunk_chars += path_chars
    if chunk:
        chunks.append(chunk)

    normalized_inputs = {normalize_path(path) for path in unique_paths}
    ignored: set[str] = set()
    for paths_chunk in chunks:
        result = run_git(
            checkout_path,
            [
                "-c",
                "core.quotePath=false",
                "check-ignore",
                "--no-index",
                "--",
                *paths_chunk,
            ],
        )
        if result.get("ok"):
            for ignored_path in result.get("stdout", "").splitlines():
                normalized_ignored_path = normalize_path(ignored_path)
                if normalized_ignored_path.startswith("./"):
                    normalized_ignored_path = normalized_ignored_path[2:]
                if normalized_ignored_path not in normalized_inputs:
                    return None, evidence_command
                ignored.add(normalized_ignored_path)
            continue
        if result.get("code") != 1:
            return None, evidence_command
    return ignored, evidence_command


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

    def sort_key(remote):
        name = remote["name"]
        try:
            return (0, locale_sort_key(name))
        except CollationDomainError:
            return (1, _utf16_sort_key(name))

    return sorted(values, key=sort_key)


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
    worktree_root = path

    toplevel = run_git(path, ["rev-parse", "--show-toplevel"])
    if toplevel["ok"]:
        facts["is_git_repository"] = _known(True, toplevel["command"])
        facts["worktree_root"] = _known(normalize_path(toplevel["stdout"].strip()), toplevel["command"])
        # Every linked worktree of one repository shares a common directory. It is
        # the only stable local identity available when no remote names the
        # repository — without it, each worktree of a remote-less repo looks like a
        # separate repository and their divergence never surfaces.
        common = run_git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
        if common["ok"] and common["stdout"].strip():
            facts["git_common_dir"] = _known(
                normalize_path(common["stdout"].strip()), common["command"]
            )
        else:
            facts["git_common_dir"] = _unknown("git_common_dir_unavailable", common["command"])
        worktree_root = facts["worktree_root"]["value"]

        markers, ignored_markers, ignore_command = _observe_workspace_markers(
            worktree_root,
            run_git,
        )
        if markers is None:
            facts["workspace_markers"] = _unknown(
                "ignore_policy_unavailable",
                ignore_command,
            )
            facts["npm_test_script"] = _unknown(
                "ignore_policy_unavailable",
                ignore_command,
            )
        else:
            facts["workspace_markers"] = _known(markers, "fs.stat workspace markers")
            if "package.json" in ignored_markers:
                # Do not turn a private manifest's existence or scripts into a
                # fact. It is indistinguishable from a manifest with no usable
                # test script and cannot derive `npm test`.
                facts["npm_test_script"] = _unknown(
                    "no_npm_test_script",
                    ignore_command,
                )
            else:
                npm_test = _observe_npm_test_script(worktree_root)
                facts["npm_test_script"] = (
                    _known(npm_test, "fs.read package.json scripts.test")
                    if npm_test is not None
                    else _unknown("no_npm_test_script", "fs.read package.json scripts.test")
                )
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
    if branch["ok"] and branch["stdout"].strip():
        facts["head_ref"] = _known(
            {"kind": "branch", "name": branch["stdout"].strip()}, branch["command"]
        )
    else:
        # `-q` suppresses the message only for the expected "not a symbolic ref"
        # case, which exits 1. Anything else — an invalid symbolic HEAD such as
        # `ref: refs/heads/foo.lock` exits 128 — is corruption, and reporting it as
        # a known detached HEAD turns a broken repository into a confident fact.
        # An injected runner that reports no exit code keeps the historical
        # reading, so custom runners are not silently reclassified.
        code = branch.get("code")
        if code is None or code == 1:
            facts["head_ref"] = _known({"kind": "detached"}, branch["command"])
        else:
            facts["head_ref"] = _unknown("head_ref_unresolvable", branch["command"])

    status = run_git(path, ["status", "--porcelain=v1", "-z"])
    if not status["ok"]:
        facts["dirty_entries"] = _unknown("status_unavailable", status["command"])
        facts["is_dirty"] = _unknown("status_unavailable", status["command"])
    else:
        entries = _parse_porcelain(status["stdout"])
        if entries is None:
            facts["dirty_entries"] = _unknown("status_malformed", status["command"])
            facts["is_dirty"] = _unknown("status_malformed", status["command"])
        else:
            ignored, ignore_command = _ignored_paths(
                worktree_root,
                [entry.get("path", "") for entry in entries],
                run_git,
            )
            if ignored is None:
                facts["dirty_entries"] = _unknown(
                    "ignore_policy_unavailable", ignore_command
                )
                facts["is_dirty"] = _unknown(
                    "ignore_policy_unavailable", ignore_command
                )
            else:
                visible_entries = [
                    entry
                    for entry in entries
                    if normalize_path(entry.get("path", "")) not in ignored
                ]
                evidence = {
                    "command": status["command"],
                    "privacy_command": ignore_command,
                }
                if len(visible_entries) != len(entries):
                    facts["dirty_entries"] = {
                        "status": "unknown",
                        "reason": "ignored_dirty_entries_excluded",
                        "evidence": evidence,
                    }
                    facts["is_dirty"] = {
                        "status": "unknown",
                        "reason": "ignored_dirty_entries_excluded",
                        "evidence": evidence,
                    }
                else:
                    facts["dirty_entries"] = {
                        "status": "known",
                        "value": visible_entries,
                        "evidence": evidence,
                    }
                    facts["is_dirty"] = {
                        "status": "known",
                        "value": len(entries) > 0,
                        "evidence": evidence,
                    }

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
    run_git    injectable git runner; failed results must include the numeric
               `code`, because privacy checks fail closed when it is absent.
    """
    if run_git is None:
        worktree_config: Dict[str, Dict[str, str]] = {}

        def run_default(path: str, args: List[str]) -> Dict[str, Any]:
            key = normalize_path(path)
            if key not in worktree_config:
                worktree_config[key] = _worktree_semantic_config(path)
            return _default_run_git(
                path,
                args,
                worktree_config=worktree_config[key],
            )

        run_git = run_default

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
        if not any(is_within_allowlist(root, raw_path) for root in allowlist):
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
            if not any(is_within_allowlist(root, resolved) for root in allowlist):
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
