# 07: Implement new-project planning and creation
Type: outcome
Status: planned
Blocked-by: [03, 06]
Unlocks: [09, 13, 19, 24]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Create blank Vivary projects through the GUI and service contract while keeping VCS, hosting, and templates independent choices.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own new-project service and UI. Reuse `scaffold_thin_workspace`, dry-run output, Doctor, and Tropo checks from `packages/create-vivary`. Read `design.md`, `evidence.md`, and the creation guide. Do not duplicate init rules.

## Done condition

A user previews the exact target and files, applies a bound plan, verifies the workspace, and registers it. A crash or repeated request does not create a duplicate project. VCS and hosting can remain `none`.

## Verify

Run service and browser tests for blank creation, occupied target refusal, changed plan input, interruption, retry, and registration. Run Doctor and Tropo against the result.


Run the [canonical common planning checks](../execution-contract.md#maintaining-the-graph)
after changing this outcome's metadata. These checks validate planning documents;
they do not prove the behavior above.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
