# 09: Preserve standalone and headless operation parity
Status: needs-info
Blocked-by: [04, 07, 08]
Needs: Verified predecessor evidence for [04, 07, 08], plus exact implementation files and executable behavior-verification commands recorded before this ticket becomes actionable.
Unlocks: [23, 24]

## Goal

Keep existing Vivary commands and structured project operations usable without the GUI, registry daemon, account, or network.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own headless application entry points, parity fixtures, and command docs. Read the static router in `packages/vivary/vivary_cli.py`, `design.md`, and tickets 04, 07, and 08. Avoid changing existing command meanings to fit the GUI.

## Done condition

Every supported GUI project operation has a deterministic headless contract. Existing `vivary`, `create-vivary`, Tropo, Strato, Ozone, and Exo flows retain characterized behavior.

## Verify

Run existing command characterization suites plus GUI-to-headless parity fixtures from installed artifacts. Prove the GUI process can remain closed.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
