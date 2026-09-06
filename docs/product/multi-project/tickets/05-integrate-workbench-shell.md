# 05: Integrate the preserved workbench shell
Type: outcome
Status: planned
Blocked-by: [02, 03]
Unlocks: [06, 11, 15, 18, 24]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Place preserved Littleagent workbench source in the selected Vivary app package with provenance and a buildable shell.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own only the new app package, its provenance record, and package-local tests. Read tickets 01-03, `design.md`, `migration.md`, Littleagent S-01, design docs, and accessibility findings. Reuse accepted source slices instead of rewriting the shell.

## Done condition

The app opens with project navigation, task and session regions, conversation, and expandable work panels. It labels planned or unsupported controls accurately. The provenance receipt maps imported files to source hashes.

## Verify

Run the package build, unit tests, and a browser smoke from an isolated project environment. Compare the shell against the accepted S-01 layout and accessibility contract.


Run the [canonical common planning checks](../execution-contract.md#maintaining-the-graph)
after changing this outcome's metadata. These checks validate planning documents;
they do not prove the behavior above.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
