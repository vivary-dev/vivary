# 04b: Search the contents of project chat sessions
Type: packet
GitHub-issue: https://github.com/vivary-dev/Vivary-New/issues/11
Parent: 04
Status: needs-info
Depends-on: [04a]
Owner: Root-assigned Workbench session-search integrator
Scope: Search authorized Native chat and Code transcript content with source links and pagination.
Verification-kind: runtime
Needs: 04a accepted with stable project/session references and the legacy-history placement defined.
Timebox: One session-search increment with focused authorization and real-history checks.

## Goal

Find a past conversation by words inside its messages and open the matching
session in its owning project.

## Context

Read [the desktop release target](../desktop-release.md),
[ENGINEERING.md](../../../../ENGINEERING.md), and [Native owners](../native-owners.md).
Native's public chat hook already exposes searchThreads and loadMoreThreads.
Code history currently filters titles from only twenty returned runs.
Native records remain authoritative. A search index is derived and rebuildable.

## Owned files

- `packages/workbench/app/routes/agent.tsx`, `chat.tsx`, and 04a session navigation.
- A focused session-search action and helper under `packages/workbench/actions/` and `server/`.
- `packages/workbench/server/local-code-agent.ts` only for authorized history pagination.
- Existing `chat-scope.test.ts` and `local-code-agent.test.ts`. Add focused search cases.

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

## Shared desktop and web behavior

Verify touch-accessible search results at narrow widths and opening the exact retained message without losing project context.
