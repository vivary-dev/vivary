# Automation instruction preservation

Issue [#144](https://github.com/vivary-dev/vivary/issues/144) preserves the owner's accepted instructions while automation changes wait for review. This extends the review boundary from [#109](https://github.com/vivary-dev/vivary/issues/109).

Verified on 2026-10-02 at source commit `66031bfdfd670f61765daccd2fb8b77ac8031dbb`, on `fix/automation-instruction-preservation`.

## Verified behavior

An automation overwrite keeps one accepted predecessor. Chats and later automation runs read that version while Settings shows the proposed text. Repeated proposals and ordinary edits cannot replace the saved predecessor.

In **Settings > Automation files**, **Accept** activates the exact proposal shown. **Discard** restores the predecessor, including its metadata and origin. Discard removes a proposal with no saved predecessor. Both decisions refuse a version that changed after the owner saw it.

Automation runs cannot delete personal instruction or memory files. The deletion check also prevents `delete-memory` from rewriting the memory index after a refused deletion. Ordinary note operations remain available.

## Focused tests

All 39 cases passed in `automation-file-review.test.mjs` and `automation-file-review-component.test.mjs`, with no failures or skips:

```sh
node --test packages/workbench/tests/automation-file-review.test.mjs packages/workbench/tests/automation-file-review-component.test.mjs
```

The store tests use disposable production-mode SQLite and the real unattended tool wrapper. They cover accepted reads and prompts, skills, repeated proposals, empty predecessors, deletion entry points, reserved metadata, visibility, expiry, and stale decisions. Interleaved operations cover owner edits, acceptance, moves, deletion, and list-to-read races.

A fresh-process test reopens the same disposable database and verifies the accepted content, pending review state, resource read, and prompt. This establishes stored-state persistence across processes. The component tests render the real Settings component with a stubbed action transport.

## Built application journey

The built application passed all 18 journey checks. Chromium signed in through the one-time owner address and opened the real **Settings > Automation files** tab. The journey used its rendered DOM and buttons with the application's HTTP actions.

The journey verified that:

- Owner chat read the exact accepted content while a proposal waited.
- Settings displayed the proposal as plain text. Embedded HTML created no active elements.
- A proposal changed after display caused **Accept** to refuse the stale decision and show the reload notice.
- **Discard** restored accepted content, which another owner-chat read confirmed.
- **Accept** activated a later proposal, which a third owner-chat read confirmed.
- Discarding a new-only proposal removed the file.
- Both unattended resource deletion and `delete-memory` were refused. Accepted content and the memory index remained unchanged.

The three owner-chat reads executed the actual `resources` tool dispatcher. A fake model gateway on loopback received six requests and the resulting tool outputs. No paid provider calls occurred.

Automation proposals and deletion attempts used the installed unattended tool wrapper in a separate fixture process against the same disposable database. The journey did not start the scheduler. Review actions and owner-chat dispatch ran through the built application.

The receipt confirmed that the app and gateway stopped and temporary data was removed. The journey closed its browser and retained screenshots and a compact result record privately.

## Follow-up decision feedback

A later UI review found that failed review requests could disappear behind a
successful list reload. Settings now keeps an unconfirmed decision notice for
each affected file. A confirmed decision on that file clears its notice.
Reviewing another file leaves it in place. Component regressions cover Accept
and Discard, authentication and server failures, a lost connection, successful
retries and overlapping decisions on two files. The initial 18-check journey
above predates this feedback change.

## Limits

Pending rows created before this change have no saved predecessor. Previously overwritten content cannot be recovered by this patch and remains unavailable until review. A new personal proposal can still shadow an inherited shared or organization file at the same path.

Accepted scratch visibility remains scratch visibility. Interactive owner deletion remains an explicit deletion.

This receipt does not establish live PostgreSQL behavior, a packaged Windows journey, scheduler execution, or full visual acceptance of the application. The built journey covers the named Settings controls and owner-chat tool results.
