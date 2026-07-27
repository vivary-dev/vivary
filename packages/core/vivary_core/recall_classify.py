"""Pure CandidateRecallProvider classifier.

This module evaluates normalized prior assertions without I/O, mutation, clocks,
or provider calls.  ``docs/bellamente-memory/SPEC-bellamente-memory.md`` §6
owns its result contract.

ADAPTATION: the frozen Node oracle previously modeled corroboration recording
and immediate learned-assertion supersession.  §6 deliberately replaces those
write-shaped outcomes with accepted evaluations and gated correction proposals;
this classifier never activates or rewrites truth.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from vivary_core.canonical import _utf16_sort_key, canonicalize
from vivary_core.recall_outcomes import (
    ACCEPTED,
    ACTIVE_TRUTH_UNCHANGED,
    REASON_CORRECTION_INPUTS_INCOMPLETE,
    REASON_CORRECTION_NOT_AUTHORIZED,
    REASON_CORRECTION_SUBJECT_MISMATCH,
    REASON_CORRECTION_TARGET_MISSING,
    REASON_CORROBORATION,
    REASON_EVIDENCE_NOT_FINGERPRINTED,
    REASON_EXACT_DUPLICATE,
    REASON_EXPLICIT_CORRECTION,
    REASON_IDENTITY_UNRESOLVED,
    REASON_PROVIDER_DEGRADED,
    REASON_STALE,
    REASON_VALUE_CONFLICT,
    REJECTED,
    REVIEW_REQUIRED,
)

_MISSING = object()
_CANDIDATE_AUTHORITY_CLASS = "learned"
_KNOWN_NEIGHBOR_AUTHORITY_CLASSES = frozenset({"authored", "learned"})
_CURRENT_FRESHNESS = "current"
_STALE_FRESHNESS = "stale"
_INVALID_FRESHNESS = "invalid"


def _get_path(value: Any, *keys: str) -> Any:
    cur = value
    for key in keys:
        if not isinstance(cur, dict) or key not in cur:
            return _MISSING
        cur = cur[key]
    return cur


def _nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value)


def _stable_fingerprint(value: Any) -> bool:
    """Accept the stable, algorithm-labelled fingerprints normalized by §6.1."""
    return _nonempty_string(value) and value.startswith("sha256:") and len(value) > len("sha256:")


def _safe_evidence(candidate: Any) -> Any:
    source = _get_path(candidate, "source")
    evidence = source.get("evidence") if isinstance(source, dict) else None
    return evidence if isinstance(evidence, list) else []


def _has_fingerprinted_evidence(assertion: Any) -> bool:
    """Require stable provenance before any comparison or correction path."""
    source = _get_path(assertion, "source")
    if not isinstance(source, dict) or not _stable_fingerprint(source.get("fingerprint")):
        return False
    evidence = source.get("evidence")
    if not isinstance(evidence, list) or not evidence:
        return False
    return all(
        isinstance(item, dict)
        and _stable_fingerprint(item.get("digest"))
        and (
            "fingerprint" not in item
            or _stable_fingerprint(item.get("fingerprint"))
        )
        for item in evidence
    )


def _freshness_state(value: Any, *, required: bool) -> str:
    """Normalize a current/stale marker without consulting a wall clock."""
    if not isinstance(value, dict):
        return _INVALID_FRESHNESS
    raw = value.get("freshness", _MISSING)
    if raw is _MISSING:
        return _INVALID_FRESHNESS if required else _CURRENT_FRESHNESS
    if isinstance(raw, dict):
        raw = raw.get("status", raw.get("state", _MISSING))
    if raw in ("current", "fresh"):
        return _CURRENT_FRESHNESS
    if raw == "stale":
        return _STALE_FRESHNESS
    return _INVALID_FRESHNESS


def _assertion_freshness(assertion: Dict[str, Any]) -> str:
    """Return current, stale, or invalid for assertion/source/evidence data."""
    states = [_freshness_state(assertion, required=True)]
    source = assertion.get("source")
    if not isinstance(source, dict):
        return _INVALID_FRESHNESS
    states.append(_freshness_state(source, required=False))
    evidence = source.get("evidence")
    if not isinstance(evidence, list):
        return _INVALID_FRESHNESS
    states.extend(_freshness_state(item, required=False) for item in evidence)
    if _INVALID_FRESHNESS in states:
        return _INVALID_FRESHNESS
    if _STALE_FRESHNESS in states:
        return _STALE_FRESHNESS
    return _CURRENT_FRESHNESS


def _canonical_value_is_valid(assertion: Dict[str, Any]) -> bool:
    value = assertion.get("value")
    if not isinstance(value, dict) or "normalized" not in value:
        return False
    try:
        canonicalize(value["normalized"])
    except Exception:
        return False
    return True


def _is_normalized_assertion(assertion: Any, *, candidate: bool) -> bool:
    """Validate only the provider-normalized assertion boundary from §6.1."""
    if not isinstance(assertion, dict):
        return False

    subject = assertion.get("subject")
    if not isinstance(subject, dict):
        return False
    node_id = subject.get("node_id")
    if candidate:
        # An absent node id remains the fail-closed unresolved-identity path.
        if node_id is not None and not _nonempty_string(node_id):
            return False
    elif not _nonempty_string(node_id):
        return False

    if not _nonempty_string(assertion.get("predicate")) or not _canonical_value_is_valid(assertion):
        return False

    scope = assertion.get("scope")
    if not isinstance(scope, dict) or not _nonempty_string(scope.get("project")) or not _nonempty_string(
        scope.get("visibility")
    ):
        return False

    authority = assertion.get("authority")
    if not isinstance(authority, dict):
        return False
    authority_class = authority.get("class")
    if candidate:
        if authority_class != _CANDIDATE_AUTHORITY_CLASS:
            return False
    elif authority_class not in _KNOWN_NEIGHBOR_AUTHORITY_CLASSES:
        return False

    observed_time = assertion.get("observed_time")
    if not isinstance(observed_time, dict) or not _nonempty_string(observed_time.get("at")):
        return False

    return _freshness_state(assertion, required=True) != _INVALID_FRESHNESS


def _resolve_subject(graph: Any, candidate: Any) -> Tuple[Optional[Dict[str, Any]], bool]:
    node_id = _get_path(candidate, "subject", "node_id")
    if not _nonempty_string(node_id):
        return None, False
    nodes = graph.get("nodes") if isinstance(graph, dict) else None
    if not isinstance(nodes, list):
        return None, False
    node = next((item for item in nodes if isinstance(item, dict) and item.get("id") == node_id), None)
    if node is None:
        return None, False
    if "identity_status" in node and node.get("identity_status") != "known":
        return node, False
    return node, True


def _subject_info(graph: Any, candidate: Any) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]], bool]:
    try:
        node, resolved = _resolve_subject(graph, candidate)
        node_id = _get_path(candidate, "subject", "node_id")
        return {"node_id": node_id if _nonempty_string(node_id) else None, "resolved": resolved}, node, resolved
    except Exception:
        return {"node_id": None, "resolved": False}, None, False


def _node_freshness(node: Optional[Dict[str, Any]]) -> str:
    if node is None:
        return _CURRENT_FRESHNESS
    return _freshness_state(node, required=False)


def _values_compatible(left: Dict[str, Any], right: Dict[str, Any]) -> bool:
    try:
        return canonicalize(left["value"]["normalized"]) == canonicalize(right["value"]["normalized"])
    except Exception:
        # Public ``classify_candidate`` contains this as provider degradation.
        return False


def _correction_authorized(candidate: Dict[str, Any]) -> bool:
    authority = candidate.get("authority")
    if not isinstance(authority, dict) or authority.get("authorized") is not True:
        return False
    actor = authority.get("actor")
    return isinstance(actor, dict) and _nonempty_string(actor.get("kind")) and _nonempty_string(actor.get("id"))


def _correction_inputs_complete(candidate: Dict[str, Any]) -> bool:
    valid_time = candidate.get("valid_time")
    return isinstance(valid_time, dict) and _nonempty_string(valid_time.get("from"))


def _decision(
    outcome: str,
    reason_codes: List[str],
    subject: Dict[str, Any],
    evidence: Any,
    *,
    related_assertion_ids: Optional[List[str]] = None,
    proposal: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    return {
        "outcome": outcome,
        "reason_codes": sorted(set(reason_codes), key=_utf16_sort_key),
        "related_assertion_ids": sorted(set(related_assertion_ids or []), key=_utf16_sort_key),
        "active_truth": ACTIVE_TRUTH_UNCHANGED,
        "subject": subject,
        "evidence": evidence,
        "proposal": proposal,
    }


def _provider_degraded_decision(graph: Any, candidate: Any) -> Dict[str, Any]:
    subject, _, _ = _subject_info(graph, candidate)
    return _decision(
        REJECTED,
        [REASON_PROVIDER_DEGRADED],
        subject,
        _safe_evidence(candidate),
    )


def _classify_candidate(graph: Any, candidate: Any, neighbors: Optional[List[Dict[str, Any]]]) -> Dict[str, Any]:
    subject, subject_node, resolved = _subject_info(graph, candidate)
    evidence = _safe_evidence(candidate)

    if not isinstance(candidate, dict):
        return _provider_degraded_decision(graph, candidate)
    if neighbors is None:
        neighbors = []
    if not isinstance(neighbors, list) or any(not isinstance(neighbor, dict) for neighbor in neighbors):
        return _provider_degraded_decision(graph, candidate)

    # Stable evidence is a prerequisite for every comparison and correction.
    # It intentionally outranks identity resolution so malformed provenance
    # cannot reach any other evaluation path.
    if not _has_fingerprinted_evidence(candidate) or any(
        not _has_fingerprinted_evidence(neighbor) for neighbor in neighbors
    ):
        return _decision(REJECTED, [REASON_EVIDENCE_NOT_FINGERPRINTED], subject, evidence)

    # The provider owns normalization.  Unknown candidate authority classes and
    # unknown neighbor authority classes are malformed provider data; neither
    # may slip past authored-truth protection.
    if not _is_normalized_assertion(candidate, candidate=True) or any(
        not _is_normalized_assertion(neighbor, candidate=False) or not _nonempty_string(neighbor.get("id"))
        for neighbor in neighbors
    ):
        return _provider_degraded_decision(graph, candidate)

    freshness_states = [
        _assertion_freshness(candidate),
        *(_assertion_freshness(neighbor) for neighbor in neighbors),
        _node_freshness(subject_node),
    ]
    # A malformed freshness marker is provider degradation even when another
    # entry is stale.  This fixed precedence keeps a permutation of provider
    # data from changing the decision.
    if _INVALID_FRESHNESS in freshness_states:
        return _provider_degraded_decision(graph, candidate)
    if _STALE_FRESHNESS in freshness_states:
        return _decision(REJECTED, [REASON_STALE], subject, evidence)

    # An unresolved identity is only a review result; it never reaches the
    # duplicate, corroboration, conflict, or correction paths below.
    if not resolved:
        return _decision(REVIEW_REQUIRED, [REASON_IDENTITY_UNRESOLVED], subject, evidence)

    target_assertion_id = candidate.get("target_assertion_id")
    if target_assertion_id is not None:
        if not _nonempty_string(target_assertion_id):
            return _decision(REVIEW_REQUIRED, [REASON_CORRECTION_INPUTS_INCOMPLETE], subject, evidence)
        target = next((neighbor for neighbor in neighbors if neighbor.get("id") == target_assertion_id), None)
        if target is None:
            return _decision(REVIEW_REQUIRED, [REASON_CORRECTION_TARGET_MISSING], subject, evidence)
        if _get_path(target, "subject", "node_id") != _get_path(candidate, "subject", "node_id"):
            return _decision(
                REVIEW_REQUIRED,
                [REASON_CORRECTION_SUBJECT_MISMATCH],
                subject,
                evidence,
                related_assertion_ids=[target["id"]],
            )
        if not _correction_authorized(candidate):
            return _decision(
                REVIEW_REQUIRED,
                [REASON_CORRECTION_NOT_AUTHORIZED],
                subject,
                evidence,
                related_assertion_ids=[target["id"]],
            )
        if not _correction_inputs_complete(candidate):
            return _decision(
                REVIEW_REQUIRED,
                [REASON_CORRECTION_INPUTS_INCOMPLETE],
                subject,
                evidence,
                related_assertion_ids=[target["id"]],
            )
        return _decision(
            REVIEW_REQUIRED,
            [REASON_EXPLICIT_CORRECTION],
            subject,
            evidence,
            related_assertion_ids=[target["id"]],
            proposal={
                "kind": REASON_EXPLICIT_CORRECTION,
                "target_assertion_id": target["id"],
                "requires_human_approval": True,
            },
        )

    candidate_node_id = _get_path(candidate, "subject", "node_id")
    candidate_predicate = candidate["predicate"]
    candidate_scope = candidate["scope"]

    matches = [
        neighbor
        for neighbor in neighbors
        if _get_path(neighbor, "subject", "node_id") == candidate_node_id
        and neighbor.get("predicate") == candidate_predicate
        and _get_path(neighbor, "scope", "project") == candidate_scope["project"]
        and _get_path(neighbor, "scope", "visibility") == candidate_scope["visibility"]
    ]
    compatible = [neighbor for neighbor in matches if _values_compatible(neighbor, candidate)]
    if compatible:
        candidate_fingerprint = candidate["source"]["fingerprint"]
        independent = [
            neighbor for neighbor in compatible if neighbor["source"]["fingerprint"] != candidate_fingerprint
        ]
        if independent:
            return _decision(
                ACCEPTED,
                [REASON_CORROBORATION],
                subject,
                evidence,
                related_assertion_ids=[neighbor["id"] for neighbor in independent],
            )
        return _decision(
            ACCEPTED,
            [REASON_EXACT_DUPLICATE],
            subject,
            evidence,
            related_assertion_ids=[neighbor["id"] for neighbor in compatible],
        )

    if matches:
        return _decision(
            REVIEW_REQUIRED,
            [REASON_VALUE_CONFLICT],
            subject,
            evidence,
            related_assertion_ids=[neighbor["id"] for neighbor in matches],
        )

    # A normalized candidate with no recalled match was still evaluated
    # successfully.  It is neither an automatic write nor a review reason.
    return _decision(ACCEPTED, [], subject, evidence)


def classify_candidate(
    *, graph: Any, candidate: Any, neighbors: Optional[List[Dict[str, Any]]] = None
) -> Dict[str, Any]:
    """Return one deterministic §6 result without mutating caller-owned data.

    Direct callers receive a fail-closed ``rejected/provider_degraded`` result
    for malformed provider-shaped data rather than an exception.  The firewall
    repeats that containment around its provider callback boundary.
    """
    try:
        return _classify_candidate(graph, candidate, neighbors)
    except Exception:
        return _provider_degraded_decision(graph, candidate)
