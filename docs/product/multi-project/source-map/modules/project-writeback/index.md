---
project: Vivary
status: active
module_area: authorized project write-back
source_refs: [registry-contract, registry-receipt, native-owners]
module_refs: [root-observation, project-registry, native-runtime]
---

# Project write-back

## Outcome ownership

Outcome [11](../../../tickets/11-finish-workspace-editor.md) owns the project-file
adapter, draft persistence, conflict-safe saves, and byte evidence. Outcome
[16](../../../tickets/16-run-verified-workers.md) owns worker execution and
verification receipts around effects. Outcome
[17](../../../tickets/17-deliver-recovery-review-handoffs.md) owns recovery and replay.
Outcome [29](../../../tickets/29-deliver-review-integration-handoffs.md) owns review,
integration, and portable handoffs. Outcome
[06](../../../tickets/06-register-and-switch-projects.md) owns read-only registration
and switching. Registration grants no project-file effect.

## Intended caller-visible contract and errors

When Outcome 11 is implemented, an authorized run will target a registered checkout,
keep effects within its bounded worktree, and report changed paths, verification,
conflicts, and blocked gates. Callers must be able to distinguish authorization from
a completed filesystem effect.

## Hidden concerns

Workspace isolation, write permissions, branch state, atomic delivery, conflict
recovery, and effect receipts remain behind this responsibility.

## Dependencies

Write-back depends on [root observation](../root-observation/index.md), the
[project registry](../project-registry/index.md), and the
[native runtime](../native-runtime/index.md). The owner inventory routes to the
capability owners without copying preserved implementation paths. The
[registry contract](../../sources/registry-contract.md) and
[registry receipt](../../sources/registry-receipt.md) establish authorization
prerequisites only; neither is a project-file behavior contract or effect receipt.

## Current integration and remaining gaps

The canonical project-file adapter is implemented in
`packages/workbench/server/project-files.ts`, with scoped save/rename actions and
recoverable drafts. [The issue 12 receipt](../../../receipts/11a-project-file-surface.md)
records the accepted file slice. Issue #21 adds exclusive Create and
version-checked Remove to the same service. Only project memory calls them, to
save and forget one fact file. The [module catalog](../../../specification/modules.md)
routes to those source owners.

That evidence does not establish general isolated-worker write-back, atomic
integration, every remote-edit provider, or the full outcomes 16/17/29 pipeline.
The no-overwrite file rename is an optimistic copy-and-remove operation, not an
atomic rename guarantee. Preserve these limits when replacing the editor.
