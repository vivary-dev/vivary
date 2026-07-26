"""CandidateRecallProvider firewall result vocabulary.

``docs/bellamente-memory/SPEC-bellamente-memory.md`` §6 is authoritative for
these values.  The frozen Node oracle used different outcome names; this module
intentionally does not preserve those aliases.
"""

from __future__ import annotations

# Every evaluation resolves to one of these core decisions.  ``accepted`` only
# means the candidate was evaluated successfully; it never authorizes a write.
ACCEPTED = "accepted"
REVIEW_REQUIRED = "review_required"
REJECTED = "rejected"
OUTCOMES = (ACCEPTED, REVIEW_REQUIRED, REJECTED)

# SPEC §6.2 condition labels.  Results carry them in ``reason_codes`` to retain
# the repository-wide machine-readable decision shape.
REASON_EXACT_DUPLICATE = "exact_duplicate"
REASON_CORROBORATION = "corroboration"
REASON_EXPLICIT_CORRECTION = "explicit_correction"
REASON_IDENTITY_UNRESOLVED = "identity_unresolved"
REASON_VALUE_CONFLICT = "value_conflict"
REASON_STALE = "stale"
REASON_PROVIDER_DEGRADED = "provider_degraded"
REASON_EVIDENCE_NOT_FINGERPRINTED = "evidence_not_fingerprinted"

# These are deliberately limited to malformed explicit-correction proposals.
# §6.2 names all ordinary evaluation outcomes, so no other coined review
# reasons are allowed.
REASON_CORRECTION_TARGET_MISSING = "correction_target_missing"
REASON_CORRECTION_SUBJECT_MISMATCH = "correction_subject_mismatch"
REASON_CORRECTION_NOT_AUTHORIZED = "correction_not_authorized"
REASON_CORRECTION_INPUTS_INCOMPLETE = "correction_inputs_incomplete"

# The envelope reports whether the optional provider delivered data fit for
# classification.  A degraded provider still returns the core rejected result.
STATUS_EVALUATED = "evaluated"
STATUS_PROVIDER_DEGRADED = "provider_degraded"

# The firewall is evaluation-only.  In particular, an explicit correction is a
# gated proposal and never changes the active assertion here.
ACTIVE_TRUTH_UNCHANGED = "unchanged"
