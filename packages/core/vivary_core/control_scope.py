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
``canonical._utf16_sort_key`` per the pinned rule (plain string `.sort()`,
never ``collation.locale_sort_key``).
"""

from __future__ import annotations

from vivary_core.canonical import _utf16_sort_key, is_within, normalize_path


def normalize_scope(scope):
    """@param scope {project, paths}
    @returns a new scope dict with normalized, sorted, de-duplicated paths
    """
    raw_paths = (scope or {}).get("paths") or []
    deduped = list(dict.fromkeys(normalize_path(p) for p in raw_paths))
    paths = sorted(deduped, key=_utf16_sort_key)
    project = (scope or {}).get("project")
    return {"project": project if project is not None else "", "paths": paths}


def scopes_overlap(a, b):
    """True when two scopes could collide: same project, and at least one
    path in either scope equals or nests inside a path in the other. Scopes
    in different projects never overlap - project isolation is absolute.

    @param a {project, paths}
    @param b {project, paths}
    """
    scope_a = normalize_scope(a)
    scope_b = normalize_scope(b)
    if scope_a["project"] != scope_b["project"]:
        return False

    for path_a in scope_a["paths"]:
        for path_b in scope_b["paths"]:
            if is_within(path_a, path_b) or is_within(path_b, path_a):
                return True
    return False
