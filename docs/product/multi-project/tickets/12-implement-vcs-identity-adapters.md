# 12: Implement none, Git, and Jujutsu identity adapters
Type: outcome
Status: planned
Blocked-by: [03, 06]
Unlocks: [13, 14, 15, 16, 17, 29]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Report and operate within the selected VCS mode while assigning one mutation owner for no-VCS, Git, Git worktree, monorepo, and colocated Jujutsu cases.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own VCS capability adapters and fixtures. Read `design.md` filesystem rules and Jujutsu evidence. Keep repository host behavior in ticket 13. Unsupported layouts remain read-only or external-tool paths.

## Done condition

Detection distinguishes no VCS, Git repository, linked worktree, shared monorepo, Jujutsu workspace, and colocated Jujutsu. The adapter exposes only proven operations and serializes shared repository mutation.

## Verify

Run fixture tests for every layout, nested project roots, shared common directories, dirty state, detached state, and ambiguous ownership. Verify the no-VCS path never promises branch or merge rollback.


Run the [canonical common planning checks](../execution-contract.md#maintaining-the-graph)
after changing this outcome's metadata. These checks validate planning documents;
they do not prove the behavior above.

## Next packet

[12a](../packets/12a-root-vcs-observation-contract.md) is ready after the 03c source mapping. It defines the trusted observation contract and expected oracles only. Production adapter implementation, physical identity probes, and cross-process mutation enforcement remain later work. Outcome completion dependencies do not gate this independent preparation.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
