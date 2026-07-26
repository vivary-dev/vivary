"""Pure near-neighbor write-policy classifier (docs/NEAR-NEIGHBOR-POLICY.md).
No I/O, no writes: classify_candidate(graph, candidate, neighbors) -> decision
is a pure function of its inputs, mirroring the house pattern in the Node
reference's src/router/propose.mjs ("proposals are data that name a write; no
write happens here, ever") and src/event/contract.mjs's machine-readable,
never-throw verdict style.

Reference-guided Python port of src/recall/classify.mjs (graduation slice 6,
ticket #12, decision 0008). The Node module is the frozen executable oracle:
every branch, reason code, and ordering rule below is translated function-for-
function; nothing is redesigned.

ADAPTATION - malformed neighbors: provider-returned entries without a stable
string ``id`` cannot support an auditable related-assertion decision. Reject
that set as ``review_required`` instead of raising or silently classifying a
partial set.

A candidate is the incoming assertion someone (an agent, Bellamente) wants to
record. A neighbor is a *prior* assertion, already known to the caller
(returned by an external recall provider - never fetched, embedded, or
looked up here), that the candidate might duplicate, corroborate, conflict
with, or explicitly correct. Neither a candidate nor a neighbor is truth by
itself: only the graph's own nodes are. A candidate's subject must resolve to
a real, identity-proven graph node before anything else is considered -
"candidates may only reference existing graph nodes by identity."

Scope: this module implements exactly the three outcomes ticket #12 asks for
(see recall_outcomes.py for why identity_unresolved is a reason code, not a
fourth outcome). Matrix rows outside that scope (exact duplicate, brand-new/
no-neighbor claims, cross-project quarantine, etc.) never fabricate one of
the three write outcomes: they return `outcome: None` with a reason code that
says exactly why nothing was decided. The policy doc is explicit that
treating harmless novelty or duplication as review_required floods the
review queue - so `None` here, not noise.

Language mapping (python/README.md's documented rules, applied here):
- JS `a?.b?.c` (optional chaining) is reproduced by `_get_path`, which walks
  a chain of dict lookups and returns the `_MISSING` sentinel the instant any
  link is not a dict or the key is absent - the same short-circuit optional
  chaining gives on `null`/`undefined`. `_MISSING` is distinct from `None`
  (JS `undefined` vs `null`), so `=== `/`!==` comparisons against a
  `_get_path` result stay byte-faithful to the Node reference.
- `x ?? y` is reproduced by treating `_MISSING` and `None` alike (both are
  JS "nullish"), never by falsy-coalescing 0/""/False.
- `Boolean(x)` (used only in `_required_supersession_inputs_present`) is
  reproduced by `_js_truthy`, which mirrors JS falsiness (`None`/`_MISSING`,
  `False`, `0`/`NaN`, `""`) - not Python truthiness.
- `[...new Set(xs)].sort()` (plain, comparator-less `Array#sort` on strings)
  is reproduced with `sorted(set(xs), key=_utf16_sort_key)` -
  `canonical._utf16_sort_key` is the UTF-16-code-unit comparator plain JS
  `.sort()` uses, not `collation.locale_sort_key`.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from vivary_core.canonical import _utf16_sort_key, canonicalize
from vivary_core.recall_outcomes import (
    ACTIVE_TRUTH_NEW_VERSION_ACTIVE,
    ACTIVE_TRUTH_UNCHANGED,
    CORROBORATION_RECORDED,
    REASON_ACTOR_NOT_AUTHORIZED,
    REASON_AUTHORED_TRUTH_PROTECTED,
    REASON_CONFLICTS_WITH,
    REASON_EXACT_DUPLICATE_OUT_OF_SCOPE,
    REASON_EXPLICIT_CORRECTION,
    REASON_IDENTITY_UNRESOLVED,
    REASON_INDEPENDENT_EVIDENCE,
    REASON_NO_SIMILAR_NEIGHBOR,
    REASON_RECALL_PROVIDER_FAILED,
    REASON_SUPERSESSION_INPUTS_INCOMPLETE,
    REASON_SUPERSESSION_SUBJECT_MISMATCH,
    REASON_SUPERSESSION_TARGET_MISSING,
    REVIEW_REQUIRED,
    SUPERSEDED_EXPLICITLY,
)

# Sentinel distinguishing "the chain resolved to undefined" (key absent, or
# some link along the way was not an object) from "the chain resolved to an
# explicit null" - exactly the distinction JS optional chaining preserves.
_MISSING = object()


def _get_path(value: Any, *keys: str) -> Any:
    cur = value
    for key in keys:
        if not isinstance(cur, dict) or key not in cur:
            return _MISSING
        cur = cur[key]
    return cur


def _nullish_to_none(value: Any) -> Any:
    # JS `x ?? null`/`x ?? []`: only nullish (undefined or null) values are
    # replaced - falsy-but-present values (0, "", False) pass through.
    return None if (value is _MISSING or value is None) else value


def _js_truthy(value: Any) -> bool:
    if value is _MISSING or value is None or value is False:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value == value and value != 0  # excludes NaN and 0
    if isinstance(value, str):
        return len(value) > 0
    return True  # dict/list/etc. are always truthy in JS


# A node "resolves" a candidate's subject when it exists in the graph and,
# for node kinds that carry a proven-vs-unproven identity signal (repository
# nodes: identity_status "known" | "inferred" | "unknown", per
# workspace_model.py), that identity is proven. Node kinds with no such field
# (checkout, revision, branch, ...) carry a deterministic content-hash id and
# are resolved by construction - there is nothing left to disambiguate.
def _resolve_subject(graph: Any, candidate: Any) -> Dict[str, Any]:
    node_id = _get_path(candidate, "subject", "node_id")
    if not isinstance(node_id, str) or len(node_id) == 0:
        return {"node": None, "resolved": False}
    nodes = _get_path(graph, "nodes")
    if not isinstance(nodes, list):
        nodes = []
    node = next((n for n in nodes if isinstance(n, dict) and n.get("id") == node_id), None)
    if node is None:
        return {"node": None, "resolved": False}
    if "identity_status" in node and node["identity_status"] != "known":
        return {"node": node, "resolved": False}
    return {"node": node, "resolved": True}


def _values_compatible(a: Any, b: Any) -> bool:
    a_normalized = a.get("normalized") if isinstance(a, dict) else None
    b_normalized = b.get("normalized") if isinstance(b, dict) else None
    return canonicalize(a_normalized) == canonicalize(b_normalized)


# "A supersession decision is invalid unless the comparison has" - the policy
# doc's required-comparison-inputs checklist, applied to the candidate side
# of an explicit-correction attempt.
def _required_supersession_inputs_present(candidate: Any) -> bool:
    evidence = _get_path(candidate, "source", "evidence")
    checks = [
        _js_truthy(_get_path(candidate, "subject", "node_id")),
        _js_truthy(_get_path(candidate, "predicate")),
        _get_path(candidate, "value", "normalized") is not _MISSING,
        _js_truthy(_get_path(candidate, "authority", "class")),
        _js_truthy(_get_path(candidate, "authority", "actor", "id")),
        _js_truthy(_get_path(candidate, "scope", "project")),
        _js_truthy(_get_path(candidate, "scope", "visibility")),
        _js_truthy(_get_path(candidate, "valid_time", "from")),
        _js_truthy(_get_path(candidate, "observed_time", "at")),
        isinstance(evidence, list),
        isinstance(evidence, list) and len(evidence) > 0,
        _js_truthy(_get_path(candidate, "source", "fingerprint")),
        _js_truthy(_get_path(candidate, "target_assertion_id")),
    ]
    return all(checks)


# "A caller should never have to infer whether a write replaced something" -
# active_truth is derived from the outcome, never left implicit. Only
# SUPERSEDED_EXPLICITLY ever activates a new version; every other outcome
# (including a refused correction attempt) leaves active truth unchanged.
def _active_truth_for(outcome: Optional[str]) -> str:
    return ACTIVE_TRUTH_NEW_VERSION_ACTIVE if outcome == SUPERSEDED_EXPLICITLY else ACTIVE_TRUTH_UNCHANGED


def _decision(
    outcome: Optional[str],
    reason_codes: List[str],
    subject: Dict[str, Any],
    evidence: Any,
    related_assertion_ids: Optional[List[str]] = None,
) -> Dict[str, Any]:
    return {
        "outcome": outcome,
        "reason_codes": sorted(set(reason_codes), key=_utf16_sort_key),
        "related_assertion_ids": sorted(set(related_assertion_ids or []), key=_utf16_sort_key),
        "active_truth": _active_truth_for(outcome),
        "subject": subject,
        "evidence": evidence if evidence is not None else [],
    }


def classify_candidate(
    *, graph: Any, candidate: Any, neighbors: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
    """Classify one candidate against the evidence graph and a set of
    neighbor candidates already recalled by the caller. Pure, deterministic,
    never throws, never mutates the graph, the candidate, or any neighbor.

    graph: output of project_workspace_graph
    candidate: the incoming assertion to evaluate
    neighbors: prior assertions the recall provider surfaced; each one only
        ever REFERENCES a graph node - it is data, never itself treated as
        truth.
    """
    resolved = _resolve_subject(graph, candidate)["resolved"]
    subject_info = {"node_id": _nullish_to_none(_get_path(candidate, "subject", "node_id")), "resolved": resolved}
    evidence = _nullish_to_none(_get_path(candidate, "source", "evidence"))
    if evidence is None:
        evidence = []

    if not resolved:
        return _decision(REVIEW_REQUIRED, [REASON_IDENTITY_UNRESOLVED], subject_info, evidence)

    neighbors = neighbors if neighbors is not None else []
    if not isinstance(neighbors, list) or any(
        not isinstance(neighbor, dict)
        or not isinstance(neighbor.get("id"), str)
        or not neighbor["id"]
        for neighbor in neighbors
    ):
        return _decision(
            REVIEW_REQUIRED,
            [REASON_RECALL_PROVIDER_FAILED],
            subject_info,
            evidence,
        )

    # Explicit, authorized correction: "explicit correction targeting an
    # assertion, authorized actor -> append new version and supersedes edge".
    target_assertion_id = _get_path(candidate, "target_assertion_id")
    if _js_truthy(target_assertion_id):
        target = next(
            (n for n in neighbors if isinstance(n, dict) and n.get("id") == target_assertion_id), None
        )
        if target is None:
            return _decision(REVIEW_REQUIRED, [REASON_SUPERSESSION_TARGET_MISSING], subject_info, evidence)
        if _get_path(target, "subject", "node_id") != _get_path(candidate, "subject", "node_id"):
            return _decision(
                REVIEW_REQUIRED,
                [REASON_SUPERSESSION_SUBJECT_MISMATCH],
                subject_info,
                evidence,
                related_assertion_ids=[target["id"]],
            )
        # "inferred claim challenging authored truth -> store as candidate/
        # challenge only -> authored truth unchanged." Similarity, an explicit
        # target, and even an authorized actor still grant no overwrite right
        # over authored truth.
        if _get_path(target, "authority", "class") == "authored":
            return _decision(
                REVIEW_REQUIRED,
                [REASON_AUTHORED_TRUTH_PROTECTED],
                subject_info,
                evidence,
                related_assertion_ids=[target["id"]],
            )
        if _get_path(candidate, "authority", "authorized") is not True:
            return _decision(
                REVIEW_REQUIRED,
                [REASON_ACTOR_NOT_AUTHORIZED],
                subject_info,
                evidence,
                related_assertion_ids=[target["id"]],
            )
        if not _required_supersession_inputs_present(candidate):
            return _decision(
                REVIEW_REQUIRED,
                [REASON_SUPERSESSION_INPUTS_INCOMPLETE],
                subject_info,
                evidence,
                related_assertion_ids=[target["id"]],
            )
        return _decision(
            SUPERSEDED_EXPLICITLY,
            [REASON_EXPLICIT_CORRECTION],
            subject_info,
            evidence,
            related_assertion_ids=[target["id"]],
        )

    # No explicit target: compare against same-subject/predicate/scope
    # neighbors to tell corroboration from conflict from genuine novelty.
    candidate_node_id = _get_path(candidate, "subject", "node_id")
    candidate_predicate = _get_path(candidate, "predicate")
    candidate_scope_project = _get_path(candidate, "scope", "project")
    candidate_scope_visibility = _get_path(candidate, "scope", "visibility")

    def _is_match(n: Any) -> bool:
        return (
            _get_path(n, "subject", "node_id") == candidate_node_id
            and _get_path(n, "predicate") == candidate_predicate
            and _get_path(n, "scope", "project") == candidate_scope_project
            and _get_path(n, "scope", "visibility") == candidate_scope_visibility
        )

    matches = [n for n in neighbors if isinstance(n, dict) and _is_match(n)]

    candidate_value = _get_path(candidate, "value")
    compatible = [n for n in matches if _values_compatible(n.get("value"), candidate_value)]
    if len(compatible) > 0:
        # "same claim, new independent evidence -> append corroborates evidence"
        candidate_fingerprint = _get_path(candidate, "source", "fingerprint")
        independent = [n for n in compatible if _get_path(n, "source", "fingerprint") != candidate_fingerprint]
        if len(independent) > 0:
            return _decision(
                CORROBORATION_RECORDED,
                [REASON_INDEPENDENT_EVIDENCE],
                subject_info,
                evidence,
                related_assertion_ids=[n["id"] for n in independent],
            )
        # "exact duplicate, same evidence -> idempotent no-op" (duplicate_ignored)
        # is out of this ticket's scope; the honest answer is "no decision made
        # here", not a fabricated corroboration or review-queue entry.
        return _decision(
            None,
            [REASON_EXACT_DUPLICATE_OUT_OF_SCOPE],
            subject_info,
            evidence,
            related_assertion_ids=[n["id"] for n in compatible],
        )

    incompatible = [n for n in matches if not _values_compatible(n.get("value"), candidate_value)]
    if len(incompatible) > 0:
        # "same subject/predicate, incompatible value -> preserve both, add
        # conflicts_with ... return review_required"
        return _decision(
            REVIEW_REQUIRED,
            [REASON_CONFLICTS_WITH],
            subject_info,
            evidence,
            related_assertion_ids=[n["id"] for n in incompatible],
        )

    # Nothing near this candidate at all: recorded_new is out of this
    # ticket's scope, and the doc is explicit that harmless novelty must not
    # become review-queue noise. Return no decision, not a fabricated one.
    return _decision(None, [REASON_NO_SIMILAR_NEIGHBOR], subject_info, evidence)
