# 23: Package and prove installed application behavior
Status: needs-info
Blocked-by: [09, 10, 13, 29]
Needs: Verified predecessor evidence for [09, 10, 13, 29], plus exact implementation files and executable behavior-verification commands recorded before this ticket becomes actionable.
Unlocks: [24, 25, 26, 27]

## Goal

Produce installable application artifacts and prove that packaged behavior matches source behavior across supported platforms and headless entry points.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own app manifests, packaging, installers, artifact checks, and installed smoke fixtures. Read `release.md` and the existing Vivary release workflow. Pin dependencies through the repository's security process.

## Done condition

Clean environments can install, open, upgrade, and remove the app as documented. Installed GUI and headless operations use the same contracts. Artifacts carry versions, licenses, and provenance.

## Verify

Build exact artifacts in the prescribed project environment. Run package checks and installed smokes on supported platforms. Record platform gaps without claiming coverage.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
