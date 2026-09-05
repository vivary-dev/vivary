# 15: Deliver editable plans and dependency-aware kanban
Status: needs-info
Blocked-by: [05, 12, 14]
Needs: Verified predecessor evidence for [05, 12, 14], plus exact implementation files and executable behavior-verification commands recorded before this ticket becomes actionable.
Unlocks: [16, 17, 20, 21, 24, 29]

## Goal

Deliver visual planning, revision authority, dependencies, and kanban views over the selected task source.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own plan and board application services, UI, and tests. Read Littleagent S-02 and S-03. Preserve revision-bound execution authority and show the active project, task source, and plan revision.

## Done condition

Users can draft, compare, approve, and supersede plans. The board shows dependency state and source ownership. Execution refuses a stale or unapproved plan revision.

## Verify

Run browser and contract tests for plan revision changes, dependency cycles, external-source refresh, stale approval, and project switching.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
