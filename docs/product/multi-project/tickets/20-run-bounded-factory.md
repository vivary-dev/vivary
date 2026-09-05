# 20: Run bounded factory work
Status: needs-info
Blocked-by: [04, 10, 14, 15, 16, 17, 29]
Needs: Verified predecessor evidence for [04, 10, 14, 15, 16, 17, 29], plus exact implementation files and executable behavior-verification commands recorded before this ticket becomes actionable.
Unlocks: [24, 36]

## Goal

Run Littleagent S-08 and S-09 factory workflows with explicit authority, worker ownership, budgets, stop conditions, verification, and production gates.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own factory coordination, monitoring UI, receipts, and tests. Reuse verified runtime, task, plan, worker, and recovery services. Do not build a second scheduler or task queue.

## Done condition

Factory runs stop at configured boundaries and human gates. Every effect names its worker, project, task, plan, runtime, evidence, and measured cost. Restart and no-progress behavior converge.

## Verify

Run bounded multi-worker fixture scenarios for dependency order, no progress, budget refusal, cancellation, crash recovery, review rejection, and production gate.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
