# 18: Add optional Brain and reviewed learning
Type: outcome
Status: planned
Blocked-by: [03, 05]
Unlocks: [21, 22, 24, 30, 36]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Offer an optional Brain and a sourced project-scoped learning loop with review, correction, rejection, export, and documented deletion limits.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own Brain setup, project bindings, learning proposals, review UI, and tests. Read `design.md`, current second-brain and semantic-memory docs, and migration privacy constraints. Default scope is the originating project.

## Done condition

A user can skip Brain. Accepted setup keeps source files authoritative. Lessons carry evidence and scope. No proposal changes skills, instructions, or authority without review. Cross-project promotion requires explicit selection.

Project evidence continuity works with Brain disabled. Brain adds optional retrieval and reviewed promotion across scopes; it does not own acceptance or authorize changes to model, tools, policy, instructions, or skills.

## Verify

Complete a project evidence-to-next-plan handoff with Brain disabled and verify no Brain connection or permission is requested.

Run tests for skipped setup, project-scoped retrieval, private-source exclusion, conflicting lesson, reject, accept, rollback, export, and deletion-limit disclosure.


Run the [canonical common planning checks](../execution-contract.md#maintaining-the-graph)
after changing this outcome's metadata. These checks validate planning documents;
they do not prove the behavior above.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.

- 2026-09-05: Refined acceptance after the owner-requested [HoH comparison](../research/hoh-alignment.md). These criteria remain unimplemented and unverified.

- 2026-09-06: Owner decision: the learning loop is WikiSkill-shaped, per [the direction decision](../design.md#direction-decision-2026-09-06) and [the alignment brief](../research/hoh-direction-brief.md). Acceptance adds four record kinds with distinct write rules (trace write-once, pattern patch-only with a rejection counter and quarantine, proposal as one atomic diff naming its check, impact ledger append-only with the verbatim diff and verdict), working agents receive skills and a short index rather than the pattern corpus, cross-project promotion carries procedures and checks only, a bounded active set with outcome-driven retirement, and revocation of a lesson that fresh evidence contradicts. Unimplemented and unverified.
