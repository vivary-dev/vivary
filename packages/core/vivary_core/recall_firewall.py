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

from vivary_core.recall_classify import classify_candidate
from vivary_core.recall_outcomes import (
    ACTIVE_TRUTH_UNCHANGED,
    REASON_PROVIDER_DEGRADED,
    REJECTED,
    STATUS_EVALUATED,
    STATUS_PROVIDER_DEGRADED,
)


def _safe_subject(candidate: Any) -> Dict[str, Any]:
    subject = candidate.get("subject") if isinstance(candidate, dict) else None
    node_id = subject.get("node_id") if isinstance(subject, dict) else None
    return {"node_id": node_id if isinstance(node_id, str) and node_id else None, "resolved": False}


def _safe_evidence(candidate: Any) -> Any:
    source = candidate.get("source") if isinstance(candidate, dict) else None
    evidence = source.get("evidence") if isinstance(source, dict) else None
    return evidence if isinstance(evidence, list) else []


def _degraded_result(candidate: Any) -> Dict[str, Any]:
    return {
        "status": STATUS_PROVIDER_DEGRADED,
        "outcome": REJECTED,
        "reason_codes": [REASON_PROVIDER_DEGRADED],
        "related_assertion_ids": [],
        "active_truth": ACTIVE_TRUTH_UNCHANGED,
        "subject": _safe_subject(candidate),
        "evidence": _safe_evidence(candidate),
        "proposal": None,
    }


def _neighbor_envelope_is_valid(neighbors: Any) -> bool:
    return isinstance(neighbors, list) and all(
        isinstance(neighbor, dict) and isinstance(neighbor.get("id"), str) and bool(neighbor["id"])
        for neighbor in neighbors
    )


def evaluate_candidate(
    *, graph: Any = None, candidate: Any = None, provider: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """Evaluate one candidate through an optional provider, never raising.

    A healthy provider result is still subject to the pure classifier's own
    normalized-data, evidence, freshness, and authority checks.  Provider data
    that raises during classification is contained here as degradation rather
    than escaping the firewall.
    """
    recall_fn = provider.get("recall") if isinstance(provider, dict) else None
    if not callable(recall_fn):
        return _degraded_result(candidate)

    try:
        neighbors = recall_fn(graph=graph, candidate=candidate)
        if not _neighbor_envelope_is_valid(neighbors):
            return _degraded_result(candidate)
        result = classify_candidate(graph=graph, candidate=candidate, neighbors=neighbors)
        if not isinstance(result, dict):
            return _degraded_result(candidate)
    except Exception:
        return _degraded_result(candidate)

    if result.get("outcome") == REJECTED and REASON_PROVIDER_DEGRADED in result.get("reason_codes", []):
        return {"status": STATUS_PROVIDER_DEGRADED, **result}
    return {"status": STATUS_EVALUATED, **result}
