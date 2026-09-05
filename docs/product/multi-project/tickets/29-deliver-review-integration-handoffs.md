# 29: Deliver review, conditional integration, and portable handoffs
Status: needs-info
Blocked-by: [04, 11, 12, 14, 15, 16, 17]
Needs: Verified predecessor evidence for [04, 11, 12, 14, 15, 16, 17], plus exact implementation files and executable behavior-verification commands recorded before this ticket becomes actionable.
Unlocks: [20, 23, 24, 36]

## Goal

Review actual changes and evidence, integrate through the selected VCS capability, and export portable handoffs.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own review UI, integration adapters, handoff format, and tests. Read Littleagent S-07 and ticket 17 receipts. Reuse runtime evidence and VCS capabilities. No-VCS projects receive conflict-aware patches rather than invented merge behavior.

## Done condition

Review shows actual diffs or no-VCS patches, evidence, failures, and unresolved conflicts. Integration follows the selected VCS owner. Handoffs preserve project, task, plan, runtime, receipt, and unsupported next steps.

## Verify

Run review rejection, stale diff, no-VCS patch, Git worktree, Jujutsu capability, integration failure, handoff export, and handoff import tests.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
