# 14: Integrate optional task sources without mirroring ownership
Type: outcome
Status: planned
Blocked-by: [03, 12]
Unlocks: [15, 16, 17, 20, 29]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Define one selected task authority per project and read optional Beads or external tracker tasks without silently copying or forking their state.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own task-source interfaces, identity mapping, refresh behavior, and UI labels. Read Littleagent S-02 through S-07, `design.md`, and `migration.md`. Beads stays an external owner when selected. VCS and hosting remain separate.

## Done condition

Local Vivary tasks, Beads, and one generic external source fixture remain distinguishable. Edits route to the authority that owns the task. Unsupported writes stay read-only with a clear external action.

## Verify

Run task identity, refresh, stale revision, duplicate ID, offline, and permission fixtures. Prove no hidden mirror becomes authoritative.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
