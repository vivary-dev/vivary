# 08: Implement existing-project adoption
Status: needs-info
Blocked-by: [03, 06]
Needs: Verified predecessor evidence for [03, 06], plus exact implementation files and executable behavior-verification commands recorded before this ticket becomes actionable.
Unlocks: [09, 11, 19, 24]

## Goal

Expose the existing brownfield plan, approval hash, apply, conflict, and recovery behavior without changing registration-only workflows.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own adoption service and GUI. Reuse `plan_adopt` and `adopt_workspace` from `packages/create-vivary`. Read the adoption guide and `evidence.md`. Keep all user content outside managed blocks.

## Done condition

The GUI shows creates, patches, optional projections, kept files, conflicts, privacy state, and plan hash. Apply requires the matching approved hash. Registration remains byte-for-byte read-only.

## Verify

Run adoption tests for clean apply, conflict, changed input, interrupted transaction, recovery, and registration without adoption. Compare host-file bytes outside managed blocks.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
