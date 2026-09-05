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

## Verify

Run tests for skipped setup, project-scoped retrieval, private-source exclusion, conflicting lesson, reject, accept, rollback, export, and deletion-limit disclosure.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
