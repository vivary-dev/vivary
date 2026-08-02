"""Scope model for Exo claims (ticket #8).

Reference-guided Python port of src/control/scope.mjs (graduation slice 5,
decision 0008). A scope is a project plus a set of paths within it,
mirroring the project isolation the ContextIntegrityEvent contract already
enforces (docs/ARCHITECTURE.md invariant 8: "cross-project and
private-to-public writes fail closed") and the path-prefix containment
vivary_core.canonical already defines for workspace observation. Pure,
synchronous, no I/O.

Language mapping: JS `[...new Set(paths.map(normalizePath))].sort()` uses
JS's default string `.sort()` (UTF-16 code-unit order) - mapped to
``canonical.utf16_sort_key`` per the pinned rule (plain string `.sort()`,
never ``collation.locale_sort_key``).

ADAPTATION - lexical scope identity: scope paths collapse separators and dot
segments against their own anchors. This closes equivalent-spelling claim
collisions that the frozen Node normalizer leaves distinct.

ADAPTATION - Windows scope identity: drive-qualified and UNC paths are folded
case-insensitively on every host so persisted claim-ledger decisions stay
deterministic and cannot grant overlapping Windows scopes on Linux CI.

ADAPTATION - Win32 device namespaces: extended-length drive paths collapse
to their drive anchor, and extended-length UNC paths collapse to their UNC
anchor. Long-path-aware tools therefore cannot claim the same tree under a
second lexical identity.
"""

from __future__ import annotations

import re
import unicodedata

from vivary_core.canonical import _JS_TRIM_CHARS, utf16_sort_key


_DRIVE_PREFIX = re.compile(r"^[A-Za-z]:")

def _fold_windows(value):
    return unicodedata.normalize("NFC", value.casefold())


def _collapse_segments(segments):
    collapsed = []
    for segment in segments:
        if segment == "" or segment == ".":
            continue
        if segment == "..":
            if collapsed:
                collapsed.pop()
            continue
        collapsed.append(segment)
    return collapsed


def _normalize_scope_path(path):
    raw_path = str(path).strip(_JS_TRIM_CHARS).replace("\\", "/")
    if _DRIVE_PREFIX.match(raw_path):
        drive = _fold_windows(raw_path[:2])
        remainder = raw_path[2:]
        if remainder.startswith("/"):
            segments = [
                _fold_windows(segment)
                for segment in _collapse_segments(remainder.split("/"))
            ]
            return drive + ("/" + "/".join(segments) if segments else "/")
        return drive + "/".join(
            _fold_windows(segment)
            for segment in _collapse_segments(remainder.split("/"))
        )

    if raw_path.startswith("//"):
        unc_parts = [segment for segment in raw_path.split("/") if segment]
        if len(unc_parts) >= 2 and unc_parts[0] in ("?", "."):
            device_parts = unc_parts[1:]
            if _DRIVE_PREFIX.match(device_parts[0]):
                device_path = "/".join(device_parts)
                return _normalize_scope_path(device_path + "/" if len(device_path) == 2 else device_path)
            if _fold_windows(device_parts[0]) == "unc" and len(device_parts) >= 3:
                return _normalize_scope_path("//" + "/".join(device_parts[1:]))
        if len(unc_parts) >= 2:
            anchor = [
                _fold_windows(unc_parts[0]),
                _fold_windows(unc_parts[1]),
            ]
            segments = [
                _fold_windows(segment)
                for segment in _collapse_segments(unc_parts[2:])
            ]
            return "//" + "/".join([*anchor, *segments])

    if raw_path.startswith("/"):
        segments = _collapse_segments(raw_path.split("/"))
        return "/" + "/".join(segments) if segments else "/"

    segments = _collapse_segments(raw_path.split("/"))
    return "/".join(segments) if segments else "."


def _scope_path_parts(path):
    if _DRIVE_PREFIX.match(path):
        remainder = path[2:]
        if remainder.startswith("/"):
            return "drive_absolute", path[:2], tuple(segment for segment in remainder.split("/") if segment)
        return "drive_relative", path[:2], tuple(segment for segment in remainder.split("/") if segment)
    if path.startswith("//"):
        segments = path[2:].split("/")
        return "unc", tuple(segments[:2]), tuple(segments[2:])
    if path.startswith("/"):
        return "posix", "/", tuple(segment for segment in path[1:].split("/") if segment)
    return "relative", "", () if path == "." else tuple(path.split("/"))


def _path_contains(root, child):
    root_kind, root_anchor, root_segments = _scope_path_parts(root)
    child_kind, child_anchor, child_segments = _scope_path_parts(child)
    return (
        root_kind == child_kind
        and root_anchor == child_anchor
        and child_segments[: len(root_segments)] == root_segments
    )


def _is_valid_scope(scope):
    return (
        bool(scope)
        and isinstance(scope, dict)
        and isinstance(scope.get("project"), str)
        and isinstance(scope.get("paths"), list)
    )


def normalize_scope(scope):
    """@param scope {project, paths}
    @returns a new scope dict with normalized, sorted, de-duplicated paths
    """
    scope = scope if isinstance(scope, dict) else {}
    raw_paths = scope.get("paths") or []
    deduped = list(dict.fromkeys(_normalize_scope_path(p) for p in raw_paths))
    paths = sorted(deduped, key=utf16_sort_key)
    project = scope.get("project")
    return {"project": project if project is not None else "", "paths": paths}


def _scope_path_key(path):
    kind, anchor, segments = _scope_path_parts(path)
    return kind, anchor, segments

def _scope_path_entries(scopes):
    entries = []
    for scope_index, scope in enumerate(scopes):
        normalized = normalize_scope(scope)
        for path in normalized["paths"]:
            path_key = _scope_path_key(path)
            entries.append(
                (
                    len(path_key[2]),
                    normalized["project"],
                    path_key,
                    scope_index,
                )
            )
    entries.sort(key=lambda entry: entry[0])
    return entries


def _scope_conflict_indices(scopes, target_index):
    """Return scopes overlapping one target in total path-depth work."""
    owners_by_path = {}
    conflicts = set()
    for _, project, path_key, scope_index in _scope_path_entries(scopes):
        kind, anchor, segments = path_key
        for prefix_length in range(len(segments) + 1):
            owners = owners_by_path.get(
                (project, kind, anchor, segments[:prefix_length])
            )
            if owners is None:
                continue
            if scope_index == target_index:
                conflicts.update(
                    owner for owner in owners if owner != target_index
                )
            elif target_index in owners:
                conflicts.add(scope_index)
        owners_by_path.setdefault(
            (project, kind, anchor, segments),
            set(),
        ).add(scope_index)
    return conflicts


def _path_key_has_prefix(path_key, candidates):
    kind, anchor, segments = path_key
    return any(
        (kind, anchor, segments[:prefix_length]) in candidates
        for prefix_length in range(len(segments) + 1)
    )


def scopes_overlap(a, b):
    """Return whether two normalized project scopes contain intersecting paths."""
    scope_a = normalize_scope(a)
    scope_b = normalize_scope(b)
    if scope_a["project"] != scope_b["project"]:
        return False

    paths_a = {_scope_path_key(path) for path in scope_a["paths"]}
    paths_b = {_scope_path_key(path) for path in scope_b["paths"]}
    return any(_path_key_has_prefix(path, paths_a) for path in paths_b) or any(
        _path_key_has_prefix(path, paths_b) for path in paths_a
    )


def _scopes_are_pairwise_disjoint(scopes):
    """Check cross-scope overlap in total path-depth work, not a Cartesian join."""
    owners_by_path = {}
    for _, project, path_key, scope_index in _scope_path_entries(scopes):
        kind, anchor, segments = path_key
        for prefix_length in range(len(segments) + 1):
            owners = owners_by_path.get(
                (project, kind, anchor, segments[:prefix_length])
            )
            if owners is not None and any(
                owner != scope_index for owner in owners
            ):
                return False
        owners_by_path.setdefault(
            (project, kind, anchor, segments),
            set(),
        ).add(scope_index)
    return True
