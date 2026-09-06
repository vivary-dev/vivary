# 28: Review deferred legacy retirement per item
Type: outcome
Status: planned
Blocked-by: [27]
Unlocks: []

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Present each HarnessMax and Littleagent legacy item for a later keep, adapt, archive, redirect, rename, or delete decision after preservation and release proof.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own only the retirement inventory and per-item receipts in `migration.md`. Read the reorg procedure before any future action. External dependency: The repository owner must choose and authorize each local removal, remote archive or delete, redirect, launcher change, and repository rename separately.

## Done condition

Every item has preservation evidence, restore proof, current owner, dependencies, proposed action, and exact authority. Deferred or rejected items remain untouched. No batch approval is inferred.

## Verify

Recheck roots, worktrees, remotes, dirty state, unpushed commits, issues, releases, deployments, links, automations, and saved memory before presenting actions. Execute nothing until the matching per-item approval exists.


Run the [canonical common planning checks](../execution-contract.md#maintaining-the-graph)
after changing this outcome's metadata. These checks validate planning documents;
they do not prove the behavior above.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
