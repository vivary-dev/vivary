# 29: Deliver review, conditional integration, and portable handoffs
Type: outcome
Status: planned
Blocked-by: [04, 11, 12, 14, 15, 16, 17]
Unlocks: [20, 23, 24, 36]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Review actual changes and evidence, integrate through the selected VCS capability, and export portable handoffs.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own review UI, integration adapters, handoff format, and tests. Read Littleagent S-07 and ticket 17 receipts. Reuse runtime evidence and VCS capabilities. No-VCS projects receive conflict-aware patches rather than invented merge behavior.

## Done condition

Review shows actual diffs or no-VCS patches, evidence, failures, and unresolved conflicts. Integration follows the selected VCS owner. Handoffs preserve project, task, plan, runtime, receipt, and unsupported next steps.

Independently invoke QA against a frozen candidate, identified by a content snapshot or supported VCS revision including dirty content. QA has read-only access to that artifact and separate writable scratch. Its versioned report maps every acceptance claim to cited observations and a verified or gap status; absent evidence stays a gap. Bind report, records, plan, candidate, and QA invocation together. Include relevant ordinary-user behavior and source/runtime inspection. QA cannot repair or integrate its candidate; repairs create another candidate. Reuse existing receipts and add only the missing claim-level mapping; do not reinterpret the legacy all-checks receipt as this richer report.

## Verify

Reject foreign/stale candidate records, missing claim observations, attempted QA repair, and an all-green unit suite that lacks the required user-visible evidence. Exercise the no-VCS snapshot path and ensure handoffs retain both verified behaviors and unresolved gaps.

Run review rejection, stale diff, no-VCS patch, Git worktree, Jujutsu capability, integration failure, handoff export, and handoff import tests.


Run the [canonical common planning checks](../execution-contract.md#maintaining-the-graph)
after changing this outcome's metadata. These checks validate planning documents;
they do not prove the behavior above.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.

- 2026-09-05: Refined acceptance after the owner-requested [HoH comparison](../research/hoh-alignment.md). These criteria remain unimplemented and unverified.
