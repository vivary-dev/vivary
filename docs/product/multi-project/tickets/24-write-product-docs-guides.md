# 24: Write installed docs, guides, and UI help
Status: needs-info
Blocked-by: [05, 07, 08, 09, 10, 11, 15, 16, 17, 18, 19, 20, 21, 22, 23, 29, 30, 36]
Needs: Verified predecessor evidence for [05, 07, 08, 09, 10, 11, 15, 16, 17, 18, 19, 20, 21, 22, 23, 29, 30, 36], plus exact implementation files and executable behavior-verification commands recorded before this ticket becomes actionable.
Unlocks: [25, 26, 27]

## Goal

Document every verified workflow, capability boundary, recovery path, migration step, and support state in canonical docs and in-product help.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own canonical `docs/`, README and changelog updates, app help, and guide verification. Read `release.md` guide inventory. Update behavior docs with their implementation tickets. Do not edit generated site mirrors by hand.

## Done condition

The guide inventory in `release.md` is complete and follows installed behavior. Screens and commands match artifacts. Claims distinguish supported, optional, held, and unavailable behavior.

## Verify

Follow every guide from installed artifacts in isolated fixtures. Run documentation lint, command and package parity checks, link checks, and screenshot verification.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
