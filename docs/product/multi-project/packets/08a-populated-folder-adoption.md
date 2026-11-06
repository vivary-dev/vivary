# 08a: Adopt populated folders with truthful type and conflict preflight
Type: packet
GitHub-issue: https://github.com/vivary-dev/Vivary-New/issues/17
Parent: 08
Status: done
Depends-on: [07b]
Owner: Root-assigned adoption integrator, sole writer
Scope: Fix verified folder-name/type collisions and plan/apply disagreement, then expose preservation-focused adoption in the GUI.
Verification-kind: runtime
Evidence: [Populated-folder adoption acceptance](../receipts/08a-populated-folder-adoption.md)
Verification-result: passed
Timebox: One coherent user-visible increment with focused checks and review.

## Goal

Adopt an existing notes folder without renaming its layout, claiming unrelated
files as typed Vivary records, or approving a plan that is already known to fail.

## Context

Read [ENGINEERING.md](../../../../ENGINEERING.md), the [current design](../design.md),
[Agent-Native ownership](../native-owners.md), and the [original source map](../research/original-vivary-product-map.md).
Agent-Native owns application actions, runs, and conversations. The original
creator owns setup operations, and Tropo owns project retrieval. The coordinating
agent (`root`) assigns one source writer before activation. Follow the live
repository delivery rules.

Reuse `plan_adopt`, `adopt_workspace`, the existing Tropo configuration reader,
and the [adoption outcome](../tickets/08-adopt-existing-projects.md).
Investigate the reported S2 type-name collision against current source before
fixing it. Existing valid schema declarations must keep their meaning.

## Owned files

- Original thin adoption and planned-content validation in `packages/create-vivary/`.
- Existing Tropo type/path interpretation only where the verified failure requires it.
- Shared adoption actions/adapter and Native preview/apply UI in `packages/workbench/`.
- Existing adoption tests and a populated-folder GUI journey.

## Done condition

Preflight identifies actual creates, managed appends, retained files, collisions,
and expected validation findings. Ordinary folder names do not silently assign
Vivary record schemas to unrelated notes. Explicit existing typed records still
validate correctly. The same relevant checks inform preview and apply.

The user can register without adopting, or approve a specific adoption plan.
Existing notes, state, links, and non-Markdown files remain byte-preserved except
for reviewed managed changes. Unsupported content is described accurately rather
than counted as indexed knowledge. Retry and recovery preserve completed work.
The GUI can open the adopted result immediately after the shared operation.

## Verify

Start with a small reproducible ordinary-notes fixture containing a conflicting
folder name, custom frontmatter, a valid typed record, and an unsupported file.
Then exercise the representative S2 corpus through preview/apply and the GUI.
Assert file preservation and truthful outcomes, not an invented minimum edge count.

```console
python -m unittest discover -s packages/create-vivary/tests -p test_adopt.py
python packages/tropo/tests/test_tropo.py
pnpm --dir packages/workbench typecheck
git diff --check
```

## Stop conditions

Do not rename/move the user's corpus, weaken private-source exclusions, or
silently infer authoritative schemas. Zero graph edges are not inherently invalid.
Semantic indexing, PDF extraction, and external templates are separate capabilities.

## Log

- 2026-09-13: Added to the combined implementation plan. Prerequisites are
  unresolved. No implementation or runtime acceptance is claimed.

- 2026-09-13: Required by the desktop release. Use the original adoption plan and journals through the same packaged Native action and project identity.

- 2026-09-23: Issue #14 accepted the shared plan and apply operation, so
  this packet's only recorded dependency is complete. Start with the named
  type-collision reproduction. Issue #15 remains the active ticket until its
  reviewed fix and acceptance record merge. Start #17 after that merge.

- 2026-09-23: Activated after #15 merged through PR #85. Source inspection
  reproduced implicit folder typing in a new thin adoption. Implementation
  keeps existing schema declarations authoritative and removes unintended
  type inference from newly adopted ordinary folders. Preview and apply must
  report the same validation blockers and unsupported-content boundary.
  Acceptance remains pending.

- 2026-09-23: Accepted on source `f024979` after review, exact-workflow checks,
  representative S2 hosted GUI adoption, mixed-schema refusal, and packaged
  Windows S2 and mixed-folder journeys. Preview reports retained content and
  configured validation findings before writes. Original files and the
  installed profile remained unchanged. See the
  [acceptance receipt](../receipts/08a-populated-folder-adoption.md).
  Parent packet 08 and desktop release acceptance remain open.

- 2026-09-23: PR review fixes accepted on `2d620af` after focused regressions,
  independent review, fresh hosted S2 adoption, mixed-schema refusal and an
  existing ignore-file patch preview. All seven GitHub CI jobs passed, including
  Windows. Internal records retain their own schemas without colliding with
  owner types. The `f024979` actual-EXE journey carries forward as packaged
  integration evidence. The final source has not run inside a new EXE. Final
  ticket #23 still owns its exact release artifact acceptance.

## Shared desktop and web behavior

Browser adoption selects an authorized folder on the connected host. Narrow layouts must preserve the complete file-change and conflict preview before apply.
