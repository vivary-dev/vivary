# 07c: Compose built-in workspace patterns and reconfigure an existing project
Type: packet
GitHub-issue: https://github.com/vivary-dev/Vivary-New/issues/16
Parent: 07
Status: done
Depends-on: [07d]
Owner: Root-assigned creator and setup UI writer
Scope: Use the shared plan for useful built-in starter content and explicit pattern/role reconfiguration without replacing the workspace.
Verification-kind: runtime
Evidence: [Built-in guidance and reconfiguration acceptance](../receipts/07c-builtin-patterns-reconfiguration.md)
Verification-result: passed
Timebox: One coherent user-visible increment with focused checks and review.

## Goal

Create a useful second-brain, wiki, writing, or mixed workspace from editable
starting choices, then change those choices while preserving real work.

## Context

Read [ENGINEERING.md](../../../../ENGINEERING.md), the [current design](../design.md),
[Agent-Native ownership](../native-owners.md), and the [original source map](../research/original-vivary-product-map.md).
Agent-Native owns application actions, runs, and conversations. The original
creator owns setup operations, and Tropo owns project retrieval. The coordinating
agent (`root`) assigns one source writer before activation. Follow the live
repository delivery rules.

Use the [file-memory study](../research/file-memory-and-persistence.md) and
[workspace pattern examples](../research/letta-code-workspace-patterns.md).
S1 means an explicit reconfiguration plan and apply. Metadata from 07a alone
cannot satisfy it. Research labels do not establish universal mandatory roles.

## Owned files

- Built-in content and pattern composition in the original creator package.
- The shared plan/apply entry points from 07b.
- Native setup/reconfiguration actions and their GUI presentation.
- Existing creator/adoption compatibility tests and one reconfiguration journey.

## Done condition

A small built-in pattern library supplies useful capture, source-reference,
navigation, and project-brief guidance. Starting choices compose those patterns
with editable names and paths. Prefill known inputs and workflow instructions,
not invented personal knowledge. Keep preset aliases readable for compatibility.

Reconfiguration previews added, retained, conflicting, and retired managed content.
Existing user edits and authored state survive. Apply changes the selected
configuration without creating another project or silently removing files.
Role paths grant no access. The GUI shows the result and an agent can discover
its guidance through the selected project's existing instruction path.

Built-in choices and GUI delivery proceed without an external catalog. No
maintenance loop, model, provider, hook, or schedule starts from selecting a pattern.

## Verify

Check two composable patterns, an existing edited guidance file, a changed
selection after preview, and retry. Use a visible GUI journey to create, edit,
reconfigure, and reopen one workspace. S1 passes only when its exact supported
change works through shared GUI/CLI operations, not by directly rewriting TOML.

```console
python -m unittest discover -s packages/create-vivary/tests -p test_init_thin.py
python -m unittest discover -s packages/create-vivary/tests -p test_adopt.py
pnpm --dir packages/workbench typecheck
git diff --check
```

## Stop conditions

Do not treat role metadata as authority to delete user files, replace authored
STATE.md, import private history, or install third-party templates. Broader
pattern catalogs remain later additions, not blockers for the first useful flow.

## Log

- 2026-09-13: Added to the combined implementation plan. Prerequisites are
  unresolved. No implementation or runtime acceptance is claimed.

- 2026-09-13: Included in the desktop release after 07d. Existing preset aliases remain compatible.
- 2026-09-23: The 07d GUI and packaged Windows creation journey passed.
  This packet is ready to claim after issue #15 merges. Keep existing user
  content and preset aliases through reconfiguration.
- 2026-09-23: Issues #15 and #17 passed their accepted GUI journeys. This
  packet is the next ready project increment. Parent packet 07 remains open.

- 2026-09-23: Activated after #17 merged through PR #86. The creator owns
  installed patterns and exact reconfiguration plans. Extend existing Native
  review and custody, preserve authored guidance and state, and verify the
  create/edit/reconfigure/reopen journey before accepting this packet.

- 2026-09-23: Clean `7784b8d9` passed installed creator, hosted desktop and
  narrow-layout creation, edited-choice preview, authored-file preservation,
  interrupted response retry, and same-project restart. Independent review
  accepted the product and retained evidence. See the linked receipt for
  source checks and the final-artifact boundary under #23.

- 2026-09-23: Compatibility source `1ae19565` passed installed-runtime and
  hosted legacy/BOM migration, 41-emoji guidance names, exact writes, authored
  role preservation, and same-project restart.

## Shared desktop and web behavior

The existing built-in pattern selection and preview/apply workflow must be usable in desktop and narrow browser layouts against the same host-side operations.
