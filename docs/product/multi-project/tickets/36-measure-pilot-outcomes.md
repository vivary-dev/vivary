# 36: Measure the S-13 pilot outcomes
Type: outcome
Status: planned
Blocked-by: [10, 16, 17, 18, 19, 20, 21, 22, 29, 30]
Unlocks: [24, 27]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Run a bounded pilot and measure intervention, completion, latency, usage, cost, recovery, and user outcomes across the implemented workbench.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own the pilot protocol, consent and privacy notes, frozen task set, measurement definitions, raw receipts, and report. Read Littleagent S-13 and `release.md`. Do not use follower counts or adoption promises as product evidence. Paid runtime use requires separate approval.

## Done condition

The report separates measured values from inference, records failures and interventions, names the exact versions and settings, and preserves participant privacy. It states what the pilot cannot prove.

## Verify

Run the frozen pilot protocol with approved no-cost resources or stop at the exact paid-runtime gate. Recompute metrics from raw receipts and have a reviewer trace each reported value.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.

- 2026-09-05: Preserve unresolved earlier dogfood, tutorial, and token-savings benchmark requirements through [the issue authority map](../issue-authority.md). Pilot cost metrics do not replace the separate comparative token-savings protocol.
