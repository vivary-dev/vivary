# 20: Run bounded factory work
Type: outcome
Status: planned
Blocked-by: [04, 10, 14, 15, 16, 17, 29]
Unlocks: [24, 36]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Run Littleagent S-08 and S-09 factory workflows with explicit authority, worker ownership, budgets, stop conditions, verification, and production gates.

## Context

Read [the native owner inventory](../native-owners.md) before adding any run, session, task, plan, messaging, scheduler, or resource infrastructure.

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own factory coordination, monitoring UI, receipts, and tests. Reuse verified runtime, task, plan, worker, and recovery services. Do not build a second scheduler or task queue.

## Done condition

Factory runs stop at configured boundaries and human gates. Every effect names its worker, project, task, plan, runtime, evidence, and measured cost. Restart and no-progress behavior converge.

Each durable iteration binds its input artifact, development document, native developer run, frozen candidate, independent QA report, and resulting artifact. Only the developer writes the artifact; the next planner consumes the prior verified behaviors and gaps. Reuse native dispatch and persistence. Keep iteration, budget, retry, and no-progress bounds explicit. Continue from file/receipt evidence when Brain is disabled; Brain promotion is a separate reviewed operation.

## Verify

Crash between candidate creation, QA, and replanning; recover the exact artifact/report pair without accepting an uncertain result or repeating an effect. Show a failed observation changes the next bounded task and a prior verified behavior remains a preservation constraint.

Run bounded multi-worker fixture scenarios for dependency order, no progress, budget refusal, cancellation, crash recovery, review rejection, and production gate.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.

- 2026-09-05: Refined acceptance after the owner-requested [HoH comparison](../research/hoh-alignment.md). These criteria remain unimplemented and unverified.
