# 30: Add deterministic heartbeat maintenance
Type: outcome
Status: planned
Blocked-by: [04, 10, 18]
Unlocks: [24, 36]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Implement S-12 heartbeat and maintenance work with deterministic no-op checks, notification policy, stop, and recovery.

## Context

Read [the native owner inventory](../native-owners.md) before adding any run, session, task, plan, messaging, scheduler, or resource infrastructure.

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own maintenance definitions, scheduler integration through the selected framework owner, notification policy, UI, and tests. Read Littleagent S-12. Ticket 22 owns email intake. Scheduling an external job or changing an account remains an exact gate.

## Done condition

Unchanged state produces no effect or routine notification. Meaningful change, failure, completion, or required action produces a bounded report. Operators can inspect, stop, retry, and resume.

## Verify

Run no-op, changed-state, duplicate tick, reordered tick, crash, retry, stop, resume, and notification-policy tests without creating a live scheduled job.


Run the [canonical common planning checks](../execution-contract.md#maintaining-the-graph)
after changing this outcome's metadata. These checks validate planning documents;
they do not prove the behavior above.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.

- 2026-09-06: The outer loop's runner belongs here, per [the alignment brief](../research/hoh-direction-brief.md): consolidate new traces into patterns by patch, draft at most one proposal, and run its named execution check. An unchanged trace count is a no-op. A shared-skill or instruction change stops at `ready-for-human` with the verbatim diff, never an automatic apply. Each run leaves a receipt. Unimplemented and unverified.
