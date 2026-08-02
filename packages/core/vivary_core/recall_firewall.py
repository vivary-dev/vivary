"""Optional-provider boundary for the CandidateRecallProvider firewall.

The provider is data-only: this module neither constructs one nor performs I/O.
It turns absent, malformed, failed, or exception-raising provider input into the
visible §6 ``rejected/provider_degraded`` result.

ADAPTATION: the frozen Node oracle exposed separate no-provider and provider-
failed envelope states.  SPEC §6.2 makes both one core rejected degradation
condition, so this boundary deliberately converges them.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from vivary_core.recall_classify import (
    _copy_recall_value,
    _preflight_recall_values,
    classify_candidate,
)
from vivary_core.recall_outcomes import (
    ACTIVE_TRUTH_UNCHANGED,
    REASON_PROVIDER_DEGRADED,
    REJECTED,
    STATUS_EVALUATED,
    STATUS_PROVIDER_DEGRADED,
)


def _safe_subject(candidate: Any, *, candidate_bounded: bool) -> Dict[str, Any]:
    if not candidate_bounded or type(candidate) is not dict:
        return {"node_id": None, "resolved": False}
    subject = candidate.get("subject")
    node_id = subject.get("node_id") if type(subject) is dict else None
    return {"node_id": node_id if type(node_id) is str and node_id else None, "resolved": False}


def _safe_evidence(candidate: Any, *, candidate_bounded: bool) -> Any:
    if not candidate_bounded or type(candidate) is not dict:
        return []
    source = candidate.get("source")
    evidence = source.get("evidence") if type(source) is dict else None
    return _copy_recall_value(evidence) if type(evidence) is list else []


def _empty_degraded_result() -> Dict[str, Any]:
    return {
        "status": STATUS_PROVIDER_DEGRADED,
        "outcome": REJECTED,
        "reason_codes": [REASON_PROVIDER_DEGRADED],
        "related_assertion_ids": [],
        "active_truth": ACTIVE_TRUTH_UNCHANGED,
        "subject": {"node_id": None, "resolved": False},
        "evidence": [],
        "proposal": None,
    }


def _degraded_result(candidate: Any, *, candidate_bounded: bool = False) -> Dict[str, Any]:
    if not candidate_bounded:
        return _empty_degraded_result()
    try:
        return {
            "status": STATUS_PROVIDER_DEGRADED,
            "outcome": REJECTED,
            "reason_codes": [REASON_PROVIDER_DEGRADED],
            "related_assertion_ids": [],
            "active_truth": ACTIVE_TRUTH_UNCHANGED,
            "subject": _safe_subject(candidate, candidate_bounded=True),
            "evidence": _safe_evidence(candidate, candidate_bounded=True),
            "proposal": None,
        }
    except Exception:
        return _empty_degraded_result()


def _neighbor_envelope_is_valid(neighbors: Any) -> bool:
    return type(neighbors) is list and all(
        type(neighbor) is dict and type(neighbor.get("id")) is str and bool(neighbor["id"])
        for neighbor in neighbors
    )


def evaluate_candidate(
    *, graph: Any = None, candidate: Any = None, provider: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """Evaluate one candidate through an optional provider, never raising.

    Graph and candidate values are bounded before invoking the provider, and
    returned neighbors are bounded before the normalized-data classifier can
    canonicalize or project any of them.
    """
    candidate_bounded = _preflight_recall_values(candidate)
    if not candidate_bounded or not _preflight_recall_values(graph, candidate):
        return _degraded_result(candidate, candidate_bounded=candidate_bounded)

    recall_fn = provider.get("recall") if type(provider) is dict else None
    if not callable(recall_fn):
        return _degraded_result(candidate, candidate_bounded=True)

    try:
        neighbors = recall_fn(
            graph=_copy_recall_value(graph),
            candidate=_copy_recall_value(candidate),
        )
        if not _preflight_recall_values(graph, candidate, neighbors):
            return _degraded_result(candidate, candidate_bounded=True)
        if not _neighbor_envelope_is_valid(neighbors):
            return _degraded_result(candidate, candidate_bounded=True)
        result = classify_candidate(graph=graph, candidate=candidate, neighbors=neighbors)
        if type(result) is not dict:
            return _degraded_result(candidate, candidate_bounded=True)
    except Exception:
        return _degraded_result(candidate, candidate_bounded=True)

    if result.get("outcome") == REJECTED and REASON_PROVIDER_DEGRADED in result.get("reason_codes", []):
        return {"status": STATUS_PROVIDER_DEGRADED, **result}
    return {"status": STATUS_EVALUATED, **result}
