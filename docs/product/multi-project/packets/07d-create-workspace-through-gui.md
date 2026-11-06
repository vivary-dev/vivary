# 07d: Create and open a Vivary workspace through the GUI
Type: packet
GitHub-issue: https://github.com/vivary-dev/Vivary-New/issues/15
Parent: 07
Status: done
Depends-on: [07b, 06g]
Owner: Coordinating Codex, sole workspace-setup UI and action writer
Scope: Compose the accepted shared creator plan and apply operations into the existing project setup flow.
Verification-kind: runtime
Evidence: [GUI workspace creation and reconnection acceptance](../receipts/07d-gui-workspace-creation.md)
Verification-result: passed
Timebox: One Create, preview, apply, register, and reopen journey.

## Goal

Choose a folder, review its proposed guidance files, create the workspace, and
open its agent chat and files without a separate terminal setup step.

## Existing-folder setup increment

After opening a desktop folder or registering an authorized host folder, select
**Details > Preview Vivary setup**. The review shows the exact destination,
workspace type, proposed content, retained files, and conflicts. Changing the
workspace type clears the visible review. **Confirm and apply** submits the
saved review through the Native owner action. Cancel changes no project files.

The action reuses the creator's request identity after a lost response. Reload
and restart recover the saved request. Interrupted writes have a separate
recovery review and confirmation. Possible completed work refuses rollback.
Success opens the existing project's files and chat without registering another
identity. Project switching removes the prior folder's visible review.

An unprotected folder first shows the exact proposed `.gitignore` change.
The owner separately confirms privacy preparation, then reviews setup again.
The ignore change remains after later setup cancellation or recovery. No guidance
or private recovery record is written during privacy preparation. Lost responses
retain the original request for retry across reload and restart. Existing runtime
content, tracked runtime records, unsafe paths, and ignore conflicts block this
step. The [issue #8 Windows receipt](../receipts/23b-windows-desktop-acceptance.md)
records the packaged two-confirmation flow. The [issue #14 receipt](../receipts/07b-shared-workspace-plan-apply.md)
records the shared operation's current conflict, stale-review, Apply, and restart
checks. This packet still owns the complete GUI creation and reconnect journey.
The [Workbench reference](../../../../packages/workbench/README.md#projects-and-conversations)
owns the current behavior. Earlier accepted recovery work follows as history.

## Current recovery increment

The earlier issue #15 recovery slice covered registered managed projects before
the shared operations in [issue #14](https://github.com/vivary-dev/Vivary-New/issues/14)
passed acceptance. For an already-registered managed project whose saved folder identity is
unavailable, **Review connection** checks that recorded managed folder and
shows the recorded folder name, that its identity changed, and the consequence
of reconnecting. The user then
explicitly reconnects the reviewed same folder. The request carries the
reviewed operation and plan digest and rechecks current inputs before changing
the root binding. There is no arbitrary folder-path input.

A successful reconnect retains the project ID, conversation references,
selection and saved history while restoring authorized file and agent access.
It does not edit project files or start an agent. Saved Code history stays
tied to the stable project and binding IDs; old root metadata remains
provenance, not a current grant. Continuing an old Code conversation requires
the same current canonical path, a newly resolved grant and a fresh approval.
A moved path refuses continuation. Reconnection itself refuses while a Code
request is running or awaiting approval. Canceling leaves the binding
unchanged. A changed folder, grant or reviewed input requires a new review; an
uncertain result must reconcile the same request before retry. This increment
does not accept the full Create/preview/apply journey below or general folder
adoption. This bounded recovery increment passed its hosted UI checks on
2026-09-15. The whole packet remains open for the complete GUI journey under
issue #15.

The post-merge review correction narrows this recovery further. An uncertain
confirmation keeps its exact reviewed operation available through successful
and failed **Review again** attempts. After navigation or reload, a read-only
preview can recover that original operation and plan hash from one exact current
scoped registry receipt. It makes no mutation and returns
`recorded: true`/`identityChanged: false`, offering **Finish reconnecting**. A
fresh changed-folder review returns `recorded: false`/`identityChanged: true`.
A successful keyboard reconnect keeps its completion focus and status stable.
Only one recorded managed binding is eligible; external and multi-binding
recovery need separate work. A post-commit path change returns an uncertain
result with the receipt intact rather than success. The retry/focus behavior
passed private hosted verification on `fix/reconnection-review`; eligibility
and post-commit path change passed nine real SQLite tests. The hosted folder
swap was not exercised because the attempted rename returned EXDEV before any
source file changed.

## Context

Read [the desktop target](../desktop-release.md), [07b](07b-shared-workspace-plan-apply.md),
and `packages/workbench/README.md`. Register project connects an existing
folder. New Project creates a managed workspace. Project details can review and
apply setup to a registered folder. Compose these accepted operations into the
complete selection, review, apply, register, reopen, and recovery journey for
issue #15. Start with the neutral five-file workspace. 07c adds composable
starter content.

## Owned files

- Existing setup controls and project navigation in `packages/workbench/app/`.
- Deterministic creation actions and existing project-services adapters.
- Existing shared creator interfaces, only for a demonstrated caller mismatch.

## Done condition

The preview shows exact new and retained files and any conflicts. Confirming
applies only that plan. Changed inputs require a new preview. Existing content
is preserved, cancellation writes nothing, and repeated submission is safe.
The resulting stable project opens its files and chat, remains selected after
restart, and exposes its guidance to the agent. Failure offers a clear recovery
path without silently connecting the wrong folder.
No language-specific pack, VCS provider, cloud host, or model call is mandatory.

## Verify

Use a new disposable folder and a conflicting existing target. Check preview
bytes against written bytes. Exercise cancel, changed input, retry, restart,
and opening chat/files through the hosted GUI before Windows verification.
For the independent recovery increment, exercise Review connection, explicit
reconnect, cancel, changed inputs, unavailable and wrong folders, retained
project/conversation identity, restored authorized access, and absence of file
writes or agent work through the actual application.

```console
python3 -B packages/create-vivary/tests/test_thin_init_preview.py
pnpm --dir packages/workbench typecheck
pnpm --dir packages/workbench build
git diff --check
```

## Stop conditions

Do not revive the skipped Linux-only creation provider unchanged. The UI cannot
grant custody or bypass a write refusal. Reuse Native components and inspect the
installed toolkit before writing setup widgets. Do not introduce a conductor.

## Log

- 2026-09-13: Split visible setup from shared creator work so each can be
  implemented and verified in one bounded change.
- 2026-09-15: The managed-folder Review connection → explicit reconnect
  increment passed on the private hosted candidate at 1440×900 and 390×844.
  Cancel returned focus and changed no catalog entry; confirm restored access
  for two recorded projects with the same conversation IDs and earlier replies.
  A fresh same-conversation Code follow-up reached visible approval; Deny
  started no model or tools. Pending approval refused reconnect with HTTP 409.
  Arbitrary path/rootId fields refused with HTTP 400; exact replay returned
  already-reconnected without another change. File read, explicit Edit/Save/
  restore, reload and all 13 baseline file hashes passed. No model ran. A later
  host identity change required another explicit review, so this is not an
  automatic reconnection claim. Raw ignored results: `.tmp/15-hosted-final.json`
  and `.tmp/15-files-reconnection-result.json`. Full existing-folder apply and
  whole issue #15 remain open.
- 2026-09-15: PR #45 merged at `5ae92c3` with four review findings still open.
  The `fix/reconnection-review` follow-up passed two builds and a private hosted
  lost-response test: real confirm returned HTTP 200 but its browser response
  was withheld until timeout, leaving exact Retry and Review again. Review
  again offered recorded **Finish reconnecting**; normal catalog refresh healed
  availability before that button was clicked. Replaying the original request
  through the same authenticated Native action returned HTTP 200 without another
  catalog change. Desktop and 390px phone keyboard confirms retained completion
  status and focus on the project; phone Cancel restored focus with no catalog
  change, both controls visible and no horizontal overflow. Reload kept the
  earlier BETA conversation and closed panels; no model ran. All 28 fixture
  file hashes stayed unchanged. Nine real SQLite tests cover external/multiple
  binding eligibility and post-commit folder change with receipt-backed retry.
  The hosted folder rename returned EXDEV before changing source files, so it
  is not hosted folder-swap proof. Raw ignored results: `.tmp/45-review-hosted.json`
  and `.tmp/45-review-files-after.json`. At that checkpoint, full #15 Apply
  still depended on #14. Windows execution belonged to #8. PR #43 later merged.

- 2026-09-23: Issue #14 accepted the shared creator operations and affected
  packaged Windows conflict and stale-review checks. Issue #5 is accepted.
  The packet's dependency hold ended. This packet is ready for its separate
  complete GUI journey and remains unaccepted.

- 2026-09-23: The exact `27499cf` Workbench build passed the hosted GUI
  managed Create, existing-folder setup, changed-input refusal, explicit
  external-folder reconnection, Files, and restart journey. A later same-process
  replacement showed **Review connection** after settled refresh at phone width.
  The project-scoped Native history marker was fixture-seeded after the first
  restart, then remained visible through a later reconnect and one restart.
  The [GUI receipt](../receipts/07d-gui-workspace-creation.md) keeps the
  hosted evidence and its limits separate from packaged Windows proof.
- 2026-09-23: The exact-source unpublished Windows EXE passed GUI managed
  creation with five matching file hashes, native chooser registration of a
  long Unicode external path, explicit same-path reconnection after a
  filesystem identity change, and two normal restarts. Cancel preserved the
  external four-file fixture. Confirmation retained the project ID and Files
  access. The original account profile stayed byte-identical. See the
  [GUI receipt](../receipts/07d-gui-workspace-creation.md) for boundaries.
  This packet is accepted. PR merge and issue closure remain separate.

- 2026-09-23: Review correction `8fb3ed0` reuses provider classification for
  picker-selected folders beside managed projects. Eleven recovery tests,
  applicable CI, hosted confirmation and Files resume, and the focused
  Windows picker-child journey passed. The receipt records the narrow follow-up
  separately from the full `27499cf` acceptance.

## Shared desktop and web behavior

Distinguish native desktop folder selection from browser selection of an authorized folder on the connected host. File previews and apply controls must work at phone widths. Phone access does not grant phone filesystem access.
