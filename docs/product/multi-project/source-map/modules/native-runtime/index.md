---
project: Vivary
status: active
module_area: native coding-runtime execution
source_refs: [program-execution, native-owners]
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

## Intended caller-visible contract and errors

When Outcome 04 is implemented, callers will select a registered project and bounded
task packet, then receive observable run state and failures without gaining ambient
authority over repositories, secrets, spending, publication, or cleanup gates.

## Hidden concerns

Runtime choice, sandbox lifecycle, credentials, process supervision, and provider
adapters remain behind this responsibility. The native owner inventory identifies
where each capability belongs.

## Dependencies

Runtime work resolves stable project identity through the
[project registry](../project-registry/index.md) and follows the
[program execution reference](../../sources/program-execution.md). Root engineering
policy and the live issue govern how work is claimed and verified. These references
do not replace the runtime behavior contract.

## Current integration and remaining gaps

The canonical Workbench has a working Native Code path in
`packages/workbench/server/local-code-agent.ts` and the Code execution host/worker.
It reuses Native Code run/transcript records. New conversations select Claude Code
or Codex without entering Native provider setup. Codex discovers subscription models
and configured connections, executes through app-server, and resumes its own native
session. Native action requests use exact request binding and per-turn permissions.
Normal, Read only, and YOLO apply when a turn starts. There is no fixed turn deadline
or per-message launch gate. Progress and actual native subagent activity retain
separate presentation from final answers.

The recorded Windows candidates verified subscription file work, a configured tool,
real child output, modes, approvals, long work, Stop, and restart. Follow
[implemented Codex behavior](../../../specification/harness-adapters.md#implemented-codex-behavior)
and the [acceptance register](../../../desktop-acceptance-status.md) for boundaries.

Project-bound Native storage and deterministic-provider journeys are implemented.
They do not establish access to a real Native provider, real-provider Native turns,
or automation execution. The [adapter specification](../../../specification/harness-adapters.md)
identifies the intended generic seam. Linked conversations, broader resume, concurrent
execution, model switching, and the complete outcome 04/10 contract remain open.
See the [desktop acceptance register](../../../desktop-acceptance-status.md).
