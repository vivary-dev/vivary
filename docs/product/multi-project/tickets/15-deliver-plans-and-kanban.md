# 15: Deliver editable plans and dependency-aware kanban
Type: outcome
Status: planned
Blocked-by: [05, 12, 14]
Unlocks: [16, 17, 20, 21, 24, 29]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Deliver visual planning, revision authority, dependencies, and kanban views over the selected task source.

## Context

Read [the native owner inventory](../native-owners.md) before adding any run, session, task, plan, messaging, scheduler, or resource infrastructure.

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own plan and board application services, UI, and tests. Read Littleagent S-02 and S-03. Preserve revision-bound execution authority and show the active project, task source, and plan revision.

## Done condition

Users can draft, compare, approve, and supersede plans. The board shows dependency state and source ownership. Execution refuses a stale or unapproved plan revision.

A development document names one observable increment, the preceding QA evidence reference, behaviors to preserve, gaps to address, and acceptance observations. Explain the capability added or restored; record why a repair-only or prerequisite increment is necessary. Planning reads the artifact without modifying it. Missing or contradictory evidence remains visible and cannot silently become a verified claim.

## Verify

Feed a prior report with one verified behavior and one gap into replanning. Assert preservation, a concrete next target, and its verification requirement survive restart and plan revision. Verify the same path with Brain disabled.

Run browser and contract tests for plan revision changes, dependency cycles, external-source refresh, stale approval, and project switching.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.

- 2026-09-05: Refined acceptance after the owner-requested [HoH comparison](../research/hoh-alignment.md). These criteria remain unimplemented and unverified.
