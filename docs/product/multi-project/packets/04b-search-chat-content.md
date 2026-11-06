# 04b: Search the contents of project chat sessions
Type: packet
GitHub-issue: https://github.com/vivary-dev/Vivary-New/issues/11
Parent: 04
Status: ready-for-human
Depends-on: [04a]
Owner: Root-assigned Workbench session-search integrator
Scope: Search authorized Native chat and Code transcript content with source links and pagination.
Verification-kind: runtime
Needs: Coordinator rebuild, real-app HTTP rerun and final desktop/390 px GUI acceptance.
Timebox: One session-search increment with focused authorization and real-history checks.

## Goal

Find a past conversation by words inside its messages and open the matching
session in its owning project.

## Context

Read [the desktop release target](../desktop-release.md),
[ENGINEERING.md](../../../../ENGINEERING.md), and [Native owners](../native-owners.md).
Vivary now scans owner-scoped Native messages and retained Code transcripts through
`vivary-chat-search`, independently of the twenty-run list and 400-event display.
Native records remain authoritative; this slice creates no derived index.

## Owned files

- Search and exact-match actions under `packages/workbench/actions/`, with bounded store readers under `server/`.
- Shared search, replay and match-marking components in the existing history and conversation surfaces.
- `packages/workbench/server/local-code-agent.ts` for authorized event-page reads; default windows stay unchanged.
- Focused search/replay tests and `tests/chat-search-app.mjs` for the normal built-app HTTP check and GUI seed.

## Done condition

Search matches message content as well as titles in both chat surfaces.
Results include project, session title and a useful matching excerpt. Opening
one restores the existing conversation at the matching message rather than
creating a new thread. Search covers retained events beyond the 400-event display
window and sessions beyond the twenty-run list. Each match has a stable native
message/event reference, and opening it loads the containing transcript page.
Scope and owner checks apply before reading transcripts or producing excerpts.
Archived and unassigned history have explicit filters using existing Native rules.
Removed active-memory facts may remain searchable in history. Explain that boundary.
Any derived index lives in private app data, can be rebuilt, and follows deletions.

## Verify

Use synthetic saved conversations with a term found only in an old message,
duplicate titles, multiple projects, archived history and a changed record.
Place one required match outside the latest 400 events and another beyond
twenty sessions. Open both exact messages through the GUI.
Verify pagination, cancellation, empty/error states and result navigation in the GUI.
Exercise restart without rebuilding authoritative history from a browser cache.
Use the existing test runner for scoped Code history and focused new search cases.

```console
node --experimental-strip-types --test packages/workbench/tests/chat-scope.test.ts
pnpm --dir packages/workbench typecheck
git diff --check
```

## Stop conditions

Do not copy transcripts into project folders, introduce another transcript owner,
or bypass Native access rules. Do not require an embedding service for text search.

## Log

- 2026-09-13: Drafted. Depends on accepted project-session bindings from 04a.
- 2026-10-05: #6 is accepted. Implemented owner-scoped title/content search,
  explicit archive/unassigned filters, bounded cursors, cancellation and exact
  Native/Code replay beyond the ordinary history windows. Coordinator checks
  outside the sandbox passed the build/typecheck, Code history (16/16) and Native
  chat (96/96); the first GUI pass identified usability fixes.
- 2026-10-05: Final review replaces per-message Native JSON traversal with one
  capped parse per session page and admits Code scope before the session cap.
  Search automatically continues with progress/Cancel, recent-first results,
  human dates and safe excerpt marks; retries keep hits/cursors. Clear/Escape
  restores the ordinary list. Match replay focuses a theme-visible mark, settles
  scrolling, includes the complete Native path and surrounding deduplicated Code
  context, and clears the transient Native browser import on exit. Malformed
  repositories and partial transcript lines no longer block/lose history; Native
  Personal results survive unavailable Code workspace. Focused socket-free
  regressions and typecheck support this round. Coordinator rebuild, HTTP rerun
  and final desktop/390 px GUI acceptance remain pending. No model calls, index,
  project-folder transcript copies or additional dependencies.

## Shared desktop and web behavior

Verify touch-accessible search results at narrow widths and opening the exact retained message without losing project context.
