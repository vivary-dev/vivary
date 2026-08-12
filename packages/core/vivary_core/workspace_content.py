"""Read-only tracked-file content search. The second impure workspace module
(alongside workspace_observe.py): it resolves each checkout's HEAD, searches that
named commit with replacement objects disabled, fingerprints effective ignore
decisions over the tracked tree, and applies those decisions to matches. It never
touches the index, never writes, and only searches explicit allowlisted roots.

The named revision and shared privacy fingerprint bind content to the workspace graph:
later working-tree edits, replace refs, or ignore-policy changes cannot leave captured
evidence looking current. Untracked paths are structurally invisible. Tracked paths
excluded by repository policy are removed without exposing their names in the artifact.
See python/tests/test_content.py.

Reference-guided Python port of src/workspace/content.mjs (slice 2, ticket
#84, decision 0008). The Node module is the frozen executable oracle.

Language-mapping notes (python/README.md):
- Node's async is an I/O style, not a contract (see evidence_sync.py's same
  note): this module is synchronous, calling the injectable ``run_git``
  callable directly rather than awaiting it.
- ``sortedFiles = [...byFile.keys()].sort()`` and the final
  ``allowlist.map(normalizePath).sort()`` are both PLAIN sorts with no
  comparator - JS UTF-16 code-unit order, not locale order - reproduced with
  ``vivary_core.canonical.utf16_sort_key``.
- ``trimExcerpt``'s length cap and ``String#toWellFormed`` operate on JS
  UTF-16 code units, not Python codepoints; ``_js_utf16_length`` /
  ``_js_utf16_slice_wellformed`` below replicate that index space exactly
  (including replacing a surrogate-pair-straddling cut with U+FFFD) so an
  excerpt containing astral characters truncates at the same code-unit
  boundary the Node reference would. JS ``String#trim``'s exact whitespace
  set is reused from ``vivary_core.canonical._JS_TRIM_CHARS`` (read-only
  import - canonical.py itself is never modified or reimplemented).
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from vivary_core.canonical import (
    _JS_TRIM_CHARS,
    utf16_sort_key,
    is_absolute_root,
    is_canonical_absolute_path,
    is_safe_checkout_relative_path,
    is_within,
    is_within_allowlist,
    path_identity_key,
    normalize_path,
)

CONTENT_SCHEMA = "vivary.workspace-content/v0"

# Bounded on every axis, each an exported, documented constant:
MAX_FILES_PER_CHECKOUT = 8  # distinct files with a match, per checkout
MAX_MATCHES_PER_FILE = 3  # matched lines (excerpts) kept per file
MAX_EXCERPT_LENGTH = 200  # UTF-16 code units kept per excerpt

# Node's execFile maxBuffer for the git subprocess (bytes); exceeding it is a
# failure, not a truncation - mirrored here even though no fixture in this
# port's test suite drives output that large.
_MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024


RunGit = Callable[[str, List[str]], Dict[str, Any]]


# Deliberately the *same* hardened environment the observation layer builds, not a
# second copy: the four-key denylist above was bypassable through command-scope
# config injection here for exactly the same reason, and two independent copies of
# a security control drift.
from vivary_core.workspace_observe import (  # noqa: E402
    _capped_run,
    _content_privacy_policy,
    _sanitized_git_env,
    _worktree_semantic_config,
)




def _default_run_git(
    checkout_path: str,
    args: List[str],
    *,
    worktree_config: Optional[Dict[str, str]] = None,
    stdin_data: Optional[bytes] = None,
    cancelled: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    semantic_config = (
        _worktree_semantic_config(checkout_path, cancelled=cancelled)
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
    command = "git " + " ".join(full_args)
    outcome = _capped_run(
        ["git", *full_args],
        _sanitized_git_env(semantic_config),
        _MAX_GIT_OUTPUT_BYTES,
        stdin_data,
        cancelled,
    )
    if outcome["error"] is not None:
        return {
            "ok": False,
            "stdout": "",
            "stderr": outcome["error"][:400],
            "command": command,
            "code": outcome["code"],
        }

    stdout_bytes = outcome["stdout"]
    stderr_bytes = outcome["stderr"]

    if outcome["exceeded"]:
        return {
            "ok": False,
            "stdout": "",
            "stderr": "stdout maxBuffer length exceeded",
            "command": command,
            "code": outcome["code"],
        }

    if outcome["code"] != 0:
        # `git grep` exits 1 to mean "no matches" - that is a successful
        # search, not a failure, and must never be reported as one.
        if (
            outcome["code"] == 1
            and args
            and args[0] == "grep"
            and not stdout_bytes
            and not stderr_bytes
        ):
            return {
                "ok": True,
                "stdout": "",
                "command": command,
                "code": outcome["code"],
            }
        stderr_text = stderr_bytes.decode("utf-8", errors="replace")
        return {
            "ok": False,
            "stdout": "",
            "stderr": stderr_text[:400],
            "command": command,
            "code": outcome["code"],
        }

    stdout_text = stdout_bytes.decode("utf-8", errors="replace").replace(
        "\r\n", "\n"
    )
    return {
        "ok": True,
        "stdout": stdout_text,
        "command": command,
        "code": outcome["code"],
    }


def _dedupe_terms(terms: Optional[List[Any]]) -> List[str]:
    seen: List[str] = []
    for term in terms if terms is not None else []:
        if not isinstance(term, str) or len(term) == 0:
            continue
        if term not in seen:
            seen.append(term)
    return seen


def _js_utf16_length(s: str) -> int:
    # JS String#length counts UTF-16 code units: astral characters
    # (codepoint > U+FFFF) count as 2.
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in s)


def _js_utf16_slice_wellformed(s: str, max_units: int) -> str:
    # Slice the first `max_units` UTF-16 code units and repair (U+FFFD) a cut
    # that would otherwise straddle an astral character's surrogate pair -
    # the exact case String#toWellFormed exists to fix after a naive
    # String#slice(0, MAX_EXCERPT_LENGTH). Python strings index by codepoint,
    # not UTF-16 code unit, so a plain `s[:n]` would cut at the wrong
    # boundary for any string containing astral characters; this walks
    # codepoints while tracking UTF-16 width instead.
    units = 0
    out: List[str] = []
    for ch in s:
        width = 2 if ord(ch) > 0xFFFF else 1
        if units + width > max_units:
            if width == 2 and units < max_units:
                out.append("�")
            break
        out.append(ch)
        units += width
    return "".join(out)


def _to_well_formed(s: str) -> str:
    # String#toWellFormed over a Python str: every unpaired surrogate code
    # point anywhere in the string becomes U+FFFD (Node applies this to the
    # WHOLE excerpt, not just a cut boundary), while an adjacent
    # high+low surrogate sequence is a VALID UTF-16 pair that toWellFormed
    # keeps - represented in Python by combining it into the astral code
    # point it encodes (the same UTF-16 sequence, so downstream code-unit
    # accounting and JSON serialization match the Node reference exactly).
    out: List[str] = []
    i = 0
    n = len(s)
    while i < n:
        cp = ord(s[i])
        if 0xD800 <= cp <= 0xDBFF:
            if i + 1 < n and 0xDC00 <= ord(s[i + 1]) <= 0xDFFF:
                out.append(chr(0x10000 + ((cp - 0xD800) << 10) + (ord(s[i + 1]) - 0xDC00)))
                i += 2
                continue
            out.append("�")
            i += 1
            continue
        if 0xDC00 <= cp <= 0xDFFF:
            out.append("�")
            i += 1
            continue
        out.append(s[i])
        i += 1
    return "".join(out)


def _trim_excerpt(content: str) -> str:
    # Node: `trimmed.toWellFormed()` on the short path, and
    # `trimmed.slice(0, MAX).toWellFormed() + "…"` on the long path - the
    # repair applies to the ENTIRE retained excerpt in both cases, not just a
    # pair straddling the cut.
    trimmed = content.strip(_JS_TRIM_CHARS)
    if _js_utf16_length(trimmed) <= MAX_EXCERPT_LENGTH:
        return _to_well_formed(trimmed)
    return _to_well_formed(_js_utf16_slice_wellformed(trimmed, MAX_EXCERPT_LENGTH)) + "…"


# `git grep -z -n` emits `path\0line\0content\n`. NUL framing makes the filename
# unambiguous even when it contains colon-number segments or newlines.
def _parse_grep_lines(
    stdout: str, terms: List[str], revision: Optional[str] = None
) -> Dict[str, List[Dict[str, Any]]]:
    by_file: Dict[str, List[Dict[str, Any]]] = {}
    cursor = 0
    while cursor < len(stdout):
        path_end = stdout.find("\0", cursor)
        if path_end < 0:
            break
        line_end = stdout.find("\0", path_end + 1)
        if line_end < 0:
            break
        record_end = stdout.find("\n", line_end + 1)
        if record_end < 0:
            record_end = len(stdout)

        file_path = stdout[cursor:path_end]
        if revision is not None and file_path.startswith(f"{revision}:"):
            file_path = file_path[len(revision) + 1 :]
        line_no_str = stdout[path_end + 1 : line_end]
        content = stdout[line_end + 1 : record_end]
        cursor = record_end + 1
        if not file_path or not line_no_str.isdigit():
            continue

        lower = content.lower()
        term = next(
            (term for term in terms if term.lower() in lower),
            terms[0] if terms else None,
        )
        by_file.setdefault(file_path, []).append(
            {
                "path": file_path,
                "line": int(line_no_str),
                "rawContent": content,
                "term": term,
            }
        )
    return by_file


def _bound_matches(
    by_file: Dict[str, List[Dict[str, Any]]],
    evidence: Dict[str, Any],
) -> Dict[str, Any]:
    # Bound and validate parsed matches before they enter the governed source.
    # Unsafe Git-legal names are counted without being disclosed.
    safe_files = [
        path for path in by_file if is_safe_checkout_relative_path(path)
    ]
    unsafe_file_count = len(by_file) - len(safe_files)
    sorted_files = sorted(safe_files, key=utf16_sort_key)
    included_files = sorted_files[:MAX_FILES_PER_CHECKOUT]
    omitted_files = sorted_files[MAX_FILES_PER_CHECKOUT:]

    matches: List[Dict[str, Any]] = []
    omissions: List[Dict[str, Any]] = []
    for file_path in included_files:
        lines = sorted(by_file[file_path], key=lambda entry: entry["line"])
        included_lines = lines[:MAX_MATCHES_PER_FILE]
        for entry in included_lines:
            matches.append(
                {
                    "path": entry["path"],
                    "line": entry["line"],
                    "excerpt": _trim_excerpt(entry["rawContent"]),
                    "term": entry["term"],
                    "evidence": evidence,
                }
            )
        if len(lines) > MAX_MATCHES_PER_FILE:
            omissions.append(
                {
                    "kind": "content_lines_truncated",
                    "path": file_path,
                    "omitted_count": len(lines) - MAX_MATCHES_PER_FILE,
                    "reason": (
                        "matched-line listing capped at "
                        f"{MAX_MATCHES_PER_FILE} per file"
                    ),
                }
            )
    omitted_file_count = len(omitted_files) + unsafe_file_count
    if omitted_file_count:
        omissions.append(
            {
                "kind": "content_files_truncated",
                "omitted_count": omitted_file_count,
                "total_files_matched": len(by_file),
                "reason": (
                    "unsafe matched paths excluded and matched-file listing "
                    f"capped at {MAX_FILES_PER_CHECKOUT} files per checkout"
                    if unsafe_file_count
                    else (
                        "matched-file listing capped at "
                        f"{MAX_FILES_PER_CHECKOUT} files per checkout"
                    )
                ),
            }
        )
    return {"matches": matches, "omissions": omissions}




def _observe_one_content(raw_path: str, terms: List[str], run_git: RunGit) -> Dict[str, Any]:
    path = normalize_path(raw_path)

    if len(terms) == 0:
        # `head_revision` is deliberately None here rather than looked up: with no
        # terms there is no search and no match to bind, and this branch's contract
        # is that it runs *no* git command at all.
        return {
            "raw_path": raw_path,
            "path": path,
            "status": "observed",
            "head_revision": None,
            "matches": [],
            "omissions": [],
            "reason": "no_question_terms",
        }
    revision_result = run_git(path, ["rev-parse", "HEAD"])
    revision = (
        revision_result["stdout"].strip()
        if revision_result.get("ok") and revision_result["stdout"].strip()
        else None
    )
    if revision is None:
        return {
            "raw_path": raw_path,
            "path": path,
            "status": "unknown",
            "reason": "grep_unavailable",
            "matches": [],
            "omissions": [],
            "evidence": {"command": revision_result["command"]},
        }
    privacy_fingerprint, ignored, privacy_command = _content_privacy_policy(
        path,
        revision,
        run_git,
    )
    if privacy_fingerprint is None or ignored is None:
        return {
            "raw_path": raw_path,
            "path": path,
            "status": "unknown",
            "reason": "ignore_policy_unavailable",
            "matches": [],
            "omissions": [],
            "evidence": {"command": privacy_command},
        }


    # `-F`: question terms are literal text, not patterns. `git grep -h` documents
    # `-G` (basic regular expressions) as the default, so without this a term like
    # `foo.bar` matched `fooXbar`, and `.*` made nearly every tracked line look
    # relevant to the question — silently widening what the capsule claims as
    # evidence. Regex terms are not an advertised part of this API.
    args = ["grep", "-z", "-n", "-I", "-i", "-F"]
    for term in terms:
        args += ["-e", term]
    args += [revision, "--"]
    result = run_git(path, args)

    if not result["ok"]:
        return {
            "raw_path": raw_path,
            "path": path,
            "status": "unknown",
            "reason": "grep_unavailable",
            "matches": [],
            "omissions": [],
            "evidence": {"command": result["command"]},
        }
    confirmed_fingerprint, confirmed_ignored, confirmed_command = (
        _content_privacy_policy(
            path,
            revision,
            run_git,
        )
    )
    if (
        confirmed_fingerprint is None
        or confirmed_ignored is None
        or confirmed_fingerprint != privacy_fingerprint
        or confirmed_ignored != ignored
    ):
        return {
            "raw_path": raw_path,
            "path": path,
            "status": "unknown",
            "reason": "ignore_policy_unavailable",
            "matches": [],
            "omissions": [],
            "evidence": {"command": confirmed_command},
        }


    by_file = _parse_grep_lines(result["stdout"], terms, revision)

    ignored_count = 0
    for file_path in list(by_file):
        if normalize_path(file_path) in ignored:
            ignored_count += len(by_file.pop(file_path))

    bounded = _bound_matches(by_file, {"command": result["command"]})
    if ignored_count:
        bounded["omissions"].append(
            {
                "kind": "privacy_matches_excluded",
                "omitted_count": ignored_count,
                "reason": "repository ignore policy excluded tracked content",
                "evidence": {"command": privacy_command},
            }
        )
    return {
        "raw_path": raw_path,
        "path": path,
        "status": "observed",
        "head_revision": revision,
        "privacy_fingerprint": privacy_fingerprint,
        "matches": bounded["matches"],
        "omissions": bounded["omissions"],
    }


def _default_clock() -> str:
    # JS `new Date().toISOString()`: "YYYY-MM-DDTHH:MM:SS.mmmZ" (milliseconds,
    # 3 digits, UTC, trailing Z).
    dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def observe_content(
    paths: List[str],
    *,
    allowlist: Optional[List[str]] = None,
    terms: Optional[List[Any]] = None,
    now: Optional[Callable[[], str]] = None,
    run_git: Optional[RunGit] = None,
    cancelled: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    """Bounded, read-only tracked-file content search over explicit checkout
    roots. Mirrors observe_checkouts' shape: injectable `run_git`, mandatory
    explicit allowlist, structured never-thrown unknown/degraded outcomes,
    and every match/omission carries its exact evidence command.

    :param paths: checkout roots to search
    :param allowlist: explicit allowed roots; a path outside every allowlist
        entry is refused without running git.
    :param terms: question terms to search for; empty/absent -> no search is
        run and every checkout reports `no_question_terms`.
    :param now: injectable clock for determinism.
    :param run_git: injectable git runner; failed results must include the
        numeric `code`, because privacy checks fail closed when it is absent.
    """
    if run_git is None:
        worktree_config: Dict[str, Dict[str, str]] = {}

        def run_default(
            path: str,
            args: List[str],
            *,
            stdin_data: Optional[bytes] = None,
        ) -> Dict[str, Any]:
            key = normalize_path(path)
            if key not in worktree_config:
                worktree_config[key] = _worktree_semantic_config(
                    path,
                    cancelled=cancelled,
                )
            return _default_run_git(
                path,
                args,
                worktree_config=worktree_config[key],
                stdin_data=stdin_data,
                cancelled=cancelled,
            )

        run_git = run_default
    if not isinstance(allowlist, (list, tuple)) or len(allowlist) == 0:
        raise ValueError("observeContent requires an explicit non-empty allowlist of repository roots")
    # #71: reject a bad allowlist ENTRY (empty, whitespace-only, or not an
    # absolute path) at construction time - see workspace_observe.py's
    # identical guard for the full rationale. An empty-string entry would
    # otherwise act as a silent wildcard inside is_within.
    bad_entry_index = next(
        (
            i
            for i, root in enumerate(allowlist)
            if not is_canonical_absolute_path(normalize_path(root))
        ),
        None,
    )
    if bad_entry_index is not None:
        raise ValueError(
            "observeContent requires every allowlist entry to be a non-empty absolute path "
            f"(entry {bad_entry_index}: {json.dumps(allowlist[bad_entry_index])})"
        )

    clock = now if now is not None else _default_clock
    search_terms = _dedupe_terms(terms)
    checkouts: List[Dict[str, Any]] = []
    refusals: List[Dict[str, Any]] = []
    seen_paths = set()

    for raw_path in paths:
        path_key = path_identity_key(raw_path)
        if path_key in seen_paths:
            continue
        seen_paths.add(path_key)
        if (
            not is_canonical_absolute_path(normalize_path(raw_path))
            or not any(
                is_within_allowlist(root, raw_path)
                for root in allowlist
            )
        ):
            refusals.append(
                {
                    "raw_path": raw_path,
                    "path": normalize_path(raw_path),
                    "status": "refused",
                    "reason": "outside_allowlist",
                }
            )
            continue

        # #67: post-resolution re-check, mirroring workspace_observe.py, but
        # done BEFORE grep so a foreign repository's file CONTENT is never
        # read (content.mjs's exposure is worse than observe.mjs's - a
        # symlinked descendant leaks matched file text, not just metadata).
        # The fast lexical pre-grep refusal above stays first-line (is_within
        # stays pure, never touches disk). A raw path admitted only as a
        # DESCENDANT of an allowlisted directory can still be a
        # symlink/junction resolving elsewhere; resolve the real toplevel
        # (git `--show-toplevel` follows links) and refuse if it escaped. An
        # EXACT allowlist entry is exempt (operator's own trust decision),
        # identical to workspace_observe.py.
        path = normalize_path(raw_path)
        trusted_exactly = any(
            path_identity_key(root) == path_identity_key(path)
            for root in allowlist
        )
        if not trusted_exactly:
            toplevel = run_git(raw_path, ["rev-parse", "--show-toplevel"])
            if toplevel["ok"]:
                resolved = normalize_path(toplevel["stdout"].strip())
                if not any(is_within_allowlist(root, resolved) for root in allowlist):
                    refusals.append(
                        {"raw_path": raw_path, "path": path, "status": "refused", "reason": "resolved_outside_allowlist"}
                    )
                    continue
            # If `--show-toplevel` fails, the path is not a resolvable repo;
            # fall through - _observe_one_content's grep on a non-repo is a
            # structured unknown, never foreign content.

        checkouts.append(_observe_one_content(raw_path, search_terms, run_git))

    return {
        "schema": CONTENT_SCHEMA,
        "observed_at": clock(),
        "terms": search_terms,
        "allowlist": sorted((normalize_path(root) for root in allowlist), key=utf16_sort_key),
        "checkouts": checkouts,
        "refusals": refusals,
    }
