# 21: Add research specialists and evaluation
Type: outcome
Status: planned
Blocked-by: [04, 15, 16, 18]
Unlocks: [24, 36]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Preserve Littleagent S-10 research roles with sourced evidence, bounded delegation, and measured comparison against a nondelegated baseline.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own research role contracts, citation records, evaluation fixtures, and UI. Read S-10 and its source research. Use optional Brain only through ticket 18 contracts. Paid models require separate approval.

## Done condition

Research output binds claims to sources and distinguishes known, inferred, and missing evidence. Evaluation records task set, settings, latency, cost, quality checks, and intervention.

## Verify

Run concealed fixture tasks with and without delegation using approved no-cost runtimes. Verify citation links, deterministic fields, and recorded comparison limits.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
