# 05: Integrate the preserved workbench shell
Status: needs-info
Blocked-by: [02, 03]
Needs: Verified predecessor evidence for [02, 03], plus exact implementation files and executable behavior-verification commands recorded before this ticket becomes actionable.
Unlocks: [06, 11, 15, 18, 24]

## Goal

Place preserved Littleagent workbench source in the selected Vivary app package with provenance and a buildable shell.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own only the new app package, its provenance record, and package-local tests. Read tickets 01-03, `design.md`, `migration.md`, Littleagent S-01, design docs, and accessibility findings. Reuse accepted source slices instead of rewriting the shell.

## Done condition

The app opens with project navigation, task and session regions, conversation, and expandable work panels. It labels planned or unsupported controls accurately. The provenance receipt maps imported files to source hashes.

## Verify

Run the package build, unit tests, and a browser smoke from an isolated project environment. Compare the shell against the accepted S-01 layout and accessibility contract.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
