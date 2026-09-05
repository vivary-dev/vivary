# 30: Add deterministic heartbeat maintenance
Status: needs-info
Blocked-by: [04, 10, 18]
Needs: Verified predecessor evidence for [04, 10, 18], plus exact implementation files and executable behavior-verification commands recorded before this ticket becomes actionable.
Unlocks: [24, 36]

## Goal

Implement S-12 heartbeat and maintenance work with deterministic no-op checks, notification policy, stop, and recovery.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own maintenance definitions, scheduler integration through the selected framework owner, notification policy, UI, and tests. Read Littleagent S-12. Ticket 22 owns email intake. Scheduling an external job or changing an account remains an exact gate.

## Done condition

Unchanged state produces no effect or routine notification. Meaningful change, failure, completion, or required action produces a bounded report. Operators can inspect, stop, retry, and resume.

## Verify

Run no-op, changed-state, duplicate tick, reordered tick, crash, retry, stop, resume, and notification-policy tests without creating a live scheduled job.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
