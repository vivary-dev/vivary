# 17: Deliver crash recovery and native session resume
Type: outcome
Status: planned
Blocked-by: [04, 11, 12, 14, 15, 16]
Unlocks: [20, 24, 29, 36]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Recover interrupted work and resume native sessions without duplicating completed effects or losing drafts.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own the recovery coordinator, resume UI, replay ledger, and tests. Read Littleagent S-06 and the recovery parts of S-07. Reuse native session state and runtime files. Ticket 29 owns review, integration, and handoffs.

## Done condition

Restart reconstructs the project, task, plan, runtime, session, draft, and verification state. Replay does not repeat completed effects. Unsupported runtime resume states remain explicit.

## Verify

Run crash-point, restart, stale receipt, changed root, cancelled process, partial event stream, and native resume tests. Prove replay does not duplicate completed effects.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
