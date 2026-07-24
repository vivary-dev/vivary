"""Ozone verification surface (#10): barrel re-export of receipt integrity
verification, gate evidence-sufficiency evaluation, and context-budget
repair proposals. See docs/ARCHITECTURE.md - "Ozone: pressure testing and
integrity verification." Ozone verifies; it never repairs in place -
verify_repair.py only ever proposes, gated on explicit human approval.

Reference-guided Python port of src/verify/index.mjs (graduation slice 4,
Ozone; decision 0008): a pure re-export aggregator, no new logic.
"""

from __future__ import annotations

from vivary_core.verify_receipt import RECEIPT_VERDICT_SCHEMA, verify_receipt_integrity
from vivary_core.verify_sufficiency import GATE_VERDICT_SCHEMA, evaluate_gate_sufficiency
from vivary_core.verify_repair import REPAIR_KINDS, REPAIR_PROPOSAL_SCHEMA, propose_context_repairs
from vivary_core.verify_reasons import OUTCOMES, REASON_CODES

# Mirrors src/verify/index.mjs's exact export list - MAX_DEDUPE_CHECKOUTS is
# intentionally NOT re-exported here, matching the Node barrel, which only
# re-exports it implicitly not at all (repair.mjs's MAX_DEDUPE_CHECKOUTS is
# not part of index.mjs's `export { ... } from "./repair.mjs"` list).
__all__ = [
    "verify_receipt_integrity",
    "RECEIPT_VERDICT_SCHEMA",
    "evaluate_gate_sufficiency",
    "GATE_VERDICT_SCHEMA",
    "propose_context_repairs",
    "REPAIR_PROPOSAL_SCHEMA",
    "REPAIR_KINDS",
    "OUTCOMES",
    "REASON_CODES",
]
