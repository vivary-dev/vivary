"""Pure construction: capsule + run evidence -> integrity receipt.
A receipt is evidence of what happened, bound to the exact capsule and
workspace fingerprint it ran against. It never declares success beyond its
checks, and provenance references (e.g. an Entire checkpoint) are labeled
as provenance only - they are not proof of correctness.

Reference-guided Python port of src/receipt/create.mjs (slice 1, ticket #84,
decision 0008). The Node module is the frozen executable oracle; every byte
this function emits must reproduce the Node reference exactly (proven by the
parity fixtures in python/parity/fixtures/).
"""

from __future__ import annotations

from datetime import datetime, timezone

from vivary_core.canonical import deterministic_id, fingerprint

RECEIPT_SCHEMA = "vivary.execution-receipt/v0"


def _default_clock() -> str:
    # JS `new Date().toISOString()`: "YYYY-MM-DDTHH:MM:SS.mmmZ" (milliseconds,
    # 3 digits, UTC, trailing Z). Defined independently here, mirroring how
    # src/receipt/create.mjs defines its own inline clock rather than sharing
    # one with src/event/contract.mjs.
    dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def create_integrity_receipt(*, capsule, runtime, checks, provenance=None, now=None):
    """@param capsule    compiled Task Capsule
    @param runtime  {harness, model?, actor}
    @param checks   [{name, command, outcome: "passed"|"failed"|"skipped", detail?}]
    @param provenance  [{kind, ref}]
    @param now      injectable zero-arg clock for determinism
    """
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
