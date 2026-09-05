# 16: Run verified workers and account for costs
Status: needs-info
Blocked-by: [04, 10, 12, 14, 15]
Needs: Verified predecessor evidence for [04, 10, 12, 14, 15], plus exact implementation files and executable behavior-verification commands recorded before this ticket becomes actionable.
Unlocks: [17, 20, 21, 24, 29, 36]

## Goal

Run bounded workers in the correct project and execution location, then show evidence, intervention, completion, latency, token use, and cost without invented enforcement.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own worker orchestration through supported runtime APIs, verification receipts, usage accounting, and UI. Read Littleagent S-04, S-05, and S-13. Resource-profile prose does not enforce sandbox or budget limits.

## Done condition

A worker cannot start without project, runtime, execution location, authority, plan revision, and verification target. The result separates measured usage from configured limits and unsupported enforcement.

## Verify

Run deterministic policy fixtures and approved no-cost runtime tasks. Reconcile reported usage with runtime receipts. Test cancellation, timeout, exceeded supported limits, and unavailable enforcement.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
