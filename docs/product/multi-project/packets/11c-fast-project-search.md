# 11c: Search large project trees from the application
Type: packet
GitHub-issue: https://github.com/vivary-dev/Vivary-New/issues/13
Parent: 11
Status: done
Depends-on: [03c]
Owner: Root-assigned Workbench project-search integrator
Scope: Add scoped filename and text search with bounded work, useful matches and file navigation.
Verification-kind: runtime
Evidence: [Project search verification](../receipts/11c-fast-project-search.md)
Verification-result: passed
Timebox: One exact-search and source-navigation increment.

## Goal

Find a source file or text occurrence quickly in a large connected project and
open the matching file location without asking the agent to scan the whole tree.

## Context

Read [the desktop release target](../desktop-release.md),
[ENGINEERING.md](../../../../ENGINEERING.md), and [Native owners](../native-owners.md).
The existing inspector is a capped recursive Markdown/text/JSON list, not search.
Reuse authorized project resolution and available Native or CLI search primitives.
The separate [11d evaluation](11d-evaluate-zvec-search.md) owns zvec-grep adoption.
This packet supplies immediate filename, exact-text, and regex search.

## Owned files

- New `packages/workbench/actions/vivary-project-search.ts` and `server/project-search.ts`.
- A focused search panel beside the existing file components:
  `packages/workbench/app/components/projects/ProjectSearch.tsx` (the packet
  first named `app/components/files/`, which does not exist; file UI lives
  under `components/projects/` and `routes/files.tsx`).
- Existing `vivary-code-files.ts` and shared file navigation, coordinated with 11a.
- Existing `local-code-agent.test.ts`. Focused search scope, limits and cancellation tests.
- Desktop packaging only if the accepted search backend requires a bundled binary.

## Done condition

Filename and content searches run only within the current authorized project.
Results show paths, line numbers and excerpts and select the matching file location.
Respect project ignore/privacy rules and skip unsupported binary content by default.
Queries have explicit limits, cancellation and progressive results. Stale responses
cannot replace a newer query or appear after switching projects.
Measure cold and warm queries on a representative large fixture and record its size.
Keep any index in private app data, rebuildable from source and updated after edits.
The active agent can invoke scoped search through its supported Native tools or
bundled CLI. A GUI-only search field does not complete this ticket. Keep exact
search available without an index, model download, or semantic provider.

## Verify

Exercise large and small projects, no matches, Unicode/spaces in paths, changed
files, ignored/private paths, revoked access and query cancellation through the GUI.
Use a focused disposable fixture, ordinary timeouts and the existing test runner.
Record observed latency and memory. Do not add a benchmark service or model calls.

```console
node --test packages/workbench/tests/local-root-provider.test.mjs
pnpm --dir packages/workbench typecheck
git diff --check
```

## Stop conditions

Do not accept arbitrary shell commands, search other projects by fallback, put
indexes in user folders, or require a paid embedding service for basic text search.

## Log

- 2026-09-13: App-owned project search is absent. 11d owns the optional semantic engine.
- 2026-09-18: Implemented on `feat/11c-project-search` as a Node walk with no
  index, shell, or bundled binary. `server/project-search.ts` reuses the project
  file surface's skip list, secret filter, symlink and hard-link refusal, and
  text sniffing (exported from `server/project-files.ts`), matches file paths,
  literal text, or a regular expression per line, and returns path, line,
  column, and a bounded excerpt. Explicit limits per request: 50,000 scanned
  entries, 2,000 files read, 200 matches, 20 matches per file, 2,000-character
  lines, depth 16, 1.5 s time budget, 256 KB per file. A limit stops the
  request with a named truncation and a `continueAfter` cursor; the panel's
  "More results" resumes past it, which is how results arrive progressively.
  Cancellation: the panel's superseded requests abort through react-query;
  the server bounds work because browser callers carry no request signal.
  Staleness: results echo project, query, and mode; the panel's pure reducer
  ignores anything else and a project switch clears the panel with the other
  URL params. Matches open the file at the line through a new `line` param.
- 2026-09-18 measurements, observations from one disposable fixture (20,000
  files, 22 MB) on Zo's 9p filesystem under Node 22, not a benchmark:
  filename search over the whole tree 195 ms in one page after removing the
  per-file stat (2.3 s before); literal text and regex over all 20,000 files
  8 to 9 s total across 10 pages of 2,000 files (each page under its 1.5 s
  budget), first page in under a second; process RSS stable at about 240 MB
  across queries. The caps, not the host, bound each request.
- 2026-09-18 review corrections (Codex, GPT-6 Astra, two passes): the walk
  visits each directory at its sorted position and resumes from a cursor that
  names the last counted entry (a file, an unfinished directory, or a finished
  directory with a trailing slash), so for a tree that does not change between
  pages no match is skipped or repeated and every page makes progress, even
  through directory-only prefixes under a tiny budget. The time budget is a
  soft deadline checked between filesystem operations. The page match cap is
  exact (a file that would overflow it is deferred; a file's last returned
  match is marked when the per-file cap of 20 cut it), overlong lines are
  excluded from matching rather than blanked, and a FIFO swapped in for a
  file cannot block the open. Regular expressions run inside a vm
  context with a 200 ms per-file timeout; a file that exceeds it is skipped
  and counted in the result and the status line. The service accepts an
  AbortSignal and checks it between filesystem operations; the action
  forwards the request signal the framework supplies to tool callers, while
  browser callers carry none and rely on the caps plus react-query's abort
  of superseded requests. Files are opened without following a link at the
  leaf and the open handle's identity is compared with the inspected stat;
  a queued directory is re-checked before listing. Pages are tied to the
  full project binding identity, so a rebound project never continues them.
  Filename mode lists names from directory entries without a stat, so it
  applies the skip and secret rules but not the link, size, or text checks
  that content search applies; nothing is read in that mode. Time and
  cancellation are honored between operations; a single pending read or
  listing is not interrupted. Accepted residuals, recorded rather than
  claimed away: (1) a directory or ancestor replaced by a link while a page
  is running can redirect that page's later listings; Node exposes no
  `openat`-style handle-relative opens, the project file surface shares the
  same window, and the threat requires a concurrent writer inside the user's
  own project folder, and the open-time identity check is best effort because
  a filesystem may reuse an unlinked file's inode number for its replacement
  (a rewritten regular file inside the project is then read as itself);
  (2) browser callers carry no request signal through
  the framework's action transport, so a superseded panel query is abandoned
  by the client while the server finishes its bounded page; (3) the file
  reader re-centers the requested line on every navigation while a match is
  open, which also re-centers after an unrelated navigation in the same
  panel state; (4) a cursor describes a position, not a snapshot, so files
  changed between pages can be missed or seen twice.
- 2026-09-18 agent access (Jeff's decision): the selected harness owns its
  tools (`specification/harness-adapters.md`). Vivary injects no tools or MCP
  into Claude Code or Codex runs; Claude Code runs with Grep and Glob scoped
  to the project folder, and Codex has its sandboxed shell there, so the
  active agent already searches inside the authorized project through its
  supported tools. `vivary-project-search` stays a GUI-only, read-only action.
  Exposing it to the app's own Native conversations would need the local
  project service to accept tool callers; that is a separate reviewed slice
  if wanted.
- 2026-09-18 verification: 33 focused tests across `tests/project-search.test.ts`,
  `tests/project-file-location.test.ts`, and `tests/project-search-state.test.ts`
  (all in the CI list), tsc and agent-native doctor clean, production build
  green, and a Playwright journey on a loopback build (register the fixture
  folder, text and filename and regex queries, invalid pattern, superseding
  query, project switch, narrow layout, open at line, re-selecting a match,
  a catastrophic pattern returning at once): 15 of 15 passed on the final build;
  screenshots retained privately on Zo. A latent type error in the runtime
  settings page, visible only after a fresh build regenerates the action type
  map, was fixed alongside. gitignore parsing is not implemented; the file
  surface's skip and secret rules are the current ignore policy.
- 2026-09-18: Accepted by Jeff after end-to-end verification of merged dev;
  evidence in the linked receipt.

## Shared desktop and web behavior

Verify touch-accessible results, cancellation, and navigation to the matching file at narrow widths. Search executes inside the authorized project on the connected host.
