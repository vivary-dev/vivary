"""Pure, caller-persisted transitions for governed recall decisions.

Classification never authorizes a write.  This module recomputes the Core recall
verdict, projects an immutable caller ledger, and requires a proposal-bound human
approval before creating or superseding a learned assertion.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Any, Dict, Optional

from vivary_core.canonical import canonicalize, deterministic_id
from vivary_core.recall_classify import (
    _copy_recall_value,
    _has_fingerprinted_evidence,
    _is_normalized_assertion,
    _known_graph_node_ids,
    _nonempty_string,
    _preflight_recall_values,
    classify_candidate,
)
from vivary_core.recall_outcomes import (
    ACCEPTED,
    REASON_EXACT_DUPLICATE,
    REASON_EXPLICIT_CORRECTION,
    REVIEW_REQUIRED,
)

RECALL_TRANSITION_SCHEMA = "vivary.recall-transition/v0"
MAX_RECALL_ASSERTIONS = 10_000

RECALL_OPERATION = MappingProxyType(
    {
        "PRESERVE": "preserve",
        "CREATE": "create",
        "SUPERSEDE": "supersede",
    }
)
RECALL_TRANSITION_DECISION = MappingProxyType(
    {
        "PRESERVED": "preserved",
        "PROPOSED": "proposed",
        "APPLIED": "applied",
        "REFUSED": "refused",
    }
)
RECALL_TRANSITION_REASON = MappingProxyType(
    {
        "UNKNOWN_OPERATION": "unknown_recall_operation",
        "UNKNOWN_LEDGER": "unknown_recall_ledger",
        "NOT_PERMITTED": "recall_transition_not_permitted",
        "NOT_APPROVED": "recall_transition_not_approved",
        "WORK_UNBOUNDED": "recall_transition_work_unbounded",
        "ASSERTION_IDENTITY_CONFLICT": "recall_assertion_identity_conflict",
    }
)

_PERSISTED_CANDIDATE_FIELDS = (
    "subject",
    "predicate",
    "value",
    "authority",
    "scope",
    "valid_time",
    "observed_time",
    "source",
    "freshness",
)


def _proposal_id(operation: str, assertion_id: str, target_assertion_id: Optional[str]) -> str:
    return deterministic_id(
        "recall_proposal",
        {
            "operation": operation,
            "assertion_id": assertion_id,
            "target_assertion_id": target_assertion_id,
        },
    )


def _proposal(operation: str, assertion_id: str, target_assertion_id: Optional[str]) -> Dict[str, Any]:
    return {
        "proposal_id": _proposal_id(operation, assertion_id, target_assertion_id),
        "operation": operation,
        "assertion_id": assertion_id,
        "target_assertion_id": target_assertion_id,
        "requires_human_approval": True,
    }


def _assertion_base(candidate: Any, target_assertion_id: Optional[str]) -> Optional[Dict[str, Any]]:
    if type(candidate) is not dict or not _preflight_recall_values(candidate):
        return None
    base: Dict[str, Any] = {}
    for field in _PERSISTED_CANDIDATE_FIELDS:
        if field in candidate:
            base[field] = _copy_recall_value(candidate[field])

    authority = base.get("authority")
    if type(authority) is not dict or authority.get("class") != "learned":
        return None
    # Candidate authorization is input to classification.  Applied approval is
    # recorded separately and no transient boolean becomes stored authority.
    authority.pop("authorized", None)
    if target_assertion_id is not None:
        base["supersedes_assertion_id"] = target_assertion_id
    return base


def _assertion_id(base: Dict[str, Any]) -> str:
    return deterministic_id("assertion", base)


def _approval_is_exact(approval: Any, proposal: Dict[str, Any]) -> bool:
    if not _preflight_recall_values(approval):
        return False
    if type(approval) is not dict or set(approval) != {"proposal_id", "approved_by"}:
        return False
    if approval.get("proposal_id") != proposal["proposal_id"]:
        return False
    actor = approval.get("approved_by")
    return (
        type(actor) is dict
        and set(actor) == {"kind", "id"}
        and actor.get("kind") == "human"
        and _nonempty_string(actor.get("id"))
    )


def _module_record_is_valid(assertion: Dict[str, Any], assertions_by_id: Dict[str, Dict[str, Any]]) -> bool:
    provenance = assertion.get("transition_provenance")
    if provenance is None:
        return True
    if type(provenance) is not dict or set(provenance) != {
        "proposal_id",
        "operation",
        "approved_by",
    }:
        return False
    operation = provenance.get("operation")
    if operation not in (RECALL_OPERATION["CREATE"], RECALL_OPERATION["SUPERSEDE"]):
        return False
    approved_by = provenance.get("approved_by")
    if not (
        type(approved_by) is dict
        and set(approved_by) == {"kind", "id"}
        and approved_by.get("kind") == "human"
        and _nonempty_string(approved_by.get("id"))
    ):
        return False

    semantic = {
        key: value
        for key, value in assertion.items()
        if key not in {"id", "transition_provenance"}
    }
    assertion_id = assertion.get("id")
    if assertion_id != _assertion_id(semantic):
        return False
    target = assertion.get("supersedes_assertion_id")
    if operation == RECALL_OPERATION["CREATE"]:
        if target is not None:
            return False
    elif not _nonempty_string(target) or target not in assertions_by_id:
        return False
    return provenance.get("proposal_id") == _proposal_id(operation, assertion_id, target)


def _validated_ledger(graph: Any, assertions: Any):
    if type(assertions) is not list:
        return None, RECALL_TRANSITION_REASON["UNKNOWN_LEDGER"]
    if len(assertions) > MAX_RECALL_ASSERTIONS:
        return None, RECALL_TRANSITION_REASON["WORK_UNBOUNDED"]
    if not _preflight_recall_values(graph, assertions):
        return None, RECALL_TRANSITION_REASON["WORK_UNBOUNDED"]

    known_node_ids = _known_graph_node_ids(graph)
    assertions_by_id: Dict[str, Dict[str, Any]] = {}
    for assertion in assertions:
        if not (
            type(assertion) is dict
            and _nonempty_string(assertion.get("id"))
            and _is_normalized_assertion(assertion, candidate=False)
            and _has_fingerprinted_evidence(assertion)
            and assertion.get("subject", {}).get("node_id") in known_node_ids
        ):
            return None, RECALL_TRANSITION_REASON["UNKNOWN_LEDGER"]
        assertion_id = assertion["id"]
        if assertion_id in assertions_by_id:
            return None, RECALL_TRANSITION_REASON["UNKNOWN_LEDGER"]
        assertions_by_id[assertion_id] = assertion

    if any(
        not _module_record_is_valid(assertion, assertions_by_id)
        for assertion in assertions
    ):
        return None, RECALL_TRANSITION_REASON["UNKNOWN_LEDGER"]
    return assertions_by_id, None


def _result(
    *,
    decision: str,
    operation: Any,
    reason_codes,
    evaluation,
    assertions,
    added=None,
    superseded_assertion_ids=None,
    proposal=None,
) -> Dict[str, Any]:
    return {
        "schema": RECALL_TRANSITION_SCHEMA,
        "decision": decision,
        "operation": (
            operation
            if type(operation) is str and _preflight_recall_values(operation)
            else None
        ),
        "reason_codes": list(reason_codes),
        "evaluation": _copy_recall_value(evaluation) if evaluation is not None else None,
        "assertions": _copy_recall_value(assertions),
        "added": _copy_recall_value(added or []),
        "superseded_assertion_ids": list(superseded_assertion_ids or []),
        "proposal": _copy_recall_value(proposal) if proposal is not None else None,
    }


def _refused(operation: Any, reason: str, assertions=None, evaluation=None, proposal=None):
    safe_assertions = assertions if type(assertions) is list and _preflight_recall_values(assertions) else []
    return _result(
        decision=RECALL_TRANSITION_DECISION["REFUSED"],
        operation=operation,
        reason_codes=[reason],
        evaluation=evaluation,
        assertions=safe_assertions,
        proposal=proposal,
    )


def project_recall_transition(
    *,
    graph: Any,
    candidate: Any,
    assertions: Any,
    operation: Any,
    approval: Any = None,
) -> Dict[str, Any]:
    """Project one governed recall transition without mutating caller values."""
    if operation not in RECALL_OPERATION.values():
        return _refused(operation, RECALL_TRANSITION_REASON["UNKNOWN_OPERATION"])

    assertions_by_id, ledger_reason = _validated_ledger(graph, assertions)
    if ledger_reason is not None:
        return _refused(operation, ledger_reason)

    current_assertions = _copy_recall_value(assertions)
    evaluation = classify_candidate(
        graph=graph,
        candidate=candidate,
        neighbors=assertions,
    )

    if operation == RECALL_OPERATION["PRESERVE"]:
        return _result(
            decision=RECALL_TRANSITION_DECISION["PRESERVED"],
            operation=operation,
            reason_codes=[],
            evaluation=evaluation,
            assertions=current_assertions,
        )

    target_assertion_id: Optional[str] = None
    permitted = False
    if operation == RECALL_OPERATION["CREATE"]:
        permitted = (
            evaluation.get("outcome") == ACCEPTED
            and evaluation.get("reason_codes") == []
        )
    elif operation == RECALL_OPERATION["SUPERSEDE"]:
        evaluation_proposal = evaluation.get("proposal")
        permitted = (
            evaluation.get("outcome") == REVIEW_REQUIRED
            and evaluation.get("reason_codes") == [REASON_EXPLICIT_CORRECTION]
            and type(evaluation_proposal) is dict
            and _nonempty_string(evaluation_proposal.get("target_assertion_id"))
        )
        if permitted:
            target_assertion_id = evaluation_proposal["target_assertion_id"]

    if operation == RECALL_OPERATION["SUPERSEDE"] and not permitted:
        return _refused(
            operation,
            RECALL_TRANSITION_REASON["NOT_PERMITTED"],
            current_assertions,
            evaluation,
        )

    base = _assertion_base(candidate, target_assertion_id)
    if base is None or not _is_normalized_assertion(base, candidate=False) or not _has_fingerprinted_evidence(base):
        return _refused(
            operation,
            RECALL_TRANSITION_REASON["NOT_PERMITTED"],
            current_assertions,
            evaluation,
        )
    new_assertion_id = _assertion_id(base)
    transition_proposal = _proposal(operation, new_assertion_id, target_assertion_id)
    existing = assertions_by_id.get(new_assertion_id)
    if existing is not None:
        existing_semantic = {
            key: value
            for key, value in existing.items()
            if key not in {"id", "transition_provenance"}
        }
        if canonicalize(existing_semantic) != canonicalize(base):
            return _refused(
                operation,
                RECALL_TRANSITION_REASON["ASSERTION_IDENTITY_CONFLICT"],
                current_assertions,
                evaluation,
                transition_proposal,
            )
        provenance = existing.get("transition_provenance")
        if (
            type(provenance) is dict
            and provenance.get("proposal_id") == transition_proposal["proposal_id"]
            and provenance.get("operation") == operation
        ):
            if approval is None:
                if not permitted:
                    return _refused(
                        operation,
                        RECALL_TRANSITION_REASON["NOT_PERMITTED"],
                        current_assertions,
                        evaluation,
                        transition_proposal,
                    )
                return _result(
                    decision=RECALL_TRANSITION_DECISION["PROPOSED"],
                    operation=operation,
                    reason_codes=[],
                    evaluation=evaluation,
                    assertions=current_assertions,
                    proposal=transition_proposal,
                )
            if not _approval_is_exact(approval, transition_proposal):
                return _refused(
                    operation,
                    RECALL_TRANSITION_REASON["NOT_APPROVED"],
                    current_assertions,
                    evaluation,
                    transition_proposal,
                )
            if canonicalize(provenance["approved_by"]) != canonicalize(
                approval["approved_by"]
            ):
                return _refused(
                    operation,
                    RECALL_TRANSITION_REASON["ASSERTION_IDENTITY_CONFLICT"],
                    current_assertions,
                    evaluation,
                    transition_proposal,
                )
            return _result(
                decision=RECALL_TRANSITION_DECISION["APPLIED"],
                operation=operation,
                reason_codes=[],
                evaluation=evaluation,
                assertions=current_assertions,
                superseded_assertion_ids=[target_assertion_id] if target_assertion_id else [],
                proposal=transition_proposal,
            )
        return _refused(
            operation,
            RECALL_TRANSITION_REASON["ASSERTION_IDENTITY_CONFLICT"],
            current_assertions,
            evaluation,
            transition_proposal,
        )
    if not permitted:
        return _refused(
            operation,
            RECALL_TRANSITION_REASON["NOT_PERMITTED"],
            current_assertions,
            evaluation,
            transition_proposal,
        )

    if len(assertions) >= MAX_RECALL_ASSERTIONS:
        return _refused(
            operation,
            RECALL_TRANSITION_REASON["WORK_UNBOUNDED"],
            current_assertions,
            evaluation,
            transition_proposal,
        )

    if approval is None:
        return _result(
            decision=RECALL_TRANSITION_DECISION["PROPOSED"],
            operation=operation,
            reason_codes=[],
            evaluation=evaluation,
            assertions=current_assertions,
            proposal=transition_proposal,
        )
    if not _approval_is_exact(approval, transition_proposal):
        return _refused(
            operation,
            RECALL_TRANSITION_REASON["NOT_APPROVED"],
            current_assertions,
            evaluation,
            transition_proposal,
        )

    record = {
        "id": new_assertion_id,
        **base,
        "transition_provenance": {
            "proposal_id": transition_proposal["proposal_id"],
            "operation": operation,
            "approved_by": _copy_recall_value(approval["approved_by"]),
        },
    }
    projected = [*current_assertions, record]
    return _result(
        decision=RECALL_TRANSITION_DECISION["APPLIED"],
        operation=operation,
        reason_codes=[],
        evaluation=evaluation,
        assertions=projected,
        added=[record],
        superseded_assertion_ids=[target_assertion_id] if target_assertion_id else [],
        proposal=transition_proposal,
    )
