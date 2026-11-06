# 17a: Restore project chats and drafts after restart
Type: packet
GitHub-issue: https://github.com/vivary-dev/Vivary-New/issues/9
Parent: 17
Status: done
Depends-on: [04a, 06g]
Evidence: [Conversation drafts receipt](../receipts/17a-chat-restart-and-drafts.md)
Verification-result: passed
Owner: Root-assigned Workbench continuity integrator
Scope: Persist project/session selection and unsent text through Native state across desktop origins.
Verification-kind: runtime
Timebox: One restart-continuity increment with focused state checks and the real desktop journey.

## Goal

Close Vivary and reopen it to the same project and conversation, including an
unsent text draft, even when the local server uses a different port.

## Context

Read [the desktop release target](../desktop-release.md),
[ENGINEERING.md](../../../../ENGINEERING.md), and [Native owners](../native-owners.md).
At activation on 2026-09-23, completed Code transcripts persisted, but Native
composer drafts used browser storage and did not survive an origin change.
Issue #5 had repaired selection saves. The
[read-only integration findings](https://github.com/vivary-dev/Vivary-New/issues/9#issuecomment-5672430467)
identified the missing public draft seam. The implementation reuses the
existing authenticated state writer without copying browser-storage keys or
replacing Native history.

## Owned files

- `packages/workbench/app/routes/agent.tsx`, `chat.tsx`, and 04a shared session navigation.
- `packages/workbench/app/components/projects/ProjectContext.tsx`.
- Native application-state adapters at the smallest supported public seam.
- `packages/workbench/bin/start.mjs` and desktop startup only if stable identity requires it.
- Existing `chat-scope.test.ts`, `startup.test.mjs`, and `packages/desktop/tests/main.test.mjs`.

## Done condition

Project selection, active session and unsent text use stable owner/project/session keys.
Persist drafts through Native state without becoming another message or transcript store.
Restoring a draft never sends it automatically or adds an extra conversation.
Two projects retain different drafts, and stale asynchronous saves cannot overwrite
a newer selection or resurrect a draft after a successful send or explicit discard.
Missing folders retain their session and draft without switching to Personal workspace.
Interrupted work is shown honestly and global Stop remains available where applicable.
Changing the desktop port does not lose completed history, selection or text drafts.

## Verify

In the normal GUI, type distinct unsent drafts in two projects, navigate, close,
reopen on another port and inspect both. Send one and verify it stays cleared.
Exercise save failure, rapid switching and unavailable-folder recovery with focused cases.
Test the desktop journey after the corresponding hosted application behavior works.

```console
node --test packages/workbench/tests/startup.test.mjs
node --test packages/desktop/tests/main.test.mjs
pnpm --dir packages/workbench test:chat-draft
pnpm --dir packages/workbench exec tsc --noEmit -p tsconfig.json
```

## Stop conditions

Do not solve origin changes by copying browser profiles, invent a second history
store, or weaken local/private-proxy access. Never submit a restored draft automatically.

## Log

- 2026-09-13: Drafted. Cross-origin draft restoration is not accepted.

- 2026-09-23: Activated after #16 completed. Dependencies #5 and #6 are
  accepted. Published Core still lacks a public draft restoration API. Extend
  the existing versioned Native patch at its owning composer components, then
  persist drafts through the existing authenticated application-state writer.
  Keep Native storage and execution ownership. All draft acceptance remains open.

- 2026-09-24: Hosted acceptance passed on clean `250b402f` with the unchanged
  bundled Python runtime from `079fba00`. The [receipt](../receipts/17a-chat-restart-and-drafts.md)
  records two project drafts, Native and Code sends, save failure and retry,
  lost-response recovery, rapid edits, unavailable folders, narrow layout,
  and bare-root restart on a different local port. Core and Toolkit use pinned,
  opt-in patches. The renderer close check passed. The packaged result follows
  below, and this packet stays in progress while keyboard input is unverified.

- 2026-09-24: The clean `250b402f` Windows EXE restored distinct Native and
  Code drafts after normal close and a changed-port bare-root reopen. A blocked
  SQLite save kept the window open. Retry then saved the text, and a second
  normal close and reopen retained it. One Native GUI send kept its history
  after refresh. A Code draft was accepted into a run that the fixture stopped
  at its first approval. The later Code follow-up was saved and explicitly
  discarded without losing accepted history. The [receipt](../receipts/17a-chat-restart-and-drafts.md)
  keeps the source metadata and fixture qualifications. The on-screen keyboard
  appeared but did not deliver input because automation could not control its
  higher-integrity window. Keep #9 open for that acceptance case and delivery.

- 2026-09-24: PR #88 review found two draft-discovery failures in the
  `250b402f` candidate. An unsent Native conversation had no thread row to
  list after its active selection changed. A started Code run did not expose
  the temporary draft ID needed to reopen a later follow-up. The clean
  `eb63459f` Workbench build indexes only scoped draft IDs in authenticated
  Native application state, derives previews from the authoritative text, and
  carries the accepted Code draft ID through its run. The hosted GUI reopened
  same-project Native drafts and a Code run's follow-up across a changed port.
  Its original Python runtime was unchanged from `079fba00`. The
  [receipt](../receipts/17a-chat-restart-and-drafts.md) separates passing
  segments, earlier failed runs, and remaining packaged acceptance. Keep this
  packet in progress until the new Windows journey and keyboard case pass.

- 2026-09-24: The first `eb63459f` Windows retest restored an older Code
  follow-up, then failed to load it after switching from a new draft.
  Captured requests show the error occurred before a draft read. A hosted
  session-refresh interruption reproduced that failure. The follow-up work
  gates draft loading on Native session readiness, checks the exact owned
  thread before restoring an archived selection, retains the unassigned
  history kind, and restores a Code draft after a known local send refusal.
  Focused hosted checks passed on a dirty Workbench build. A clean-source
  packaged retest and on-screen keyboard case remain open.

- 2026-09-24: Clean `12c8b354` hosted checks passed five focused cases with
  the original Python runtime from `079fba00`. Its unpublished Windows package
  restored project Native, Code, and unassigned drafts across a normal close
  and changed-port bare-root restart. The archived Native thread stayed out
  of history. Unassigned placeholders were API-seeded, then edited through the
  GUI. Corrected final captures and the [receipt](../receipts/17a-chat-restart-and-drafts.md)
  carry the exact qualifications. Workbench prebuilt metadata still reports
  `sourceCommitVerified: false`.

- 2026-09-24: Manual on-screen keyboard input saved an unsent `x` under its
  exact conversation ID. Refresh and a changed-port normal restart restored
  it without a new submission. Seven tested drafts remained unsent in the
  isolated profile. The earlier `x` plus Enter case was a normal send. Six
  further PR #88 review findings led to follow-up source fixes, which still
  need independent review and affected hosted and packaged checks. Keep #9
  open until those gates and the reviewed `dev` merge finish.

- 2026-09-24: Reviewed fixes in `702f93e` and `1889fe6` received focused
  hosted observations for recovery, owner rejection, selection, older Code
  follow-ups, and latest queued Retry. Their earlier private hosted receipts
  were lost in a Modal snapshot rollback. The first `9682472b` package failed
  because its installed Core did not match the tracked patch. Reinstalling
  from the unchanged frozen lock restored the correct runtime. The repaired
  exact-source Windows package passed the existing project-row switch under
  a held SQLite write, pending close, changed-port bare-root restart, and
  seven-draft audit. The [receipt](../receipts/17a-chat-restart-and-drafts.md)
  gives the artifact and evidence limits. Technical candidate acceptance is
  complete. Keep #9 open until PR #88 merges into `dev`. Entire CLI sign-in
  is needed for mirror push and ref verification. The formal trail approval remains
  a separate failed check that requires a recorded reviewer vote.

- 2026-09-24: PR #88 merged into `dev` as `0c8c7eb`, and #9 closed. The
  GitHub and Entire `dev` refs match. The Entire gate now counts the
  author's approval, which replaced the separate reviewer-vote requirement.

## Shared desktop and web behavior

Include browser refresh, navigation away and back, interrupted connection, and an on-screen keyboard. Restore drafts through the existing host-owned Native state without automatic sending or a second synchronization system.
