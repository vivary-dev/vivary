# Project search verification

Evidence-record: 11c
Date: 2026-09-18

[Issue #13](https://github.com/vivary-dev/Vivary-New/issues/13),
[PR #63](https://github.com/vivary-dev/Vivary-New/pull/63), and the follow-up
[PR #64](https://github.com/vivary-dev/Vivary-New/pull/64) own acceptance and
delivery. Both merged into dev on 2026-09-18. Jeff accepted the issue on
2026-09-18 after the merged result was verified end to end.

## Verified behavior

- A Search surface beside Files, Details, and Preview finds file names,
  literal text, or a regular expression inside the selected project only.
  Results show path, line, column, and an excerpt; choosing one opens the
  file at that line, marked and centered, and re-selecting the same match
  navigates again. The command menu offers "Search project".
- Every request stops at explicit limits (entries scanned, files read,
  matches, matches per file, line length, depth, a time budget, and a
  per-file regex timeout) and says which one it hit. "More results" resumes
  from a cursor that names the last counted entry, so for a tree that does
  not change between pages nothing is skipped or repeated and every page
  makes progress, including through directory-only prefixes.
- The walk applies the project file surface's skip list and secret rules,
  skips links it sees, opens files without following a link and without
  blocking, compares the open handle's identity with the inspected stat on a
  best-effort basis, and skips binary, oversized, and overlong content.
- Results echo the project, query, and mode; the panel's reducer ignores
  anything else, ties continuation pages to the project binding identity,
  restarts after a rebind, and a project switch clears the panel. Superseded
  queries are abandoned by the panel through react-query's abort; the
  service also accepts a cancellation signal, forwarded for tool callers.
- A pattern that is too slow skips that file and the status line says how
  many were skipped; an invalid pattern is reported without scanning; the
  empty state says whether coverage was incomplete.
- No index, shell, or bundled binary. Agent access follows Jeff's decision:
  the selected harness owns its tools (Claude Code's Grep and Glob run in
  the project directory; Codex uses its sandboxed shell there), and the
  action stays GUI-only.

## Checks and limits

- 34 focused tests across the search service, the file location helper, and
  the panel state reducer, all in the CI list; tsc and agent-native doctor
  clean; production build green.
- Real-application journey on a loopback build of merged dev with a fixture
  project (an ignored dependency folder, a secret file, a binary, a Unicode
  and spaced path): registration, text, filename, regex, invalid and
  catastrophic patterns, open at line, re-select, superseding query, project
  switch, narrow layout with 40px targets and no horizontal overflow. 15 of
  15 steps; the unchanged tree-click path opens the plain reader and clears
  a prior line. Screenshots retained privately on Zo.
- Measurements, observations from one disposable 20,000-file fixture on Zo's
  9p filesystem: filename search over the whole tree in one page under a
  quarter second; text and regex over all files in 8 to 9 seconds across ten
  pages with the first page under a second; process memory stable.
- Merged dev at `f3b87ba`: Zo CI 63 of 63 applicable Linux steps; GitHub
  Actions green including both Windows jobs.
- Independent review: Codex (GPT-6 Astra), two passes. Twelve first-pass
  findings each fixed in their own commit; the second pass's correctness
  points fixed; four residuals recorded in the packet with reasons (an
  ancestor replaced by a link mid-page, no request signal for browser
  callers, re-centering on every navigation, a cursor is a position rather
  than a snapshot) plus the best-effort nature of the identity check.

## Acceptance

Jeff accepted issue #13 on 2026-09-18. The packet moves to done with this
receipt as its evidence. Existing-folder adoption, gitignore parsing, and the
optional semantic engine remain under their own issues.
