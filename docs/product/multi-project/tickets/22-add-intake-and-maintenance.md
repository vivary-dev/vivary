# 22: Add signed email intake
Status: needs-info
Blocked-by: [04, 10, 18]
Needs: Verified predecessor evidence for [04, 10, 18], plus exact implementation files and executable behavior-verification commands recorded before this ticket becomes actionable.
Unlocks: [24, 36]

## Goal

Implement S-11 email intake with signed inputs, deduplication, explicit routing, and recovery.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own email intake adapters, event routing, intake UI, and tests. Read Littleagent S-11. Ticket 30 owns heartbeat maintenance. Sending email and account changes remain separate gates.

## Done condition

Repeated or replayed messages converge. Invalid signatures fail closed. Routing binds the selected project and authority. Drafting or classifying intake never sends a reply.

## Verify

Run signed fixture, duplicate, reordered, malformed, wrong-project, crash, and retry tests. Use a local mailbox fixture, not a live account.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
