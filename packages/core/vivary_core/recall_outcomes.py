"""Bellamente near-neighbor write policy: outcome and reason-code vocabulary
(docs/NEAR-NEIGHBOR-POLICY.md). Pinned string constants only - no logic - so
callers and tests can assert literal values without importing behavior.

Reference-guided Python port of src/recall/outcomes.mjs (graduation slice 6,
ticket #12, decision 0008). The Node module is the frozen executable oracle;
every constant's string value is byte-identical to its Node counterpart.

The policy doc's "Outcomes" section is a closed 8-item enum:
  recorded_new, duplicate_ignored, corroboration_recorded, version_recorded,
  superseded_explicitly, review_required, quarantined, rejected.
This ticket (#12) implements exactly three of those outcomes - the ones
reachable from the four matrix rows in scope. `identity_unresolved` is
deliberately NOT an outcome: the matrix and docs/ARCHITECTURE.md's
ContextIntegrityEvent example both show it as a reason code that
accompanies the `review_required` outcome
(`"decision": "review_required", "reason_codes": ["identity_unresolved", ...]`).
OUTCOMES must never grow to include a reason code - that is the
"do not invent outcomes the policy doc doesn't define" law.
"""

from __future__ import annotations

REVIEW_REQUIRED = "review_required"
CORROBORATION_RECORDED = "corroboration_recorded"
SUPERSEDED_EXPLICITLY = "superseded_explicitly"

OUTCOMES = (REVIEW_REQUIRED, CORROBORATION_RECORDED, SUPERSEDED_EXPLICITLY)

# Reason codes: explain *why* an outcome (or the absence of one) was reached.
# Matrix-literal codes first, then this module's own precise, coined codes
# for branches the matrix names only in prose.
REASON_IDENTITY_UNRESOLVED = "identity_unresolved"  # matrix: ambiguous subject identity
REASON_CONFLICTS_WITH = "conflicts_with"  # matrix: same subject/predicate, incompatible value
REASON_INDEPENDENT_EVIDENCE = "independent_evidence"  # matrix: same claim, new independent evidence
REASON_EXPLICIT_CORRECTION = "explicit_correction"  # matrix: explicit correction, authorized actor
REASON_AUTHORED_TRUTH_PROTECTED = "authored_truth_protected"  # matrix: inferred/learned claim challenging authored truth
REASON_ACTOR_NOT_AUTHORIZED = "actor_not_authorized"
REASON_SUPERSESSION_TARGET_MISSING = "supersession_target_missing"
REASON_SUPERSESSION_SUBJECT_MISMATCH = "supersession_subject_mismatch"
REASON_SUPERSESSION_INPUTS_INCOMPLETE = "supersession_inputs_incomplete"
REASON_NO_SIMILAR_NEIGHBOR = "no_similar_neighbor"  # out of ticket scope (would be recorded_new)
REASON_EXACT_DUPLICATE_OUT_OF_SCOPE = "exact_duplicate_out_of_scope"  # out of ticket scope (would be duplicate_ignored)
REASON_RECALL_PROVIDER_ABSENT = "recall_provider_absent"
REASON_RECALL_PROVIDER_FAILED = "recall_provider_failed"

# Envelope status (docs/ARCHITECTURE.md: "Bellamente remains optional... does
# not break the core system"). Distinct from `outcome`: `status` describes
# whether the recall provider ran at all, never a write decision.
# STATUS_PROVIDER_DEGRADED is its own status, not folded into either
# STATUS_EVALUATED (a provider that threw or returned garbage did not
# produce a trustworthy neighbor set - reporting "evaluated" would hide that
# from the caller) or STATUS_NO_PROVIDER (a provider was present and
# attempted, unlike absence).
STATUS_EVALUATED = "evaluated"
STATUS_NO_PROVIDER = "no_provider"
STATUS_PROVIDER_DEGRADED = "provider_degraded"

# "It also returns ... active-assertion status ... A caller should never
# have to infer whether a write replaced something." Every decision below
# carries this field explicitly rather than leaving it implicit in the
# outcome value - it is the sharpest proof that similarity alone never
# grants overwrite rights: only SUPERSEDED_EXPLICITLY ever activates a new
# version, and every other path - including the highest-similarity conflict
# or correction attempt this module refuses - leaves it "unchanged".
ACTIVE_TRUTH_UNCHANGED = "unchanged"
ACTIVE_TRUTH_NEW_VERSION_ACTIVE = "new_version_active"
