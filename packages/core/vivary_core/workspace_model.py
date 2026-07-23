"""Pure projection: workspace observations -> typed evidence graph.

Reference-guided Python port of src/workspace/model.mjs (slice 2, ticket #84,
decision 0008). The Node module is the frozen executable oracle: no I/O here,
and the same observation input must always yield a byte-identical projection
(nodes, edges, conflicts, unknowns, and workspace fingerprint). Ambiguity is
preserved as data (conflicts + unknowns), never resolved here - do not
"improve" that.

Language-mapping notes (python/README.md):
- JS ``undefined`` == absent dict key; ``a?.b ?? c`` is replicated with
  explicit ``is None`` checks (see ``_fact_field``), never a Python truthy
  ``or``.
- Every ``.sort((a, b) => a.x.localeCompare(b.x))`` site uses
  ``vivary_core.collation.locale_sort_key`` on the same key.
- The one *plain* ``.sort()`` with no comparator in this module (the
  ``[...byRepository.entries()].sort()`` walk) is JS UTF-16 code-unit order,
  not locale order - reproduced with ``vivary_core.canonical._utf16_sort_key``
  on the repository id (the unique map key that alone determines the JS
  default array-of-pairs sort order here; see the inline comment at its call
  site for why that reduction is exact, not an approximation).
- All node/edge ids flow through ``deterministic_id``/``fingerprint`` from
  vivary_core.canonical, never reimplemented here.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from vivary_core.canonical import (
    _utf16_sort_key,
    deterministic_id,
    fingerprint,
    normalize_path,
)
from vivary_core.collation import locale_sort_key

GRAPH_SCHEMA = "vivary.workspace-graph/v0"

# Cardinality cap for neighbor_of edges (#68/#63): every pair of checkouts
# sharing one repository identity used to get a neighbor_of edge, unbounded -
# C(k,2) edges for a group of k, e.g. 2,007,000 edges / ~22s at k=2000. Only
# the first MAX_NEIGHBOR_OF_GROUP checkouts (sorted by checkout id, so the
# choice is deterministic regardless of observation order) in a same-origin
# group get pairwise neighbor_of edges; set well above every pinned
# same-origin group size in this repo's tests (10) and far below the
# measured quadratic blow-up, so ordinary workspaces are entirely
# unaffected. Conflict detection (heads/sides) always sees the full group -
# this cap touches only the redundant neighbor_of edges (the same "shared
# origin" fact already lives on the checkout_of -> repository edges every
# checkout in the group carries), never conflict-side preservation.
MAX_NEIGHBOR_OF_GROUP = 300


def _fact_field(facts: Dict[str, Any], name: str, field: str) -> Any:
    # Replicates `facts.name?.field ?? null`: an absent fact, or a present
    # fact missing that field, both yield None - never a KeyError/AttributeError.
    detail = facts.get(name)
    if detail is None:
        return None
    return detail.get(field)


def _checkout_core_facts(checkout: Dict[str, Any]) -> Dict[str, Any]:
    f = checkout["facts"]
    dirty_entries = _fact_field(f, "dirty_entries", "value")
    if dirty_entries is None:
        dirty_entries = []
    # `.map((e) => e.path).sort()` - plain sort, UTF-16 code-unit order.
    dirty_paths = sorted((e["path"] for e in dirty_entries), key=_utf16_sort_key)
    remotes = _fact_field(f, "remotes", "value")
    if remotes is None:
        remotes = []
    return {
        "path": checkout["path"],
        "head_revision": _fact_field(f, "head_revision", "value"),
        "head_ref": _fact_field(f, "head_ref", "value"),
        "is_dirty": _fact_field(f, "is_dirty", "value"),
        "dirty_paths": dirty_paths,
        "remotes": remotes,
    }


def _repository_identity(checkout: Dict[str, Any]) -> Dict[str, Any]:
    # Repository identity: the origin fetch URL when one is known, otherwise
    # the checkout path itself with identity_status "inferred" - a
    # local-only repo has no proven identity beyond its own worktree.
    remotes = checkout["facts"].get("remotes")
    if remotes is not None and remotes.get("status") == "known":
        values = remotes.get("value") or []
        origin = next((r for r in values if r.get("name") == "origin"), None)
        if origin is None and values:
            origin = values[0]
        if origin is not None and origin.get("fetch_url"):
            return {
                "identity": origin["fetch_url"],
                "identity_status": "known",
                "evidence": remotes.get("evidence"),
            }
    return {
        "identity": f"local:{checkout['path']}",
        "identity_status": "inferred" if (remotes is not None and remotes.get("status") == "known") else "unknown",
        "evidence": remotes.get("evidence") if remotes is not None else None,
    }


def project_workspace_graph(observation: Dict[str, Any]) -> Dict[str, Any]:
    nodes: Dict[str, Any] = {}
    edges: Dict[str, Any] = {}
    unknowns: List[Dict[str, Any]] = []
    by_repository: Dict[str, List[Dict[str, Any]]] = {}

    def add_node(node: Dict[str, Any]) -> Dict[str, Any]:
        if node["id"] not in nodes:
            nodes[node["id"]] = node
        return nodes[node["id"]]

    def add_edge(kind: str, from_: str, to: str, evidence: Optional[Any]) -> None:
        edge_id = deterministic_id("edge", {"kind": kind, "from": from_, "to": to})
        if edge_id not in edges:
            edges[edge_id] = {"id": edge_id, "kind": kind, "from": from_, "to": to, "evidence": evidence}

    for checkout in observation["checkouts"]:
        checkout_id = deterministic_id("checkout", {"path": checkout["path"]})

        for fact, detail in checkout["facts"].items():
            if detail.get("status") == "unknown":
                unknowns.append(
                    {"checkout": checkout_id, "path": checkout["path"], "fact": fact, "reason": detail.get("reason")}
                )

        if _fact_field(checkout["facts"], "is_git_repository", "value") is not True:
            is_git_repository = checkout["facts"].get("is_git_repository")
            add_node(
                {
                    "id": checkout_id,
                    "kind": "checkout",
                    "label": checkout["path"].split("/")[-1],
                    "path": checkout["path"],
                    "facts": {"is_git_repository": is_git_repository if is_git_repository is not None else None},
                }
            )
            continue

        add_node(
            {
                "id": checkout_id,
                "kind": "checkout",
                "label": checkout["path"].split("/")[-1],
                "path": checkout["path"],
                "facts": checkout["facts"],
            }
        )

        repo = _repository_identity(checkout)
        repository_id = deterministic_id("repository", {"identity": repo["identity"]})
        add_node(
            {
                "id": repository_id,
                "kind": "repository",
                "identity": repo["identity"],
                "identity_status": repo["identity_status"],
            }
        )
        add_edge("checkout_of", checkout_id, repository_id, repo["evidence"])
        group = by_repository.setdefault(repository_id, [])
        group.append({"checkoutId": checkout_id, "checkout": checkout})

        head = checkout["facts"].get("head_revision")
        if head is not None and head.get("status") == "known":
            revision_id = deterministic_id("revision", {"sha": head["value"]})
            add_node({"id": revision_id, "kind": "revision", "sha": head["value"]})
            add_edge("at_revision", checkout_id, revision_id, head.get("evidence"))

        ref = checkout["facts"].get("head_ref")
        if ref is not None and ref.get("status") == "known" and ref.get("value", {}).get("kind") == "branch":
            branch_id = deterministic_id("branch", {"checkout": checkout["path"], "name": ref["value"]["name"]})
            add_node({"id": branch_id, "kind": "branch", "name": ref["value"]["name"], "checkout": checkout_id})
            add_edge("at_branch", checkout_id, branch_id, ref.get("evidence"))

        remotes = checkout["facts"].get("remotes")
        if remotes is not None and remotes.get("status") == "known":
            for r in remotes["value"]:
                fetch_url = r.get("fetch_url")
                remote_id = deterministic_id(
                    "remote", {"checkout": checkout["path"], "name": r["name"], "url": fetch_url}
                )
                add_node(
                    {
                        "id": remote_id,
                        "kind": "remote",
                        "name": r["name"],
                        "fetch_url": fetch_url,
                        "checkout": checkout_id,
                    }
                )
                add_edge("tracks_remote", checkout_id, remote_id, remotes.get("evidence"))

        dirty = checkout["facts"].get("dirty_entries")
        if dirty is not None and dirty.get("status") == "known":
            for entry in dirty["value"]:
                artifact_id = deterministic_id("artifact", {"checkout": checkout["path"], "path": entry["path"]})
                add_node(
                    {
                        "id": artifact_id,
                        "kind": "dirty_artifact",
                        "path": entry["path"],
                        "state": entry["state"],
                        "checkout": checkout_id,
                    }
                )
                add_edge("dirty_artifact", checkout_id, artifact_id, dirty.get("evidence"))

    # Conflicts: checkouts sharing one repository identity but disagreeing
    # about HEAD. Both sides are preserved with their evidence; no winner is
    # chosen.
    conflicts: List[Dict[str, Any]] = []
    cap_notices: List[Dict[str, Any]] = []
    # `[...byRepository.entries()].sort()` is a PLAIN sort with no comparator:
    # JS stringifies each [key, group] pair (Array#toString -> join(",") ->
    # "<repositoryId>,[object Object],[object Object],...") and compares by
    # UTF-16 code unit. Map keys are unique and every repositoryId has the
    # same fixed length ("repository_" + 16 hex chars), so no id is ever a
    # prefix of another and the "[object Object]" suffix never needs to be
    # consulted to break a tie - the whole comparison reduces exactly to
    # UTF-16 code-unit order over repositoryId alone.
    for repository_id, group in sorted(by_repository.items(), key=lambda kv: _utf16_sort_key(kv[0])):
        if len(group) < 2:
            continue
        # heads/sides always see the full group - the cap below only bounds
        # the redundant pairwise neighbor_of edges, never conflict-side
        # preservation.
        heads = {
            (_fact_field(entry["checkout"]["facts"], "head_revision", "value") or "unknown") for entry in group
        }
        # ``or "unknown"`` mirrors `?? "unknown"`: only None (JS
        # null/undefined) falls back; a JS-falsy-but-non-null head value
        # never occurs here (head_revision.value is always a non-empty sha
        # string when known).

        # Under the cap, use the group in its original order so a bounded
        # workspace's neighbor_of edges are byte-identical to the pre-#68
        # output (the cap must only ever change behavior when it actually
        # engages). Only when the group exceeds the cap do we sort (for a
        # deterministic choice of which checkouts survive) and slice.
        if len(group) > MAX_NEIGHBOR_OF_GROUP:
            considered_group = sorted(group, key=lambda e: locale_sort_key(e["checkoutId"]))[:MAX_NEIGHBOR_OF_GROUP]
        else:
            considered_group = group

        for i in range(len(considered_group)):
            for j in range(i + 1, len(considered_group)):
                add_edge("neighbor_of", considered_group[i]["checkoutId"], considered_group[j]["checkoutId"], None)

        if len(considered_group) < len(group):
            total_pairs = (len(group) * (len(group) - 1)) // 2
            considered_pairs = (len(considered_group) * (len(considered_group) - 1)) // 2
            cap_notices.append(
                {
                    "kind": "neighbor_of_pairs_capped",
                    "repository": repository_id,
                    "reason": (
                        f"repository has {len(group)} checkouts sharing one origin; pairwise neighbor_of edge "
                        f"generation is capped at {MAX_NEIGHBOR_OF_GROUP} checkouts to stay bounded"
                    ),
                    "considered_checkouts": len(considered_group),
                    "total_checkouts": len(group),
                    "omitted_checkout_count": len(group) - len(considered_group),
                    "omitted_pair_count": total_pairs - considered_pairs,
                }
            )

        if len(heads) > 1:
            sides = sorted(
                (
                    {
                        "checkout": entry["checkoutId"],
                        "path": entry["checkout"]["path"],
                        "head_revision": _fact_field(entry["checkout"]["facts"], "head_revision", "value"),
                        "head_ref": _fact_field(entry["checkout"]["facts"], "head_ref", "value"),
                        "last_fetch": (
                            entry["checkout"]["facts"]["last_fetch"]["value"]
                            if entry["checkout"]["facts"].get("last_fetch", {}).get("status") == "known"
                            else None
                        ),
                        "evidence": _fact_field(entry["checkout"]["facts"], "head_revision", "evidence"),
                    }
                    for entry in group
                ),
                key=lambda s: locale_sort_key(s["path"]),
            )
            conflicts.append(
                {
                    "id": deterministic_id(
                        "conflict", {"repository": repository_id, "sides": [s["checkout"] for s in sides]}
                    ),
                    "kind": "divergent_checkouts",
                    "repository": repository_id,
                    "question": "Which checkout reflects current repository truth?",
                    "sides": sides,
                    "status": "unresolved",
                    "reason_codes": ["value_conflict", "identity_unresolved"],
                }
            )

    sorted_nodes = sorted(nodes.values(), key=lambda n: locale_sort_key(n["id"]))
    sorted_edges = sorted(edges.values(), key=lambda e: locale_sort_key(e["id"]))
    core_facts = sorted(
        (_checkout_core_facts(c) for c in observation["checkouts"]), key=lambda c: locale_sort_key(c["path"])
    )
    workspace_fingerprint = fingerprint(core_facts)

    refusals = observation.get("refusals")
    if refusals is None:
        refusals = []

    result: Dict[str, Any] = {
        "schema": GRAPH_SCHEMA,
        "observed_at": observation["observed_at"],
        "allowlist": [normalize_path(p) for p in observation["allowlist"]],
        "workspace_fingerprint": workspace_fingerprint,
        "nodes": sorted_nodes,
        "edges": sorted_edges,
        "conflicts": conflicts,
        "unknowns": sorted(unknowns, key=lambda u: locale_sort_key(f"{u['path']}:{u['fact']}")),
        # Only the normalized path crosses into the graph; the caller's raw
        # input string stays in the observation layer.
        "refusals": [{"path": r["path"], "status": r["status"], "reason": r["reason"]} for r in refusals],
    }
    # Only present when the neighbor_of cardinality cap actually engaged, so
    # an ordinary (uncapped) graph stays byte-identical to before #68 - no
    # shape change at small/normal scale.
    if cap_notices:
        result["omissions"] = cap_notices
    return result
