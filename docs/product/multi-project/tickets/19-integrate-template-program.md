# 19: Integrate the template program after its prerequisites
Status: needs-info
Blocked-by: [07, 08]
Needs: Verified predecessor evidence for [07, 08], plus exact implementation files and executable behavior-verification commands recorded before this ticket becomes actionable.
Unlocks: [24, 36]

## Goal

Connect project creation and empty-child composition to the template installer after its held program is released.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own only the workbench wrapper, capability detection, project binding, UI, and wrapper tests. Read [the held template-installer contract](../external-dependencies.md#held-template-installer-program). The external program must finish tickets 01-06. The repository owner must explicitly lift its hold and provide a canonical approved source packet. A compatible template API must exist in an installed artifact.

## Done condition

The wrapper discovers the installed capability and shows the template plan and receipt. It binds the target project, handles recovery, and leaves the workspace usable without the workbench. It contains no copied catalog or template implementation.

## Verify

Run wrapper tests against the template program's installed conformance fixture and failure responses. Prove missing or held capability disables the UI without changing project state.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
