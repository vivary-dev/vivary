# Live project preview and agent debugging

Evidence-record: 11e
Date: 2026-09-22
Issue: [#31](https://github.com/vivary-dev/Vivary-New/issues/31)
Implementation: `e14934d7f79cf553ec016fdcce45d1b3655a6fff`
Environment: normal production Workbench on Zo, disposable profiles and projects.

## Verified behavior

The preview discovers supported package scripts and reviews the command, folder,
launcher, and address before owner approval. Start rechecks that review. Retries
retain their request identity. A stale manifest refusal permits a fresh review.
Stop targets the owned command even after its project binding changes.

The integrated production build passed 25 normal-app browser checks. These cover
module execution, credential and referrer isolation, desktop and 390-pixel
layouts, draft preservation, no automatic send, exact host confirmation,
blocked and unavailable pages, manual selection during status polling,
project switching, Native context isolation, and normal Stop. A synthetic catalog
revision exercises context removal when the same project changes its folder
binding. That test is distinct from the real process service's rebind check.

Real responses from the app root, a JavaScript asset, the session endpoint,
a legacy redirect, and a missing page carry `X-Frame-Options: DENY` and
`frame-ancestors 'none'`. Redirect and client-navigation fixtures could not
execute Vivary scripts inside the preview. The isolated project frame runs
ES modules and retains its own cookies without receiving or exposing the
parent browser's cookie.

## Real agent loop

Codex CLI with GPT-6 Astra ran through the existing Code conversation in Normal
mode. Reviewed, one-shot command approvals allowed fixture inspection, browser
checks, and one source correction. The runtime used installed Python Playwright
and Chromium in fresh browser contexts. No tool installation or personal profile
copy occurred.

The initial page failed to import `missing-view.js`. Real tool results recorded
the 404, console error, and failed request. The agent changed one import in
`app.js`, captured another screenshot, and observed the corrected message with
no console, HTTP, or failed-request errors. The persisted transcript contains
six paired shell tool calls. Both screenshots are valid, distinct PNGs.

The original project, run, Codex session, and transcript restored after app
restart. A follow-up appended to that conversation. The final UI check reviewed
and started the repaired fixture, displayed its corrected page beside the
restored conversation, and stopped the command. All task ports closed.

The agent did not see screenshot pixels. Its `view_image` calls failed in Zo's
`bwrap` loopback setup, and it reported that limitation. No image-view events
reached Native. The maintained adapter's image-view mapping has protocol
regression coverage only. The lead separately inspected both screenshots and
the final in-app screenshot.

## Review and checks

Independent Sol review found stale preview context after a same-project rebind.
Luna found a background server surviving its launcher. Both fixes passed
independent review. Integration checks also caught manual-page replacement by
status polling, controls locked after a refused start, and a delayed status
response reviving a stopped command. Focused regressions cover these cases.

Automatic pull-request review found five more issues: unrecoverable pre-launch
refusals, unbounded request retention, concurrent port claims, transient probe
failures replacing the page, and standalone pnpm rejection. Focused fixes release
authored refusal states, reserve ports before asynchronous checks, and keep a
live page during a failed probe. Native executable signatures permit standalone
pnpm without enabling text or batch shims. The next review found that legacy
`bun.lockb` projects selected npm. Detection now includes that lockfile while
preserving explicit package-manager settings and pnpm precedence. Its regression
failed before the fix and passes afterward. Zo's installed Bun also reviewed,
started, served, and stopped a disposable legacy-lockfile fixture. Its port closed.

The final focused browser journey passed 33 checks after those fixes. A real one-shot
HTTP 503 preserved the iframe node, document marker, and typed input through
recovery. Actual child exit removed its page after manual reopening and permitted cleanup.
Independent review caught and fixed that manual-page ownership gap.
The authored-403 UI check injects a response at the real action boundary.
A separate backend test proves permission refusal occurs before process spawn.

Reviews expire after ten minutes and become invalid when the host restarts.
The host retains at most 128 requests, including pending starts. It removes only
expired records with verified process cleanup. A removed request cannot start
again. Existing live retries and Stop remain available when capacity is full.

The 13 focused process tests cover real servers, concurrent port claims,
request retention and expiry, host restart, permission refusal, and launcher
resolution. The suite includes immediate POSIX group cleanup on launcher exit
and a probe paused across Stop. All 36 shell tests, TypeScript, Native doctor,
and the production build passed. The pull request records final workflow checks
and review results.

Private evidence remains in the existing `.tmp/existing-folder-private-recovery/`
directory, including `preview-ui-run-integrated/`,
`preview-ui-pr82-review-proof-run-4/`, and `agent-proof-20260922-c/`.
Profiles, source fixtures, screenshots, and transcripts remain private.

## Remaining acceptance

Issue #30 owns authenticated phone-to-host routing. A host-local preview requires
confirmation and must not silently address a phone's loopback interface.
Browsers without credentialless-frame support cannot embed live pages.

Windows and macOS preview execution have not passed their packaged journeys.
On Windows, cleanup after a launcher has already exited remains unsupported.
The app reports failure without signaling a saved PID. Foreground commands are
the supported path. Keep this case in #8's Windows acceptance.

This receipt does not close #8, #14, or #15, accept a release, or replace the
owner-reported protected-folder Windows baseline. Generic packaged-folder
privacy, clean-profile first launch, Windows lost-response/recovery injection,
and the remaining complete desktop journeys still need their own evidence.
