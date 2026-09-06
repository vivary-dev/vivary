# 13: Connect optional repository hosts
Type: outcome
Status: planned
Blocked-by: [07, 12]
Unlocks: [23, 27]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Add separate, skippable GitHub, Gitea or custom-remote connections without making a host part of project identity.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own repository-host connection contracts, plan previews, UI, and tests. Read `design.md`. Reuse Agent-Native connections only after version-matched proof. Remote creation, visibility, and initial push remain exact human gates.

## Done condition

The UI shows host, account or organization, remote name, visibility, local path, and initial-push intent. Local-only and custom remote paths work. No external write occurs before its own approval.

## Verify

Run local fake-host and custom-remote tests. For live proof, stop at a ready-for-human action that names the exact remote creation or push. Record the approved result without credentials.


Run the [canonical common planning checks](../execution-contract.md#maintaining-the-graph)
after changing this outcome's metadata. These checks validate planning documents;
they do not prove the behavior above.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
