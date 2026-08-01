"""Pure construction: capsule + run evidence -> integrity receipt.
A receipt is evidence of what happened, bound to the exact capsule and
workspace fingerprint it ran against. It never declares success beyond its
checks, and provenance references (e.g. an Entire checkpoint) are labeled
as provenance only - they are not proof of correctness.

Reference-guided Python port of src/receipt/create.mjs (slice 1, ticket #84,
decision 0008). The Node module is the frozen executable oracle; every byte
this function emits must reproduce the Node reference exactly (proven by the
parity fixtures in python/parity/fixtures/).

ADAPTATION - complete binding construction: a receipt is refused at creation
unless its capsule ID, capsule fingerprint, and workspace fingerprint are
non-empty strings. Empty bindings cannot become valid-looking evidence.
"""

from __future__ import annotations

from datetime import datetime, timezone

from vivary_core.canonical import deterministic_id, fingerprint

RECEIPT_SCHEMA = "vivary.execution-receipt/v0"
EXECUTION_RECEIPT_FIELDS = frozenset(
    {
        "receipt_id",
        "schema",
        "capsule",
        "workspace",
        "runtime",
        "checks",
        "claims_in_scope",
        "claims_verified",
        "claims_unverified",
        "unresolved_conflicts",
        "unresolved_unknowns",
        "provenance",
        "created_at",
        "fingerprint",
    }
)



def _default_clock() -> str:
    # JS `new Date().toISOString()`: "YYYY-MM-DDTHH:MM:SS.mmmZ" (milliseconds,
    # 3 digits, UTC, trailing Z). Defined independently here, mirroring how
    # src/receipt/create.mjs defines its own inline clock rather than sharing
    # one with src/event/contract.mjs.
    dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _has_complete_capsule_binding(capsule) -> bool:
    workspace = capsule.get("workspace") if isinstance(capsule, dict) else None
    return (
        isinstance(capsule, dict)
        and isinstance(capsule.get("capsule_id"), str)
        and len(capsule["capsule_id"]) > 0
        and isinstance(capsule.get("fingerprint"), str)
        and len(capsule["fingerprint"]) > 0
        and isinstance(workspace, dict)
        and isinstance(workspace.get("fingerprint"), str)
        and len(workspace["fingerprint"]) > 0
    )


def create_integrity_receipt(*, capsule, runtime, checks, provenance=None, now=None):
    """@param capsule    compiled Task Capsule
    @param runtime  {harness, model?, actor}
    @param checks   [{name, command, outcome: "passed"|"failed"|"skipped", detail?}]
    @param provenance  [{kind, ref}]
    @param now      injectable zero-arg clock for determinism
    """
    if not _has_complete_capsule_binding(capsule):
        raise ValueError("receipt construction requires non-empty capsule and workspace bindings")
    if not isinstance(runtime, dict) or not isinstance(runtime.get("actor"), str) or not runtime["actor"]:
        raise ValueError("receipt construction requires a non-empty runtime actor")

    clock = now if now is not None else _default_clock
    created_at = clock()
    if provenance is None:
        provenance = []

    all_passed = len(checks) > 0 and all(c["outcome"] == "passed" for c in checks)
    body = {
        "schema": RECEIPT_SCHEMA,
        "capsule": {"id": capsule["capsule_id"], "fingerprint": capsule["fingerprint"]},
        "workspace": {
            "fingerprint": capsule["workspace"]["fingerprint"],
            "observed_at": capsule["workspace"]["observed_at"],
        },
        "runtime": runtime,
        "checks": checks,
        "claims_in_scope": [c["id"] for c in capsule["claims"]],
        "claims_verified": [c["id"] for c in capsule["claims"]] if all_passed else [],
        "claims_unverified": [] if all_passed else [c["id"] for c in capsule["claims"]],
        "unresolved_conflicts": [{"id": c["id"], "decision": c["decision"]} for c in capsule["conflicts"]],
        "unresolved_unknowns": capsule["unknowns"],
        "provenance": [
            {**p, "note": "provenance reference only; not proof of correctness"} for p in provenance
        ],
        "created_at": created_at,
    }

    return {
        "receipt_id": deterministic_id(
            "receipt",
            {
                "capsule": capsule["fingerprint"],
                "created_at": created_at,
                "actor": runtime["actor"],
            },
        ),
        **body,
        "fingerprint": fingerprint(body),
    }
