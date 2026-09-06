# 11: Finish files, drafts, and conflict-safe editing
Type: outcome
Status: planned
Blocked-by: [05, 06, 08]
Unlocks: [17, 24, 29]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Make work panels operate on authorized project files while preserving dirty drafts and external edits.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own file browser, editor, preview, draft persistence, conflict dialog, and tests. Read Littleagent S-01 findings and `migration.md` hazards. Agent-Native personal resources cannot stand in for arbitrary project files.

## Done condition

Drafts survive reload and project switches. External changes and remote deletion produce reviewable conflicts. Saves bind the expected file identity and never overwrite a changed file silently.

## Verify

Run browser tests for reload, project switch, external edit, rename, deletion, save race, unsupported binary, path traversal, and denied root. Compare bytes after each conflict case.


Run the [canonical common planning checks](../execution-contract.md#maintaining-the-graph)
after changing this outcome's metadata. These checks validate planning documents;
they do not prove the behavior above.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
