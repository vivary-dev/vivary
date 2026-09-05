# 33: Publish an A2A service and agent card
Type: outcome
Status: planned
Blocked-by: [26, 31]
Unlocks: [27, 35]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Expose a bounded real Vivary agent service through A2A and publish a matching agent card.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own the A2A endpoint, agent card, task lifecycle mapping, authentication binding, cancellation, and tests. Read the current primary A2A specification during implementation. Reuse ticket 26 operations and ticket 31 scopes. Do not wrap metadata around a nonexistent agent.

## Done condition

A conforming client discovers the card and completes one stated operation. Task state, errors, cancellation, authentication, and unsupported operations match the implementation.

## Verify

Run A2A schema and lifecycle tests plus direct staging requests for success, authentication failure, wrong scope, cancellation, and unsupported operation.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
