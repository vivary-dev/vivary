# 31: Implement authentication discovery and protected-resource flow
Status: needs-info
Blocked-by: [26]
Needs: Verified predecessor evidence for [26], plus exact implementation files and executable behavior-verification commands recorded before this ticket becomes actionable.
Unlocks: [27, 33, 34, 35]

## Goal

Implement real authentication and scoped authorization for selected protected public operations, then publish matching discovery metadata.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own OAuth authorization-server metadata, protected-resource metadata, Auth documentation, scope enforcement, and negative tests. Read `release.md`. Reuse actual Agent-Native auth and connection capabilities only after version-matched proof. External dependency: The repository owner must choose the auth service and approve account or security changes.

## Done condition

Discovery points to working endpoints. Tokens enforce declared scopes and resource boundaries. Public operations remain usable without fabricated login requirements. Metadata reveals no private workspace or credential data.

## Verify

Run metadata validation, authorization-code or selected flow tests, expired and wrong-scope cases, resource-boundary cases, and direct staging requests. Record external security changes only after approval.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
