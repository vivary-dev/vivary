# Automation-written instruction files in the packaged app

Issue [#109](https://github.com/vivary-dev/Vivary-New/issues/109) comes from the #51 review. An automation run
could write `AGENTS.md`, `instructions/`, `skills/`, `LEARNINGS.md`, and `memory/`, and every later chat and run
loaded them. The owner decided on 2026-09-28 that such a file waits for the owner's review before a chat loads
it, and on 2026-09-29 that later runs skip it too, that a chat sees only how many files wait, and that a run
writes and deletes only its owner's personal files. This receipt records the packaged Windows check of that
branch.

Delivery status: open. The branch `feat/automation-file-review` has not merged. After this check it merged `dev`
at `42b1ebf` and took two fixes for the check's findings, `bda0a07` and `218cfab`. Those ran on Zo only and have
not run in a package. A later fix for a PR review finding ran on Zo only too. With it, each loader that lists
files checks each row it reads.

## Source and artifacts

- Source: `feat/automation-file-review`, branched from `dev` at `4c19c2e`. The check ran `e50ae89`, after the
  first implementation, the owner's simplification, and two review rounds. Each fix follows a test commit that
  failed for the stated reason.
- Package: `Vivary-windows-x64-e50ae89c.zip`, 223,928,640 bytes, 3,121 files, SHA-256
  `a91551de70679692e641ab7a0b5b24d98bca91df9472eba443b09f92aae14099`, built on Zo from `e50ae89` and checked on
  the Windows laptop. Its `build.json` names source commit `e50ae89c` with `sourceDirty: false`. Its Workbench
  output reads `prebuilt` with `sourceCommitVerified: false`, so the package does not itself prove that the
  server bundle came from that commit. The module check below finds the branch's code in it.
- Zo CI on `e50ae89`: workflow lines 112 to 115 passed 71, 455, 34, and 133 tests with no failure. Line 113 has
  one skip. The Python suite, the workbench typecheck, `agent-native doctor`, the HLDD checks, the CI workflow
  contract, `git diff --check`, and `test:maintained` passed.
- Provider: OpenRouter with `stealth/space-bunny-alpha`. The owner's key reached Vivary only through the launch
  environment.
- Profile: a copy of the #114 check's profile, with its three `vivary-114` automations paused before launch. It
  held the owner's personal `AGENTS.md` template, an app default `AGENTS.md`, and an organization `AGENTS.md`.
- Evidence: the accessibility tree and read-only reads of the app database. A Native chat thread stores each
  system prompt it sent, so the check read what a chat's prompt held from there. Screenshots were off. Times are
  UTC.

## What changed

- Every write a run makes records its run and thread. A write to `AGENTS.md`, `LEARNINGS.md`, or a path under
  `instructions/`, `skills/`, or `memory/` also gets a pending review mark in the row's metadata.
- The prompt loaders, the applied skill, the slash-skill menu, the files inventory, and `resources read` skip a
  waiting file. A chat's prompt gets one line with the count of waiting files and no path or text.
- A run writes and deletes only its owner's personal files, under a plain path.
- Settings > Automation files lists each waiting file with its text, **Accept**, and **Delete**. Both act only
  on the version the list showed. No chat, MCP client, or run can call them.

The patch notes own the detail:
[Automation-written instruction files](../../../../packages/workbench/patches/README.md#automation-written-instruction-files).

## Module identity

The build log's greps on `resources/workbench/.output/server/` matched in the package: one file holds the
scheduler's `Scheduler lease renewal failed`, the Core chunk `agent-native-core+[...].mjs`, `index.mjs` imports
that chunk once, and `server/node_modules` holds no `@agent-native` package. The #109 store and loader strings,
the refusal "outside the owner's personal files", the review note, and `runReview`, appear only in that Core
chunk. `resourceAcceptRunReviewIfCurrent` is also named in one 1,069-byte file that re-exports it from the Core
chunk, so the server has one copy of the store. The `vivary-automation-files` action is in `index.mjs` and
`_chunks/server.mjs`, and the Settings client asset holds the list's label "Files waiting for review", the
notice, and the failed-list line.

## Journey and results

| Step | Result |
| --- | --- |
| 1. A run writes files | `vivary-109-plant` was written into the copied profile before launch, in the format Core writes, with a yearly schedule so that it ran only on **Run now**. Its body made five tool calls. **Manage** > **Run now** started it at 20:41:53, and it succeeded in 12 seconds. The personal `AGENTS.md`, `instructions/vivary-109.md`, and a memory were written. The write and the delete of the shared `AGENTS.md` returned "Automation runs cannot write (delete) AGENTS.md outside the owner's personal files, because shared, organization, and workspace files load for other people." Four rows read `created_by agent` with the run's id and thread id, and a pending review mark naming the run and the automation: `AGENTS.md`, `instructions/vivary-109.md`, `memory/vivary-109-note.md`, and `memory/MEMORY.md`, which `save-memory` rewrote. The run's `AGENTS.md` replaced the owner's template. The app default `AGENTS.md` kept its id, size, and update time, and no other shared or organization row changed. |
| 2. Settings list, Accept, and Delete | Before the run, Settings > **Automation files** showed its heading, one sentence, and an empty list. After it, the list held the four files in path order, each with its path, its text as plain text, **Accept**, and **Delete**. **Accept** on `AGENTS.md` at 20:46:58 reloaded the list without it, and the row read `accepted` with the owner and the time, its origin kept and its update time moved forward. **Delete** on `instructions/vivary-109.md` at 20:47:14 asked for no confirmation and removed the row. The audit log recorded seven calls of the action, each from the front end by a person, and each succeeded. |
| 3. Chats skip a waiting file | No screen shows a chat's prompt before a message, and a new Native chat offers suggestion buttons, so a click started each chat with no typing. Before **Accept**, the chat's stored prompt held the app default and organization `AGENTS.md`, no personal `AGENTS.md`, none of the run's markers, and the note "2 instruction or memory files written by automation runs are waiting for the owner's review in Settings > Automation files." Its `resources read` of `AGENTS.md` and `memory/MEMORY.md` returned the review note. After **Accept**, a new chat's prompt held the personal `AGENTS.md` with `VIVARY-109 PLANTED` and nothing else the run wrote. That chat looked for a tool to accept or reject the files four times and found none. `vivary-109-probe`, run with **Run now** before and after **Accept**, replied `NONE` and then the marker. A run stores no prompt, so the run side is the model's report only. |
| 4. The changed notice | With the list open, `vivary-109-again` rewrote the waiting memory file at 20:52:01. **Accept** at 20:52:09 on the version the list showed was refused, and the audit log recorded the error with the old update time. The list reloaded with the new text and one notice, "This file changed since the list showed it. Read it again before you accept or delete it." The row stayed waiting. The automation was paused again before its next tick, so it ran once. |
| End | A quit with no run in flight took 15.47 seconds. No Vivary process was left. The evidence holds no key-shaped string. |

All four steps passed.

## Found in this check

- A chat's `db-query` read a waiting file's text. The chat that the **Explain what I am looking at** button
  started ran `db-query` unasked, selected the first 200 characters of `content` from `resources`, and got the
  waiting `AGENTS.md`, instruction, and memory text. Core's SQL tools scope that table by owner only. After the
  check, `bda0a07` adds `resources` to Core's list of tables the raw database tools refuse, and a probe on Zo
  showed that before it a `db-exec` could also clear the review mark. Chats read files through the `resources`
  tool, which skips a waiting file. This fix ran on Zo only.
- The note left out memory files. It counted only the files a prompt loader skipped, and no prompt loads a memory
  file but the index, a compact one not even that. The second chat's prompt held no note while two memory files
  still waited. After the check, `218cfab` counts every file that Settings lists. This fix ran on Zo only.

## Limits

Found in this check:

- A chat can read an automation's body with `resources read jobs/<name>.md`. The first chat did, and the plant
  job's body holds the marker text as its instructions. A job body is not an instruction file, so this is
  outside #109.
- A normal quit took 15.47 seconds, as in the #114 check, because the desktop's 15-second kill ends the server.
  Tracked in [#138](https://github.com/vivary-dev/Vivary-New/issues/138).

Known before this check:

- A waiting personal file hides a shared or organization file at the same path until the owner reviews it.
  Chats list no skill for it, and `resources read` gives the note, not the shared text.
- A run can still delete its owner's own instruction file or memory entry, and a run that overwrites one hides
  the owner's earlier text until review, as the run's `AGENTS.md` hid the owner's template here. Tracked in
  [#144](https://github.com/vivary-dev/Vivary-New/issues/144).
- Two writes to one row in the same millisecond that both read the row before either lands can store the same
  update time, so an **Accept** of the first text approves the second.
- A chat can list the waiting files' paths with `resources list`.

Not covered by this check:

- The fixes after it ran in `tests/automation-file-review.test.mjs` and a probe on Zo, not in a package.
- Hosted mode, organization runs, and the refusal of a path that is not plain ran only in the test file.
- The narrow layout and keyboard use of the Automation files tab.
