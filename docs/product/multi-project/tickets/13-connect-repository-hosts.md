# 13: Connect optional repository hosts
Status: needs-info
Blocked-by: [07, 12]
Needs: Verified predecessor evidence for [07, 12], plus exact implementation files and executable behavior-verification commands recorded before this ticket becomes actionable.
Unlocks: [23, 27]

## Goal

Add separate, skippable GitHub, Gitea or custom-remote connections without making a host part of project identity.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own repository-host connection contracts, plan previews, UI, and tests. Read `design.md`. Reuse Agent-Native connections only after version-matched proof. Remote creation, visibility, and initial push remain exact human gates.

## Done condition

The UI shows host, account or organization, remote name, visibility, local path, and initial-push intent. Local-only and custom remote paths work. No external write occurs before its own approval.

## Verify

Run local fake-host and custom-remote tests. For live proof, stop at a ready-for-human action that names the exact remote creation or push. Record the approved result without credentials.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
