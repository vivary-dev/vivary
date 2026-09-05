# 12: Implement none, Git, and Jujutsu identity adapters
Status: needs-info
Blocked-by: [03, 06]
Needs: Verified predecessor evidence for [03, 06], plus exact implementation files and executable behavior-verification commands recorded before this ticket becomes actionable.
Unlocks: [13, 14, 15, 16, 17, 29]

## Goal

Report and operate within the selected VCS mode while assigning one mutation owner for no-VCS, Git, Git worktree, monorepo, and colocated Jujutsu cases.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own VCS capability adapters and fixtures. Read `design.md` filesystem rules and Jujutsu evidence. Keep repository host behavior in ticket 13. Unsupported layouts remain read-only or external-tool paths.

## Done condition

Detection distinguishes no VCS, Git repository, linked worktree, shared monorepo, Jujutsu workspace, and colocated Jujutsu. The adapter exposes only proven operations and serializes shared repository mutation.

## Verify

Run fixture tests for every layout, nested project roots, shared common directories, dirty state, detached state, and ambiguous ownership. Verify the no-VCS path never promises branch or merge rollback.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
