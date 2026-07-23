"""First-party `evidence sync`: snapshot .vivary/evidence/ onto
refs/vivary/evidence as an append-only commit chain (each snapshot parented
on the previous one). The snapshot commit is pushed to the remote FIRST and
the local ref advances only after the push succeeds, so a rejected sync is
inert locally as well as remotely (#50). Pure git plumbing
(hash-object/mktree/commit-tree/update-ref) - no working-tree checkout of the
ref is ever required; this module has zero dependency on any
checkpoint/session tool - it only ever calls the system `git` binary.
Author/committer identity and dates are pinned by the caller so snapshot SHAs
are deterministic in tests.

Single-writer semantics: the push is never forced, so a remote ref that has
diverged from the local chain (someone else synced in between) fails closed
with a typed EvidenceSyncError. Multi-writer merge is explicitly deferred -
this module never attempts to reconcile divergent chains.

Reference-guided Python port of src/evidence/sync.mjs (slice 1, ticket #84,
decision 0008). The Node module is the frozen executable oracle: git objects
this module creates must be byte-identical (same SHAs) to what
src/evidence/sync.mjs would create for the same input, pinned identity, and
pinned date.

Language mapping (documented, deliberate; see python/README.md): Node's
async is an I/O style, not a contract - this module is synchronous and calls
the system git binary only (no GitPython), via subprocess.
"""

from __future__ import annotations

import os
import re
import subprocess
from typing import Any, Callable, Dict, List, Optional

from vivary_core.evidence_store import evidence_paths

DEFAULT_REF = "refs/vivary/evidence"
_ZERO_OID = "0" * 40

_NON_FAST_FORWARD_RE = re.compile(r"non-fast-forward|rejected|stale info", re.IGNORECASE)


class EvidenceSyncError(Exception):
    def __init__(self, code: str, message: str, detail: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(message)
        self.name = "EvidenceSyncError"
        self.code = code
        self.message = message
        for key, value in (detail or {}).items():
            setattr(self, key, value)


class _GitError(Exception):
    """Internal: a failed `git` invocation, carrying decoded stderr text the
    way Node's err.stderrText does."""

    def __init__(self, stderr_text: str) -> None:
        super().__init__(stderr_text)
        self.stderr_text = stderr_text


def _run(cwd: str, env: Dict[str, str], args: List[str], *, as_bytes: bool = False):
    proc = subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True)
    if proc.returncode != 0:
        stderr_text = proc.stderr.decode("utf-8", errors="replace") if isinstance(proc.stderr, (bytes, bytearray)) else (proc.stderr or "")
        raise _GitError(stderr_text)
    return proc.stdout if as_bytes else proc.stdout.decode("utf-8")


def _run_with_input(cwd: str, env: Dict[str, str], args: List[str], input_text: str) -> str:
    proc = subprocess.run(["git", *args], cwd=cwd, env=env, input=input_text.encode("utf-8"), capture_output=True)
    if proc.returncode != 0:
        stderr_text = proc.stderr.decode("utf-8", errors="replace") if isinstance(proc.stderr, (bytes, bytearray)) else (proc.stderr or "")
        raise _GitError(stderr_text)
    return proc.stdout.decode("utf-8").strip()


def _pinned_env(identity: Dict[str, str], date: str) -> Dict[str, str]:
    env = dict(os.environ)
    env.update(
        {
            "GIT_AUTHOR_NAME": identity["name"],
            "GIT_AUTHOR_EMAIL": identity["email"],
            "GIT_COMMITTER_NAME": identity["name"],
            "GIT_COMMITTER_EMAIL": identity["email"],
            "GIT_AUTHOR_DATE": date,
            "GIT_COMMITTER_DATE": date,
        }
    )
    return env


def _require_git_repo(cwd: str) -> None:
    try:
        _run(cwd, dict(os.environ), ["rev-parse", "--git-dir"])
    except Exception as err:
        raise EvidenceSyncError("not_a_git_repo", f"not a git repository: {cwd}") from err


def _current_ref_sha(cwd: str, env: Dict[str, str], ref: str) -> Optional[str]:
    try:
        sha = _run(cwd, env, ["rev-parse", "--verify", "--quiet", ref]).strip()
        return sha or None
    except Exception:
        return None


def _list_evidence_files(dir_: str) -> List[str]:
    try:
        with os.scandir(dir_) as entries:
            # follow_symlinks=False mirrors Node's Dirent.isFile(), which
            # reports a symlink's own dirent type, not its target's.
            names = [entry.name for entry in entries if entry.is_file(follow_symlinks=False)]
    except FileNotFoundError:
        return []
    names.sort()
    return names


def sync_evidence(
    *,
    workspace_root: str,
    remote: str,
    identity: Dict[str, str],
    date: str,
    ref: str = DEFAULT_REF,
    message: str = "vivary evidence snapshot",
    _on_before_push_advances_local_ref: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> Dict[str, Any]:
    """Snapshot .vivary/evidence/ onto refs/vivary/evidence and push it.

    _on_before_push_advances_local_ref is test-only instrumentation, never
    used by any production caller. If supplied, it is called right after the
    push lands and right before the local ref is advanced - the exact race
    window a second local writer occupies. Lets tests deterministically
    simulate that writer (moving the local ref out from under this call)
    instead of racing real timing. A no-op by default.
    """
    _require_git_repo(workspace_root)
    env = _pinned_env(identity, date)
    dir_ = evidence_paths(workspace_root)["dir"]

    names = _list_evidence_files(dir_)
    blobs = []
    for name in names:
        # --no-filters: blob (and therefore tree/commit) SHAs must not depend
        # on the machine's core.autocrlf / attributes configuration.
        sha = _run(
            workspace_root, env, ["hash-object", "-w", "--no-filters", "--", os.path.join(dir_, name)]
        ).strip()
        blobs.append((name, sha))
    tree_input = "\n".join(f"100644 blob {sha}\t{name}" for name, sha in blobs)
    tree = _run_with_input(workspace_root, env, ["mktree"], f"{tree_input}\n" if tree_input else "")

    parent = _current_ref_sha(workspace_root, env, ref)
    commit_args = ["commit-tree", tree, "-m", message]
    if parent:
        commit_args += ["-p", parent]
    commit = _run(workspace_root, env, commit_args).strip()

    # Push FIRST, then advance the local ref (#50): a rejected push must be
    # inert locally. The snapshot commit is pushed by SHA, so nothing needs
    # the local ref to have moved yet; on rejection the commit object stays
    # unreferenced (garbage-collectable) and the local chain is exactly as it
    # was - retries cannot stack orphan snapshots on the ref.
    try:
        _run(workspace_root, env, ["push", remote, f"{commit}:{ref}"])
    except _GitError as err:
        stderr = err.stderr_text or ""
        if _NON_FAST_FORWARD_RE.search(stderr):
            raise EvidenceSyncError(
                "non_fast_forward", f"refusing non-fast-forward push of {ref}", {"stderr": stderr}
            ) from err
        raise EvidenceSyncError("push_failed", f"push of {ref} failed", {"stderr": stderr}) from err

    if callable(_on_before_push_advances_local_ref):
        _on_before_push_advances_local_ref(
            {"workspace_root": workspace_root, "ref": ref, "commit": commit, "parent": parent}
        )

    try:
        _run(workspace_root, env, ["update-ref", ref, commit, parent or _ZERO_OID])
    except _GitError as err:
        # The push has landed but the local ref moved underneath us (a second
        # local writer). Fail closed with the same typed error as before; the
        # caller reconciles - multi-writer merge remains explicitly deferred.
        raise EvidenceSyncError(
            "local_ref_diverged", f"local {ref} moved since it was read", {"stderr": err.stderr_text}
        ) from err

    return {"ref": ref, "commit": commit, "parent": parent, "tree": tree, "remote": remote, "pushed": True}


def read_evidence_snapshot(*, repo_dir: str, ref: str = DEFAULT_REF) -> Dict[str, bytes]:
    """Materialize files from a synced evidence ref (typically after `git
    fetch`) as {name: bytes} - raw object bytes, for round-trip verification
    or plain read-back. Uses `cat-file -p`, not `show`/checkout, so no eol
    smudge filter ever touches the bytes.
    """
    _require_git_repo(repo_dir)
    listing = _run(repo_dir, dict(os.environ), ["ls-tree", "-r", "--name-only", ref])
    names = sorted(n.strip() for n in listing.split("\n") if n.strip())

    files: Dict[str, bytes] = {}
    for name in names:
        files[name] = _run(repo_dir, dict(os.environ), ["cat-file", "-p", f"{ref}:{name}"], as_bytes=True)
    return files
