# 07b: Share a file-content plan and apply path between GUI and CLI
Type: packet
GitHub-issue: https://github.com/vivary-dev/Vivary-New/issues/14
Parent: 07
Status: done
Depends-on: [07a]
Owner: Coordinating Codex, sole creator and Workbench adapter writer
Scope: Complete the shared portable creator plan/apply operation. The separate 07d packet owns its visible GUI flow.
Verification-kind: runtime
Evidence: [Shared workspace plan and apply acceptance](../receipts/07b-shared-workspace-plan-apply.md)
Verification-result: passed
Timebox: One coherent user-visible increment with focused checks and review.

## Goal

Preview the exact files and content of a new workspace and apply that plan
through one deterministic Native action and the equivalent existing CLI operation.

## Context

Read [ENGINEERING.md](../../../../ENGINEERING.md), the [current design](../design.md),
[Agent-Native ownership](../native-owners.md), and the [original source map](../research/original-vivary-product-map.md).
Agent-Native owns application actions, runs, and conversations. The original
creator owns setup operations, and Tropo owns project retrieval. The coordinating
agent (`root`) assigns one source writer before activation. Follow the live
repository delivery rules.

The shared content-preview API was recovered in PR #4. Reuse that renderer.
The earlier guarded Python provider failed strict symlink checks on Zo. Use
the original creator's effect boundary and the existing managed-project bridge
for the greenfield path. A plan hash is not folder custody or an app grant.
Do not reintroduce the failed provider unchanged.

## New-folder contract

`plan_thin_workspace(target, preset, adapters, active_context)` returns the
ordered exact UTF-8 files, content hashes, normalized target/options and a
target-bound `plan_sha256` without writing.
`apply_thin_workspace(target, accepted_plan_sha256, ...)` recomputes those
inputs before the creator's existing write boundary. It returns `created`,
`plan-changed`, or `already-created`. The last result is a no-write retry
only when the target has exactly the reviewed file and byte inventory. An arbitrary
nonempty existing folder remains refused. Changed target or options invalidate
the reviewed hash. The managed bridge delegates to these source operations and
keeps its existing external camel-case result fields.

The private dev CLI adds `create-vivary init TARGET --reviewed --dry-run
--json` for the full file-content plan, followed by `--reviewed --yes --plan
HASH --json` for its exact apply. Reviewed mode refuses wizard/provider,
storage, memory beyond `none`, and other setup side writers. This greenfield
content plan is separate from project registration and task plans. It does not
enable general existing-folder apply under issue #15. The bounded runtime
increment passed on 2026-09-15 and merged in PR #47. The current acceptance
also covers existing-folder apply. These private source
commands are not a registry release.

## Existing-folder content preview

The ordinary `adopt --json` dry run now adds `content_plan` with schema
`vivary.adopt-content-plan.v1`. The creator captures complete proposed UTF-8
contents, byte counts, and hashes for creates, patches, and replacements during
planning. Retained paths carry hashes, including files with binary contents.
The existing `plan_hash` binds the same inputs as before. Serialization performs
no filesystem rereads, and applied and recovery reports keep their existing shape.
The [creator reference](../../../../packages/create-vivary/README.md#existing-repositories-and-vaults)
owns the field contract.

Workbench exposes this read-only report through **Details > Preview Vivary setup**
for the selected registered folder. The UI calls `vivary-project-adoption`,
which delegates preview to the original runtime with owner and folder-binding
checks. The general `vivary-original-command` action remains preview-only for
create and adopt. Oversized output fails the whole preview at the existing
process output bound. Content is never silently truncated. The
[Workbench reference](../../../../packages/workbench/README.md#projects-and-conversations)
owns the visible flow and its limit.

## Existing-folder owner approval

`vivary-project-adoption` adds a separate Native owner action for review,
confirmation, apply, and recovery. Private Native settings bind a preview to its
owner, organization, project/root binding, policy revision, options, complete
creator report, and original request ID. Confirmation creates a bounded app
write grant. The original runtime revalidates the binding before invoking the
creator's request-aware operation. The local-stat provider remains ineligible
for strict registry mutation admission.

The creator's dry-run report includes request replay readiness and a separate
privacy-preparation proposal. An unprotected folder requires explicit review and
confirmation of only its `.gitignore` change before a fresh setup review.
The app saves that operation identity before dispatch. Retry verifies the reviewed
ignore bytes without creating private recovery records. Setup cannot use the
privacy step's approval. Its new review must confirm the remaining file changes.
The separately approved ignore rule stays after later cancellation or rollback.
Creator recovery and completion records continue to own setup rollback and replay.
[The Workbench reference](../../../../packages/workbench/README.md#projects-and-conversations)
owns the visible controls and runtime output limit. The
[shared plan and apply receipt](../receipts/07b-shared-workspace-plan-apply.md)
records the completed #14 checks. Issue #15 retains its separate GUI creation
and reconnect scope.

## Accepted current candidate

The [shared plan and apply receipt](../receipts/07b-shared-workspace-plan-apply.md)
records seven normal-app existing-folder cases on Zo. Native and CLI previews
matched on one physical folder and selected preset, including complete content,
hashes, conflicts, and a binary retained file. Apply wrote the reviewed
bytes. An exact retry changed no file or modification time. Conflicting destinations,
changed options, and changed retained bytes refused stale approval. A completed
creator result lost before the service received it replayed after restart.
An interrupted apply required a separate reviewed recovery hash and restored
the original files.

The packaged Windows journey showed the conflict and disabled Apply, refused a
review invalidated by a retained binary edit, then applied four reviewed files.
It reopened the same project and applied state after restart. The first Apply
HTTP response and post-restart Native HTTP response were not captured. App
state, exact disk bytes, and the creator completion receipt support the
observed result. The Windows package uses unchanged app code from the current
source candidate. Issue #15 and the full release remain separate.

## Owned files

- Original thin renderer and apply helpers in `packages/create-vivary/create_vivary.py`.
- The existing `packages/workbench/server/managed_project_workspace.py` bridge
  and managed-project caller. Project registration keeps its own owner.
- Deterministic setup actions under `packages/workbench/`. The 07d packet owns
  project navigation and visible setup.
- The minimum packaging changes needed to call the same operations outside this
  source checkout, coordinated with outcome 23.
- Existing creator and creation-provider tests, plus shared action/CLI parity.

## Adoption concurrency prerequisite

The creator serializes ordinary adoption apply and approved rollback recovery for
the same physical folder before either can write. Read-only previews remain
unchanged. The [creator reference](../../../../packages/create-vivary/README.md#existing-repositories-and-vaults)
owns platform behavior and limits. Real subprocess checks cover contention,
process death, recovery, and independent folders. Native Windows checks
remain separate from the packaged desktop journey.

Apply also refuses before any write when the complete journal could exceed the
recovery reader's size limit. Regression checks cover oversized UTF-8 inputs,
progress-state growth, and exact-byte recovery near the limit. The creator
reference above owns the limit and refusal behavior.

Original-request completion records and explicit app-side write approval
now support a lost creator result without repeating writes. The completed
normal-app retry and recovery checks appear in the linked receipt. Issue #15
retains its separate GUI journey.

## Done condition

The plan includes target, selected inputs, creates/managed patches/kept files,
content, and conflicts. Approval binds the exact reviewed content and target.
Changed inputs invalidate apply. Original creator operations own writes, recovery,
and repeated-request handling. The registry uses the existing project identity.

The existing CLI and deterministic Native actions consume the same contract.
Packet 07d owns the visible preview/apply/register/reopen journey. VCS and
hosting can remain none. This first setup journey ships before
merge/split and does not require a conductor daemon or global CLI installation.

## Verify

Use temporary targets with the normal application composition. Check plan bytes
against applied bytes, refusal after changed input, retry/recovery, and no writes
from preview. Exercise the shared Native action and equivalent headless operations. The 07d
journey validates their GUI caller.
The earlier 2026-09-15 candidate passed the hosted keyboard Create journey
at 1440x900 and normal-size Cancel. Its unchanged frontend also passed phone
preview/Cancel controls, focus, and no horizontal overflow at 390x844. That
pre-fix hosted proof remains in private evidence. It is not the corrected
creator receipt.

The PR #47 review correction gives each write attempt its own file-commit
and directory ownership, so a failed concurrent attempt cannot roll back a
winner's files. An exact retry runs read-only Doctor before reporting success.
Target-inspection errors become structured refusals, and sanitized CLI
receipts include `--reviewed`. The corrected bundled-Python run passed
five-file CLI/bridge plan parity, no preview or wrong-hash writes, exact
create bytes, and no-write cross-caller retry. Focused shared, CLI, bridge, and adoption tests passed
15, 22, 5, and 20 cases.

The corrected hosted journey again matched all five UI plan contents to
the Native response and bundled CLI hash. Preview and wrong-hash refusal
left the target absent. Keyboard Create registered and selected the project. Exact retry retained its
project and policy, with all five file bytes and modification times
unchanged. The existing registration-attempt receipt advanced
`registryRevision` from 23 to 24. The actual `STATE.md` file view showed
formatted content and Edit/Rename controls. Returning to the earlier conversation restored its
history, enabled composer and New conversation, and left panels closed. The
app was idle and made no model calls.

Six saved fixture folders had changed filesystem inodes at the same paths.
Root used the existing reviewed reconnection flow. All 33 fixture files
kept their exact bytes. The underlying Zo identity-change cause remains unknown.
The corrected hosted run did not repeat the earlier viewport checks.
The frontend output was unchanged. These statements describe the PR #47
new-folder increment. The current existing-folder and Windows checks appear
in the linked receipt.

Windows CI on `32ef296` found that `DirEntry.stat()` reports a zero link
count on Windows, so exact retries were refused. The creator now uses
`os.stat(..., follow_symlinks=False)` for that metadata, as specified by the
[Python documentation](https://docs.python.org/3.13/library/os.html#os.DirEntry.stat).
The existing CLI, shared creator, and bridge suites each have a separate
Windows CI step so any failing suite fails the job. This is platform test
coverage. The later packaged Windows application journey has its own
[issue #8 receipt](../receipts/23b-windows-desktop-acceptance.md).

The commands below are starting suites, not substitutes for the actual journey.

```console
python -m unittest discover -s packages/create-vivary/tests -p test_init_thin.py
node --test packages/workbench/tests/creation-provider.test.mjs
git diff --check
```

## Stop conditions

Resolve any new write-authority requirement with the owning root/creation
contract. Do not enable strict mutation roles on the local-stat provider, claim
held custody from a path, install another executor, or activate external templates.

## Log

- 2026-09-13: Added to the combined implementation plan. Prerequisites are
  unresolved. No implementation or runtime acceptance is claimed.
- 2026-09-13: 07a accepted. Root owns the creator/adapter closure. Begin with
  a shared `plan_thin_workspace` operation over the existing renderer, then wire
  the retained adapter to the real apply path. Hosted mutation proof retains
  its separate unresolved auth prerequisite. Source preparation could proceed.

- 2026-09-13: Recovered preview and role metadata are integrated. This packet
  owns portable apply, with visible setup in 07d.
- 2026-09-15: Issue #14 was active on `feat/shared-workspace-plan`. The original
  creator source candidate binds reviewed greenfield file bytes, target and
  options before apply, recognizes only exact no-write retries, and routes the
  managed bridge and reviewed CLI through that contract. Bundled-Python
  and hosted acceptance passed for the bounded greenfield path. Existing-folder
  apply and issue #14 delivery were open at that checkpoint.

- 2026-09-23: The current normal-app seven-case proof and packaged Windows
  conflict, stale-review, exact Apply, and restart journey passed. Luna
  independently approved the hosted seven-case proof. The linked receipt
  records source identity and limits. Issue #15 remains open.

## Opt-in adoption request replay

The creator CLI and Python operation accept an original request ID for approved
ordinary adoption. Completion receipts support lost-response retries without
rewriting guidance. Request-aware journals distinguish pending rollback from
possible completion, where rollback refuses. The
[creator reference](../../../../packages/create-vivary/README.md#retrying-an-approved-adoption-request)
owns the pre-existing privacy requirement, matching rules, size limits, and
recovery restrictions. The owner action supplies separate GUI write
authority. The linked receipt covers its accepted #14 use. Issue #15 remains separate.
