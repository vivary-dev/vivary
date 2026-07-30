"""Context-budget repair proposals (#10, Ozone; carries upstream vivary#147
intent verbatim). Report-only by construction: every entry names a target,
carries requires_gate: True, and nothing here writes anything - applying a
proposal is a separate, explicitly human-gated step Ozone does not take.
Token-savings figures are always labeled "approximate" (a rough
chars-per-token heuristic over lengths only, never over content). A
duplicate-routing proposal cites both checkout ids and justifies which one
the estimate treats as the owner - never a raw filesystem path, never claim
text, only opaque node ids and counts, mirroring src/router/propose.mjs's
"no path echo" law even though this module does not import it.

Reference-guided Python port of src/verify/repair.mjs (graduation slice 4,
Ozone; decision 0008). The Node module is the frozen executable oracle:
every function here must reproduce it exactly, including the bounded #68
pairwise-dedupe algorithm (MAX_DEDUPE_CHECKOUTS) and its exact constant.

Language mapping notes specific to this module:
- Node's `[...byRepository.entries()].sort((a, b) => a[0].localeCompare(b[0]))`
  is an EXPLICIT localeCompare on the repository-id map key, mapped to
  ``vivary_core.collation.locale_sort_key`` (not the plain-string UTF-16
  comparator).
- Every OTHER `.sort()` in this module (conflict sides, tiers-cut, the
  per-repository checkout list) is a plain, comparator-less JS string sort -
  UTF-16 code-unit order - mapped to ``vivary_core.canonical._utf16_sort_key``,
  the same rule python/README.md documents for the rest of this port.
- Every dict this module returns is fingerprinted via
  ``vivary_core.canonical.fingerprint``, which canonicalizes with sorted
  keys - so, unlike ``capsule_digest.py``, Python dict insertion order here
  never affects the emitted bytes; key order below still mirrors the Node
  object literals for readability, not correctness.
"""

from __future__ import annotations

import math

from vivary_core.canonical import _utf16_sort_key, deterministic_id, fingerprint as compute_fingerprint
from vivary_core.collation import locale_sort_key

REPAIR_PROPOSAL_SCHEMA = "vivary.context-repair-proposal/v0"

REPAIR_KINDS = {
    "OPEN_FIRST": "open_first",
    "SPLIT": "split",
    "DEDUPLICATE": "deduplicate",
    "ROUTE_THROUGH_INDEX": "route_through_index",
}

# Rough, clearly-labeled heuristics. Every number these produce carries
# estimate_quality: "approximate" and must never be read as a billing-grade
# figure - they exist to rank proposals, not to promise a token count.
CHARS_PER_TOKEN = 4
AVG_OMITTED_CLAIM_TOKENS = 12

# Cardinality cap for pairwise deduplicate proposals (#68/#63): one
# duplicate-routing proposal per duplicating checkout *pair* means a
# repository group of k same-origin checkouts costs C(k,2) - by k~=1500 the
# compiled proposal body's canonical-JSON fingerprinting throws (Node:
# `RangeError: Invalid string length`). Only the first MAX_DEDUPE_CHECKOUTS
# checkouts (sorted, so the choice is deterministic regardless of input
# order) are considered for pairwise dedupe per repository; set well above
# every pinned same-origin group size in this repo's tests (10, 200) and far
# below the measured crash boundary, so ordinary and even sizeable
# workspaces are entirely unaffected and only pathological same-origin
# groups are ever capped.
MAX_DEDUPE_CHECKOUTS = 300


def _approx_tokens_from_chars(char_count):
    return max(1, math.ceil(char_count / CHARS_PER_TOKEN))


def _checkouts_by_repository(graph):
    grouped = {}
    edges = graph.get("edges")
    for edge in edges if edges is not None else []:
        if edge.get("kind") != "checkout_of":
            continue
        group = grouped.get(edge.get("to"))
        if group is None:
            group = []
            grouped[edge.get("to")] = group
        group.append(edge.get("from"))
    return grouped


def _conflict_side_pairs_by_repository(graph):
    """Index unordered checkout pairs by their conflict repository.

    Dedupe must not choose a winner for either side of a divergent checkout
    conflict. Build this index once so each repository's pair scan can use
    its own conflict set without repeatedly traversing the complete graph.
    """
    pairs_by_repository = {}
    conflicts = graph.get("conflicts")
    for conflict in conflicts if conflicts is not None else []:
        repository_id = conflict.get("repository")
        pairs = pairs_by_repository.get(repository_id)
        if pairs is None:
            pairs = set()
            pairs_by_repository[repository_id] = pairs
        raw_sides = conflict.get("sides")
        sides = sorted(
            (side.get("checkout") for side in (raw_sides if raw_sides is not None else [])),
            key=_utf16_sort_key,
        )
        for i in range(len(sides)):
            for j in range(i + 1, len(sides)):
                pairs.add(f"{sides[i]}|{sides[j]}")
    return pairs_by_repository


def _claims_by_subject(capsule):
    grouped = {}
    claims = capsule.get("claims")
    for claim in claims if claims is not None else []:
        subject = claim.get("subject")
        group = grouped.get(subject)
        if group is None:
            group = []
            grouped[subject] = group
        group.append(claim)
    return grouped


def propose_context_repairs(*, capsule, graph):
    """Propose context-budget repairs over a compiled Task Capsule and the
    workspace graph it was compiled from. Pure projection: report-only, zero
    writes, every proposal requires_gate: True.

    capsule  compiled Task Capsule
    graph    the workspace graph the capsule was compiled from
    """
    proposals = []
    withheld = []
    omissions = []

    # -- open_first: the weakest-relevance, weakest-evidenced claims are
    # candidates to defer (open their source on demand) instead of
    # pre-expanding them into every capsule.
    claims_in = capsule.get("claims")
    for claim in claims_in if claims_in is not None else []:
        selection = claim.get("selection")
        tier = selection.get("tier") if isinstance(selection, dict) else None
        if tier != "allowlisted":
            continue
        evidence = claim.get("evidence")
        evidence = evidence if evidence is not None else []
        if len(evidence) > 0:
            continue
        claim_text = claim.get("claim")
        claim_chars = len(claim_text) if isinstance(claim_text, str) else 0
        proposals.append(
            {
                "id": deterministic_id("repair", {"kind": REPAIR_KINDS["OPEN_FIRST"], "claim": claim.get("id")}),
                "kind": REPAIR_KINDS["OPEN_FIRST"],
                "status": "proposed",
                "target": claim.get("id"),
                "purpose": (
                    "claim carries the weakest relevance tier ('allowlisted') and cites no evidence; "
                    "open its source on demand instead of pre-expanding it into every capsule"
                ),
                "evidence": [claim.get("id")],
                "requires_gate": True,
                "estimate": {"token_savings": _approx_tokens_from_chars(claim_chars), "estimate_quality": "approximate"},
            }
        )

    # -- split: an over-budget capsule is a candidate to split into narrower,
    # per-subject tasks instead of raising the budget. Omitted-claim identity
    # is rehashed through deterministic_id so the proposal can cite what was
    # cut without echoing the subject_path the omission itself carries.
    omissions_in = capsule.get("omissions")
    over_budget = next(
        (o for o in (omissions_in if omissions_in is not None else []) if o.get("kind") == "claims_over_budget"),
        None,
    )
    if over_budget is not None:
        omitted_entries = over_budget.get("omitted")
        omitted_entries = omitted_entries if omitted_entries is not None else []
        omitted_ids = [
            deterministic_id("omitted-claim", {"subject_path": entry.get("subject_path"), "fact": entry.get("fact")})
            for entry in omitted_entries
        ]
        tiers_cut = sorted(dict.fromkeys(entry.get("tier") for entry in omitted_entries), key=_utf16_sort_key)
        proposals.append(
            {
                "id": deterministic_id("repair", {"kind": REPAIR_KINDS["SPLIT"], "capsule": capsule.get("capsule_id")}),
                "kind": REPAIR_KINDS["SPLIT"],
                "status": "proposed",
                "target": capsule.get("capsule_id"),
                "purpose": (
                    f"capsule cut {over_budget.get('omitted_count')} claim(s) at the budget boundary"
                    + (f" (tiers cut: {', '.join(tiers_cut)})" if len(tiers_cut) > 0 else "")
                    + "; propose splitting the task into narrower per-subject questions instead of widening the budget"
                ),
                "evidence": [capsule.get("capsule_id"), "omission:claims_over_budget", *omitted_ids],
                "requires_gate": True,
                "estimate": {
                    "token_savings": over_budget.get("omitted_count") * AVG_OMITTED_CLAIM_TOKENS,
                    "estimate_quality": "approximate",
                },
            }
        )

    # -- deduplicate / route_through_index: repositories with more than one
    # checkout contributing claims to this capsule.
    by_repository = _checkouts_by_repository(graph)
    by_subject = _claims_by_subject(capsule)
    conflict_pairs_by_repository = _conflict_side_pairs_by_repository(graph)

    for repository_id, checkouts in sorted(by_repository.items(), key=lambda kv: locale_sort_key(kv[0])):
        if len(checkouts) < 2:
            continue
        conflict_pairs = conflict_pairs_by_repository.get(repository_id)
        sorted_checkouts = sorted(checkouts, key=_utf16_sort_key)

        repository_claim_count = 0
        for checkout_id in sorted_checkouts:
            repository_claim_count += len(by_subject.get(checkout_id) or [])

        # Pairwise dedupe scanning is capped (see MAX_DEDUPE_CHECKOUTS
        # above); everything else about this repository group
        # (repository_claim_count, route_through_index eligibility) still
        # sees every checkout.
        considered_checkouts = (
            sorted_checkouts[:MAX_DEDUPE_CHECKOUTS] if len(sorted_checkouts) > MAX_DEDUPE_CHECKOUTS else sorted_checkouts
        )

        if len(considered_checkouts) < len(sorted_checkouts):
            total_pairs = len(sorted_checkouts) * (len(sorted_checkouts) - 1) // 2
            considered_pairs = len(considered_checkouts) * (len(considered_checkouts) - 1) // 2
            omissions.append(
                {
                    "kind": "dedupe_pairs_capped",
                    "repository": repository_id,
                    "reason": (
                        f"repository has {len(sorted_checkouts)} checkouts sharing one origin; pairwise deduplicate "
                        f"scanning is capped at {MAX_DEDUPE_CHECKOUTS} checkouts to stay bounded"
                    ),
                    "considered_checkouts": len(considered_checkouts),
                    "total_checkouts": len(sorted_checkouts),
                    "omitted_checkout_count": len(sorted_checkouts) - len(considered_checkouts),
                    "omitted_pair_count": total_pairs - considered_pairs,
                }
            )

        for i in range(len(considered_checkouts)):
            a = considered_checkouts[i]
            a_claims = by_subject.get(a) or []
            for j in range(i + 1, len(considered_checkouts)):
                b = considered_checkouts[j]
                b_claims = by_subject.get(b) or []
                b_claim_by_fact = {}
                for c in b_claims:
                    b_claim_by_fact[c.get("fact")] = c
                # A "duplicate" is the same fact *and* the same asserted
                # value - two checkouts genuinely saying the same thing.
                # Same fact name with different values (e.g. one checkout
                # dirty, the other clean) is not duplication; there is
                # nothing to dedupe and no owner to justify.
                duplicate_pairs = []
                for claim_a in a_claims:
                    claim_b = b_claim_by_fact.get(claim_a.get("fact"))
                    if claim_b and claim_a.get("claim") == claim_b.get("claim"):
                        duplicate_pairs.append((claim_a, claim_b))
                if len(duplicate_pairs) == 0:
                    continue

                if conflict_pairs and f"{a}|{b}" in conflict_pairs:
                    withheld.append(
                        {"kind": REPAIR_KINDS["DEDUPLICATE"], "repository": repository_id, "sides": [a, b], "reason": "conflict_unresolved"}
                    )
                    continue

                for claim_a, claim_b in duplicate_pairs:
                    fact = claim_a.get("fact")
                    evidence_a = claim_a.get("evidence")
                    evidence_b = claim_b.get("evidence")
                    evidence_count_a = len(evidence_a) if evidence_a is not None else 0
                    evidence_count_b = len(evidence_b) if evidence_b is not None else 0
                    if evidence_count_a == evidence_count_b:
                        owner = None
                    elif evidence_count_a > evidence_count_b:
                        owner = a
                    else:
                        owner = b
                    claim_text = claim_a.get("claim")
                    proposals.append(
                        {
                            "id": deterministic_id(
                                "repair",
                                {"kind": REPAIR_KINDS["DEDUPLICATE"], "repository": repository_id, "sides": [a, b], "fact": fact},
                            ),
                            "kind": REPAIR_KINDS["DEDUPLICATE"],
                            "status": "proposed",
                            "target": repository_id,
                            "purpose": (
                                f"checkouts {a} and {b} of the same repository both carry a claim for '{fact}'; "
                                "route the fact through one owning checkout instead of duplicating it in the capsule"
                            ),
                            "evidence": [claim_a.get("id"), claim_b.get("id")],
                            "cites": [a, b],
                            "ownership": {
                                "subject": owner,
                                "basis": "more_evidence_citations" if owner else "tie_no_preference",
                            },
                            "requires_gate": True,
                            "estimate": {
                                "token_savings": _approx_tokens_from_chars(len(claim_text) if isinstance(claim_text, str) else 0),
                                "estimate_quality": "approximate",
                            },
                        }
                    )

        # A structural escalation over pairwise dedupe: only worth proposing
        # once the capsule is actually under budget pressure and this one
        # repository is a meaningful share of it.
        if over_budget is not None and repository_claim_count >= 3:
            proposals.append(
                {
                    "id": deterministic_id("repair", {"kind": REPAIR_KINDS["ROUTE_THROUGH_INDEX"], "repository": repository_id}),
                    "kind": REPAIR_KINDS["ROUTE_THROUGH_INDEX"],
                    "status": "proposed",
                    "target": "modules/index.md",
                    "purpose": (
                        f"repository {repository_id} contributes {repository_claim_count} claim(s) across "
                        f"{len(checkouts)} checkouts under budget pressure; route its recurring facts through a "
                        "persisted index entry instead of re-deriving them every capsule"
                    ),
                    "evidence": [repository_id, *sorted_checkouts],
                    "requires_gate": True,
                    "estimate": {
                        "token_savings": repository_claim_count * AVG_OMITTED_CLAIM_TOKENS,
                        "estimate_quality": "approximate",
                    },
                }
            )

    body = {
        "schema": REPAIR_PROPOSAL_SCHEMA,
        "capsule": {"id": capsule.get("capsule_id"), "fingerprint": capsule.get("fingerprint")},
        "proposals": proposals,
        "withheld": withheld,
    }
    # Only present when the cardinality cap actually engaged, so a normal
    # (uncapped) capsule's proposal body stays byte-identical to before #68 -
    # no shape change at ordinary scale, mirroring capsule.omissions' own
    # report-only discipline at the scale where it actually applies.
    if len(omissions) > 0:
        body["omissions"] = omissions
    body["writes_performed"] = 0
    body["requires_gate"] = len(proposals) > 0

    return {**body, "fingerprint": compute_fingerprint(body)}
