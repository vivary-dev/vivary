# 07: Implement new-project planning and creation
Type: outcome
Status: planned
Blocked-by: [03, 06]
Unlocks: [09, 13, 19, 24]

Execution: Read and claim the live [GitHub issue](https://github.com/vivary-dev/Vivary-New/issues). Its dependencies govern starting work. Use [the graph](../graph.md) for supporting references. Parent dependencies still gate outcome completion, not independent preparation.

## Goal

Create blank or built-in Vivary workspaces through the GUI and service contract. Keep workspace structure, agent guidance, runtime, VCS, and hosting as independent choices.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own new-project service and UI. Reuse `scaffold_thin_workspace`, dry-run output, Doctor, and Tropo checks from `packages/create-vivary`. Read `design.md`, `evidence.md`, and the creation guide. Do not duplicate init rules. Follow the [workspace setup direction](../design.md#workspace-setup-direction-2026-09-13) when extending the built-in guidance. The four existing preset names remain a compatibility input, not mandatory GUI categories.

The shared creator adapter now supplies exact file-content plans and reviewed
apply. The [creation receipt](../receipts/07d-gui-workspace-creation.md) covers
GUI creation and registration. The [pattern receipt](../receipts/07c-builtin-patterns-reconfiguration.md)
covers installed guidance composition and changes that preserve authored work.
Parent dependencies still gate this outcome's completion.

## Done condition

A user previews the exact target and files, applies a bound plan, verifies the workspace, and registers it. A crash or repeated request does not create a duplicate project. VCS and hosting can remain `none`. Selected built-in guidance and starter files appear in the plan and remain editable afterward. A folder registration or the five-file base alone does not establish completion of the useful-workspace setup requirement.

## Verify

Run service and browser tests for blank creation, occupied target refusal, changed plan input, interruption, retry, and registration. Run Doctor and Tropo against the result.


Run the [canonical common planning checks](../execution-contract.md#maintaining-the-graph)
after changing this outcome's metadata. These checks validate planning documents;
they do not prove the behavior above.

## Next packets

- [07a: Optional workspace metadata](../packets/07a-workspace-role-contract.md): compatible preparation, assigned to runtime_setup.
- [07b: Shared content plan and apply](../packets/07b-shared-workspace-plan-apply.md): repair the creator adapter and deliver the first GUI/CLI setup journey.
- [07c: Built-in patterns and reconfiguration](../packets/07c-builtin-patterns-reconfiguration.md): useful starter content and explicit S1 changes.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.

- 2026-09-13: Jeff clarified useful workspace setup and questioned fixed language or stack packs. Recorded composable structure and agent guidance as the proposed implementation direction. The GUI creation flow remains unimplemented.

- 2026-09-13: Combined setup work into bounded packets. Metadata alone does not complete creation or S1. GUI acceptance accompanies setup, before merge/split.
- 2026-09-13: Packet 07a accepted as compatible role metadata. Packet 07b is
  ready for the shared GUI/CLI plan and apply implementation. The outcome remains
  open until real workspace creation passes its user-facing exit checks.

- 2026-09-23: Packets 07b, 07d, and 07c have accepted user journeys. Parent
  dependencies remain open, so this outcome is not marked complete.
