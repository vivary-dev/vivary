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

Record artifact versions, model/harness/runtime configuration, role contracts, iteration count, total tokens/time/cost, interventions, regressions, and accepted capabilities. Compare the evidence-fed workflow with a declared baseline under comparable task and resource budgets. Keep private evaluation results out of development inputs; public QA observations may inform later work. Configuration changes define a separate comparison condition. Paper results are motivation, not measured Vivary gains.

## Verify

Trace each reported claim to its tested candidate and raw observations. Audit evaluator isolation, budget differences, failures, and missing data before making comparative claims.

Run the frozen pilot protocol with approved no-cost resources or stop at the exact paid-runtime gate. Recompute metrics from raw receipts and have a reviewer trace each reported value.


Run the [canonical common planning checks](../execution-contract.md#maintaining-the-graph)
after changing this outcome's metadata. These checks validate planning documents;
they do not prove the behavior above.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.

- 2026-09-05: Preserve unresolved earlier dogfood, tutorial, and token-savings benchmark requirements through [the issue authority map](../issue-authority.md). Pilot cost metrics do not replace the separate comparative token-savings protocol.

- 2026-09-05: Refined acceptance after the owner-requested [HoH comparison](../research/hoh-alignment.md). These criteria remain unimplemented and unverified.

- 2026-09-06: Per [the alignment brief](../research/hoh-direction-brief.md): name the outer-loop objective (interventions per task, cost per accepted task, regressions) on the frozen task set, record skill and instruction versions in the configuration, and reuse the frozen set as the keep-or-discard check for outer-loop proposals with results kept out of proposer inputs. Unimplemented and unverified.
