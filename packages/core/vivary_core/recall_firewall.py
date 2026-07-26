"""The near-neighbor write firewall's public seam (#12, carries upstream
vivary#145 intent). Bellamente is optional (docs/ARCHITECTURE.md: "Absence
means the loop ends at the receipt or produces a plain review inbox; it does
not break the core system"), so this module's only job beyond classification
is graceful degradation: with no recall provider, or with a provider that
fails, return a clean structured status, never throw, never fabricate a write
decision, and never let a failure masquerade as a healthy "found nothing"
result.

Reference-guided Python port of src/recall/firewall.mjs (graduation slice 6,
ticket #12, decision 0008). The Node module is the frozen executable oracle.

A recall provider is any object shaped `{ recall({ graph, candidate }) ->
neighbor[] }`. In this Python port a provider is a dict with a callable
"recall" key (mirroring the Node object-literal shape most directly), called
as `recall(graph=graph, candidate=candidate)` - Python keyword arguments
standing in for the Node reference's single options-object argument, the
same calling convention every other ported function in this package uses.
This module never constructs, fetches, or embeds a provider - it only ever
consumes the neighbor list a provider hands back, and neighbors remain data,
never truth, all the way through classify_candidate.

ADAPTATION - malformed neighbor sets: an external provider that returns
non-object or id-less entries has not produced trustworthy recall evidence.
Report provider degradation before classification rather than evaluating a
partial set or allowing malformed data to raise.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from vivary_core.recall_classify import classify_candidate
from vivary_core.recall_outcomes import (
    ACTIVE_TRUTH_UNCHANGED,
    REASON_RECALL_PROVIDER_ABSENT,
    REASON_RECALL_PROVIDER_FAILED,
    STATUS_EVALUATED,
    STATUS_NO_PROVIDER,
    STATUS_PROVIDER_DEGRADED,
)


def _degraded_status(status: str, reason_code: str, candidate: Any) -> Dict[str, Any]:
    subject = candidate.get("subject") if isinstance(candidate, dict) else None
    node_id = subject.get("node_id") if isinstance(subject, dict) else None
    source = candidate.get("source") if isinstance(candidate, dict) else None
    evidence = source.get("evidence") if isinstance(source, dict) else None
    return {
        "status": status,
        "outcome": None,
        "reason_codes": [reason_code],
        "related_assertion_ids": [],
        "active_truth": ACTIVE_TRUTH_UNCHANGED,
        "subject": {"node_id": node_id if node_id is not None else None, "resolved": None},
        "evidence": evidence if evidence is not None else [],
    }


def evaluate_candidate(
    *, graph: Any = None, candidate: Any = None, provider: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """Evaluate one candidate through the near-neighbor write firewall.

    graph: output of project_workspace_graph
    candidate: the incoming assertion to evaluate
    provider: optional recall provider dict, `{"recall": callable}`; absence
        degrades to a graph-only structured no-op, and a provider whose
        recall() raises or returns a malformed neighbor list degrades to its
        own distinct, visible status rather than being silently treated as
        "found no neighbors."
    """
    recall_fn = provider.get("recall") if isinstance(provider, dict) else None
    if not callable(recall_fn):
        return _degraded_status(STATUS_NO_PROVIDER, REASON_RECALL_PROVIDER_ABSENT, candidate)

    try:
        neighbors = recall_fn(graph=graph, candidate=candidate)
    except Exception:
        return _degraded_status(STATUS_PROVIDER_DEGRADED, REASON_RECALL_PROVIDER_FAILED, candidate)

    neighbors_are_valid = isinstance(neighbors, list) and all(
        isinstance(neighbor, dict)
        and isinstance(neighbor.get("id"), str)
        and bool(neighbor["id"])
        for neighbor in neighbors
    )
    if not neighbors_are_valid:
        return _degraded_status(
            STATUS_PROVIDER_DEGRADED,
            REASON_RECALL_PROVIDER_FAILED,
            candidate,
        )

    result = classify_candidate(graph=graph, candidate=candidate, neighbors=neighbors)
    return {"status": STATUS_EVALUATED, **result}
