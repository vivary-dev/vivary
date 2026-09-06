# Harness-of-Harness alignment review

Date: 2026-09-05. Requested by the product owner. Status: source inspection and
acceptance refinements. No HoH product execution or comparative benchmark.

Vivary has compatible foundations, but the current workbench does not implement
the complete feedback cycle. This review found no previous reference to this
paper in the inspected Vivary program or preserved Littleagent source.

## Research basis

HoH coordinates bounded planning, development, and independent QA through an
existing coding runtime. QA assesses a frozen candidate. Artifact state and
evidence state survive iterations. Verified behaviors constrain subsequent work,
while gaps guide new targets. Runtime permissions and structured outputs enforce
role boundaries. Files and progressive disclosure provide continuity without a
mandatory memory service. Experimental runs hold their configuration fixed.
[Primary paper, sections 3 and appendix A](https://arxiv.org/html/2609.01481v1).

## Current evidence and owning work

| Inspected Vivary behavior | Remaining acceptance work |
| --- | --- |
| [Execution rules](../execution-contract.md) require bounded packets, one writer, receipts, and explicit verification limits. | [04](../tickets/04-define-runtime-session-contracts.md) must enforce role permissions and validate structured results in the real adapter. |
| [Core receipts](../../../../packages/core/vivary_core/receipt.py) bind a capsule and workspace fingerprint. Lines 85-99 derive all claim statuses from the aggregate check result. | [29](../tickets/29-deliver-review-integration-handoffs.md) must map each product claim to actual observations. Preserve the legacy contract. Its aggregate status cannot substitute for the new report. |
| [Native ownership](../native-owners.md) identifies run, session, task, action, plan, resource, and handoff primitives. | [16](../tickets/16-run-verified-workers.md) must bind a developer result to an exact candidate and native IDs. Independent acceptance belongs to 29. No replacement model loop, transcript store, or scheduler is warranted. |
| [15](../tickets/15-deliver-plans-and-kanban.md) already requires revision-bound plans and dependency-aware boards, but remains planned. | Add prior evidence, preservation requirements, next targets, and observable acceptance to the development document. Prove that these survive replanning. |
| [20](../tickets/20-run-bounded-factory.md) already requires budgets, stops, recovery, and evidence, but remains planned. | Bind the artifact, candidate, QA result, and next plan across an iteration and crash recovery. An uncertain result must stay uncertain. |
| [18](../tickets/18-add-scoped-brain-learning.md) makes Brain optional and promotion reviewed. | Verify continuity and [specialist research](../tickets/21-add-research-specialists.md) with Brain disabled. Outcome dependencies gate completion. Independent preparation of that path can proceed. |
| [36](../tickets/36-measure-pilot-outcomes.md) specifies a frozen pilot and raw receipts. | Measure our own accepted capabilities, regressions, interventions, and costs against a declared comparable baseline. No measured Vivary benefit follows from adopting these criteria. |

The preserved Littleagent host binds owner, organization, project, working
directory, and adapter. Its start/reopen input carries a freeform prompt and
thread/session references. Its persisted workspace reference carries project ID
and path. The inspected contract does not bind a role, plan revision, candidate
snapshot, or independent QA report. Its readiness action reports the adapters
as unproved. These are source findings, not a new live-runtime test.
The source identity is `Jeff-Kazzee/littleagent`. Inspected files are
`apps/workbench/server/agent-runtime-host.ts` (lines 68-90 and 454-459) and
`apps/workbench/actions/runtime-readiness.ts` (lines 90-125). The preserved
copies remain migration input and are not claimed to be published.

## Application choices and limits

The ticket changes are agent-selected acceptance refinements within the existing
implementation scope. They do not record an owner decision to reproduce the
paper verbatim. Runtime and model choice remain product features: record the
configuration for each iteration and make changes explicit. An efficiency
comparison must use declared, comparable conditions.

Keep independent QA separate from integration authority. Use a content snapshot
for no-VCS projects and cover dirty files for VCS projects. A passing developer
test suite means candidate readiness. Missing user-visible observations remain
unverified. Existing human gates still govern merging, publication, spending,
and factory activation.

The registry model in [03b](../packets/03b-registry-contract-model.md) verifies
identity and transition rules. Follow [the current frontier](../index.md) for
the next packet. The model does not prove physical isolation, durable locks,
a frozen product candidate, or evidence-driven replanning. Do not close those
later criteria with its test result.

## Verification of this review

Two readers compared the paper with the owning tickets, the core receipt code,
and the preserved workbench source. Exact-title/identifier searches found no
earlier citation. The review corrected two overbroad suggestions: Brain-related
outcome dependencies are not packet start gates, and fixed experimental settings
do not require a fixed product-wide model. No current implementation status was
advanced by this review.
