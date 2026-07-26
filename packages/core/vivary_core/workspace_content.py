"""Read-only tracked-file content search. The second impure workspace module
(alongside workspace_observe.py): it may run one read-only `git grep` per
checkout and nothing else. It never touches the index, never writes, and
only ever searches the explicit allowlisted roots it is handed - same
discipline as workspace_observe.py, mirrored deliberately.

`git grep` (no --no-index, no --untracked) searches tracked files in the
working tree only: untracked and git-ignored paths are structurally
invisible to it, so this module can never surface either, by construction -
not by a filter applied after the fact. See python/tests/test_content.py.

Reference-guided Python port of src/workspace/content.mjs (slice 2, ticket
#84, decision 0008). The Node module is the frozen executable oracle.

Language-mapping notes (python/README.md):
- Node's async is an I/O style, not a contract (see evidence_sync.py's same
  note): this module is synchronous, calling the injectable ``run_git``
  callable directly rather than awaiting it.
- ``sortedFiles = [...byFile.keys()].sort()`` and the final
  ``allowlist.map(normalizePath).sort()`` are both PLAIN sorts with no
  comparator - JS UTF-16 code-unit order, not locale order - reproduced with
  ``vivary_core.canonical._utf16_sort_key``.
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
import subprocess
import re
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from vivary_core.canonical import (
    _JS_TRIM_CHARS,
    _utf16_sort_key,
    is_absolute_root,
    is_within,
    is_within_allowlist,
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

# Ambient git-discovery env vars must never override the explicit -C target:
# this tool always names its repository root directly, so honoring an
# inherited GIT_DIR/GIT_WORK_TREE/etc. would let an environment variable
# silently redirect a search to a different repository than the one the
# caller (and the allowlist check) actually asked about.
_AMBIENT_GIT_ENV_KEYS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]

RunGit = Callable[[str, List[str]], Dict[str, Any]]


def _sanitized_git_env() -> Dict[str, str]:
    env = dict(os.environ)
    for key in _AMBIENT_GIT_ENV_KEYS:
        env.pop(key, None)
    return env


def _default_run_git(checkout_path: str, args: List[str]) -> Dict[str, Any]:
    full_args = ["--no-optional-locks", "-C", checkout_path, *args]
    command = "git " + " ".join(full_args)
    try:
        proc = subprocess.run(["git", *full_args], capture_output=True, env=_sanitized_git_env())
    except OSError as error:
        return {"ok": False, "stdout": "", "stderr": str(error)[:400], "command": command}

    stdout_bytes = proc.stdout or b""
    stderr_bytes = proc.stderr or b""

    if len(stdout_bytes) > _MAX_GIT_OUTPUT_BYTES:
        return {"ok": False, "stdout": "", "stderr": "stdout maxBuffer length exceeded"[:400], "command": command}

    if proc.returncode != 0:
        # `git grep` exits 1 to mean "no matches" - that is a successful
        # search, not a failure, and must never be reported as one.
        if proc.returncode == 1 and not stdout_bytes and not stderr_bytes:
            return {"ok": True, "stdout": "", "command": command}
        stderr_text = stderr_bytes.decode("utf-8", errors="replace")
        return {"ok": False, "stdout": "", "stderr": stderr_text[:400], "command": command}

    stdout_text = stdout_bytes.decode("utf-8", errors="replace").replace("\r\n", "\n")
    return {"ok": True, "stdout": stdout_text, "command": command}


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


# One output line from `git grep -n -I -i -e term1 [-e term2 ...]` is
# "relPath:lineNo:content". Content itself may contain colons, so the split
# is non-greedy on the path and numeric on the line number.
_GREP_LINE = re.compile(r"^(.+?):(\d+):(.*)$", re.DOTALL)


def _parse_grep_lines(stdout: str, terms: List[str]) -> Dict[str, List[Dict[str, Any]]]:
    by_file: Dict[str, List[Dict[str, Any]]] = {}
    for line in stdout.split("\n"):
        if not line:
            continue
        match = _GREP_LINE.match(line)
        if match is None:
            continue
        file_path, line_no_str, content = match.group(1), match.group(2), match.group(3)
        lower = content.lower()
        # Deterministic term attribution: the first term (in caller-given
        # order) that actually appears in the matched line, never a guess.
        term = next((t for t in terms if t.lower() in lower), terms[0] if terms else None)
        by_file.setdefault(file_path, []).append(
            {"path": file_path, "line": int(line_no_str), "rawContent": content, "term": term}
        )
    return by_file


def _bound_matches(by_file: Dict[str, List[Dict[str, Any]]], evidence: Dict[str, Any]) -> Dict[str, Any]:
    # Bound the parsed matches: at most MAX_FILES_PER_CHECKOUT files (sorted
    # by path for determinism), at most MAX_MATCHES_PER_FILE lines per
    # included file (sorted by line number), excerpts capped to
    # MAX_EXCERPT_LENGTH. Everything a cap removes is recorded as a
    # structured omission - never silently dropped.
    sorted_files = sorted(by_file.keys(), key=_utf16_sort_key)
    included_files = sorted_files[:MAX_FILES_PER_CHECKOUT]
    omitted_files = sorted_files[MAX_FILES_PER_CHECKOUT:]

    matches: List[Dict[str, Any]] = []
    omissions: List[Dict[str, Any]] = []
    for file_path in included_files:
        lines = sorted(by_file[file_path], key=lambda e: e["line"])
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
                    "reason": f"matched-line listing capped at {MAX_MATCHES_PER_FILE} per file",
                }
            )
    if omitted_files:
        omissions.append(
            {
                "kind": "content_files_truncated",
                "omitted_count": len(omitted_files),
                "total_files_matched": len(sorted_files),
                "reason": f"matched-file listing capped at {MAX_FILES_PER_CHECKOUT} files per checkout",
            }
        )
    return {"matches": matches, "omissions": omissions}


def _observe_one_content(raw_path: str, terms: List[str], run_git: RunGit) -> Dict[str, Any]:
    path = normalize_path(raw_path)

    if len(terms) == 0:
        return {
            "raw_path": raw_path,
            "path": path,
            "status": "observed",
            "matches": [],
            "omissions": [],
            "reason": "no_question_terms",
        }

    args = ["grep", "-n", "-I", "-i"]
    for term in terms:
        args += ["-e", term]
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

    by_file = _parse_grep_lines(result["stdout"], terms)
    bounded = _bound_matches(by_file, {"command": result["command"]})
    return {
        "raw_path": raw_path,
        "path": path,
        "status": "observed",
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
    :param run_git: injectable git runner for tests.
    """
    if run_git is None:
        run_git = _default_run_git
    if not isinstance(allowlist, (list, tuple)) or len(allowlist) == 0:
        raise ValueError("observeContent requires an explicit non-empty allowlist of repository roots")
    # #71: reject a bad allowlist ENTRY (empty, whitespace-only, or not an
    # absolute path) at construction time - see workspace_observe.py's
    # identical guard for the full rationale. An empty-string entry would
    # otherwise act as a silent wildcard inside is_within.
    bad_entry_index = next((i for i, root in enumerate(allowlist) if not is_absolute_root(root)), None)
    if bad_entry_index is not None:
        raise ValueError(
            "observeContent requires every allowlist entry to be a non-empty absolute path "
            f"(entry {bad_entry_index}: {json.dumps(allowlist[bad_entry_index])})"
        )

    clock = now if now is not None else _default_clock
    search_terms = _dedupe_terms(terms)
    checkouts: List[Dict[str, Any]] = []
    refusals: List[Dict[str, Any]] = []

    for raw_path in paths:
        if not any(is_within_allowlist(root, raw_path) for root in allowlist):
            refusals.append(
                {"raw_path": raw_path, "path": normalize_path(raw_path), "status": "refused", "reason": "outside_allowlist"}
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
        trusted_exactly = any(normalize_path(root) == path for root in allowlist)
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
        "allowlist": sorted((normalize_path(root) for root in allowlist), key=_utf16_sort_key),
        "checkouts": checkouts,
        "refusals": refusals,
    }
