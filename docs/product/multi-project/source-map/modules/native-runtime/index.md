---
project: Vivary
status: active
module_area: native coding-runtime execution
contract_refs: [program-execution]
source_refs: [native-owners]
module_refs: [project-registry]
---

# Native runtime

## Outcome ownership

Outcome [04](../../../tickets/04-define-runtime-session-contracts.md) owns the app
runtime, session, action, event, tool, and receipt contracts. Outcome
[10](../../../tickets/10-prove-native-runtime.md) owns the native adapter and real
execution proof. Outcome [16](../../../tickets/16-run-verified-workers.md) owns worker
orchestration, verification receipts, and usage accounting. Outcome
[17](../../../tickets/17-deliver-recovery-review-handoffs.md) owns crash recovery and
native session resume. Outcome
[29](../../../tickets/29-deliver-review-integration-handoffs.md) owns review,
integration, and portable handoffs.

## Caller-visible contract and errors

Callers select a registered project and bounded task packet, then receive observable
run state and failures without gaining ambient authority over repositories, secrets,
spending, publication, or cleanup gates.

## Hidden concerns

Runtime choice, sandbox lifecycle, credentials, process supervision, and provider
adapters remain behind this responsibility. The native owner inventory identifies
where each capability belongs.

## Dependencies

Runtime work resolves stable project identity through the
[project registry](../project-registry/index.md) and follows the shared execution contract.

## Gaps

Preserved host-side evidence routed through the owner inventory is not proof of a real
coding-runtime session. This checkout has no canonical runtime implementation or
accepted live-runtime receipt to link, so this record deliberately has no test or
evidence edge.
