# 28: Review deferred legacy retirement per item
Status: needs-info
Blocked-by: [27]
Needs: Verified predecessor evidence for [27], plus exact implementation files and executable behavior-verification commands recorded before this ticket becomes actionable.
Unlocks: []

## Goal

Present each HarnessMax and Littleagent legacy item for a later keep, adapt, archive, redirect, rename, or delete decision after preservation and release proof.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own only the retirement inventory and per-item receipts in `migration.md`. Read the reorg procedure before any future action. External dependency: The repository owner must choose and authorize each local removal, remote archive or delete, redirect, launcher change, and repository rename separately.

## Done condition

Every item has preservation evidence, restore proof, current owner, dependencies, proposed action, and exact authority. Deferred or rejected items remain untouched. No batch approval is inferred.

## Verify

Recheck roots, worktrees, remotes, dirty state, unpushed commits, issues, releases, deployments, links, automations, and saved memory before presenting actions. Execute nothing until the matching per-item approval exists.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
