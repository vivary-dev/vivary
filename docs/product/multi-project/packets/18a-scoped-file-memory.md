# 18a: Reload scoped file memory across conversations and restarts
Type: packet
GitHub-issue: https://github.com/vivary-dev/Vivary-New/issues/21
Parent: 18
Status: needs-info
Depends-on: [04a, 11a, 09b]
Owner: Root-assigned Native context and file-memory integrator
Scope: Wire compact project guidance and sourced durable notes into existing Native runs, with visible correction and active-memory removal.
Verification-kind: runtime
Needs: 04a supplies project session identity, 11a supplies visible correction, and 09b supplies original scoped retrieval actions.
Timebox: One coherent user-visible increment with focused checks and review.

## Goal

Record one confirmed project fact through the GUI, retrieve it in a fresh
conversation after restart, correct it, and remove it from active memory.

## Context

Read [ENGINEERING.md](../../../../ENGINEERING.md), the [current design](../design.md),
[Agent-Native ownership](../native-owners.md), and the [original source map](../research/original-vivary-product-map.md).
Agent-Native owns application actions, runs, and conversations. The original
creator owns setup operations, and Tropo owns project retrieval. The coordinating
agent (`root`) assigns one source writer before activation. Follow the live
repository delivery rules.

Follow [file memory and persistence](../research/file-memory-and-persistence.md)
and the existing outcome 18 instruction/skill-learning rules. The current source
review disproved a blanket non-Git block for S5. Do not create that restriction
or mark it as an expected failure. This packet proves the actual application path.

## Owned files

- Native Code and Full chat context preparation through their supported public
  seams and related actions in `packages/workbench/server/`.
- The file-editing/memory presentation from 11a and the selected guidance files.
- Existing Tropo context integration only where project-scoped retrieval needs it.
- Focused loading/correction/scope tests and the real memory GUI journey.

## Done condition

Both Code and Full chat resolve the current authorized project at each run,
read compact instructions/state, and retrieve relevant durable facts from their owning files. A fresh conversation
and application restart recover the confirmed fact without replaying an old chat.
The UI shows where memory is stored and when changed context becomes effective.
New authored memory defaults to `.vivary/knowledge/`, with configurable file
locations and visible role assignments. Keep it eligible for versioning and
separate from `.vivary/memory/`, which already belongs to disposable semantic
provider state. Do not move or reinterpret existing provider data automatically.

Correcting a fact updates its owner instead of adding a competing statement.
Forgetting removes it from active memory retrieval, with explicit disclosure that
historical transcripts, versions, and backups may remain. Switching projects
never imports another project's private context. Global owner or machine-memory
access requires a separately defined grant and is not implied by a file link.

Basic continuity works without Brain, semantic providers, VCS, Beads, or Entire.
Native remains the owner of conversations, tools, and runs. Source notes and
progress updates do not automatically become instruction or skill changes.
Existing reviewed learning rules still govern those changes.

## Verify

Use the GUI to save, restart, recall, correct, and forget one sourced fact.
Run this journey in both Code and Full chat. Exercise two projects with
distinct facts and verify isolation, including missing
or revoked access. Repeat the small continuity case with optional providers and
VCS disabled. Confirm default ignore rules and semantic-index cleanup cannot
exclude or remove authored notes. File existence or a manually supplied prompt
is not proof of loading.
Use existing model-call authority and budgets only for the necessary real-agent check.

```console
pnpm --dir packages/workbench typecheck
node --test packages/workbench/tests/project-services.test.mjs
git diff --check
```

## Stop conditions

Do not add a memory daemon, duplicate transcript store, automatic history import,
mandatory human gate for every ordinary fact, or new backend. Do not bypass private
source exclusions, authorize cross-project promotion, or claim complete historical erasure.

## Log

- 2026-09-13: Added to the combined implementation plan. Prerequisites are
  unresolved. No implementation or runtime acceptance is claimed.

- 2026-09-13: The desktop target selects configurable project-file memory, fresh-session recall, and external transcript storage. Basic memory is required. Optional semantic services are not.

- 2026-09-25: Implemented and unit-tested on branch `feat/scoped-file-memory`. Tropo types
  one Markdown file per fact as `vivary_fact` in `.vivary/knowledge/` and the memory role
  folders. The creator bridge reports roles, the state file, memory folders, and ignored
  folders. `project-memory.ts` renders one bounded block per message for Code and Full chat,
  and the Details Memory section remembers, corrects, and forgets facts through their files.
  Project chats lose Native's owner-wide memory actions. The GUI journey, restart,
  real-agent, and Windows checks have not run, so acceptance is pending.

- 2026-09-25: The [receipt](../receipts/18a-scoped-file-memory.md) records the hosted
  journey on `17e2996e`, which passed three runs in a row with a fake provider and an app
  restart, and one real Codex conversation that recalled and corrected a fact. Packaged
  Windows acceptance, a real phone, and optional semantic providers have not run. The
  work is not accepted.

- 2026-09-25: PR #93 is open. Pre-merge review fixes deny Native's database tools in project
  chats, make memory privacy fail closed, send the full block on every Codex turn, and harden
  the cache, the block bounds, and Windows paths. Unit tests cover them until the hosted journey
  runs again.
- 2026-09-25: The lead reported the hosted journey and the real Codex check passed on
  `2324e7f`. Second review fixes load, correct, and forget only the fact files the engine
  checked, read `.gitignore` with a byte order mark, treat unreadable bracket rules as
  matching, name only loadable law files, split conflict notices by action, and separate a
  permission refusal from a lock off Windows. Unit tests cover them until the lead reruns
  hosted QA.
- 2026-09-25: The lead reported the hosted journey and the real Codex check passed on
  `865f39e`. Third review fixes narrow the uncertain bracket rule to POSIX classes and
  unclosed brackets, list memory folders with one rule set on both sides, keep odd names out
  of `checked_files`, bound its size, and report links and uncheckable names with their own
  reasons. Unit tests cover them until the lead reruns hosted QA.
- 2026-09-25: The lead reported the hosted journey and the real Codex check passed on
  `a7251ea`. Fourth review fixes treat a bracket body with a backslash or a leading `]`,
  `!]`, or `^]` as uncertain, escape the remaining controls in fact text, and confirm links
  with `lstat` on Windows. Unit tests cover them until the lead reruns hosted QA.
- 2026-09-25: The lead reported the hosted journey and the real Codex check passed on
  `05bed13`. The fifth review changes memory's matcher so it can only over-match: it ignores
  negations, matches either case, reads an unbounded `**` across `/`, matches UTF-8 bytes,
  and splits `.gitignore` lines as Git does. A differential test against
  `git check-ignore` covers it until the lead reruns hosted QA.
- 2026-09-25: The lead reported the hosted journey and the real Codex check passed on
  `aa568d9`. Sixth review fixes read star runs as Git does, treat a negated bracket with a
  capital literal as uncertain, end an entry at a NUL, and replace the regex matcher with one
  that cannot backtrack. A seeded cross product joins the differential test. Unit and
  differential tests cover them until the lead reruns hosted QA.
- 2026-09-25: The lead reported the hosted journey and the real Codex check passed on
  `0e9ae6b`. Seventh review fixes give each context read a fixed matching budget that fails
  closed and says so in the block and the panel, cap a rule at 256 characters, and add root
  `.gitignore` rows to the differential test. The lead completes the receipt with the final
  hosted evidence.
- 2026-09-25: The lead reported the hosted journey passed three runs on `1bd2242`. Final
  review fixes restore the either-case pass for rules with a bracket, charge each rule and
  path pair to the budget, cache per-rule checks, and stop a read past 2,000 rules. Unit and
  differential tests cover them until the lead reruns hosted QA.
- 2026-09-25: The lead recorded the final hosted evidence on `6f5fb70` in `3205557`. Fixes for
  the Codex GitHub review findings pass the read binding into every write, re-check files
  before lock retries, confirm writes stay inside the root, bound one load's reads, key
  unreadable ignore files on their stat, and tighten the creator's answer. Unit tests cover
  them until the lead reruns hosted QA.
- 2026-09-25: The lead reported the hosted journey and the real Codex check passed on
  `22d4cc0`. Final verification fixes remove only a file the write made, count every byte a
  load reads, keep a late write from refilling the panel, and fix three small edge cases.
  Unit tests cover them until the lead reruns hosted QA.
- 2026-09-25: The lead reported the hosted journey and the real Codex check passed on
  `d1e24b9`. Follow-up fixes clean up after a failed post-write binding check and make
  Remove and a Rename's source delete remove only the checked file. Unit tests cover them
  until the lead reruns hosted QA.
- 2026-09-25: PR #93 merged into `dev` as `90ab1eb`. The `90ab1eb7` Windows package passed
  Remember, isolation, restart, recall, Correct, and Forget through Full chat. A real
  phone, optional semantic providers, and a Code run on Windows have not run.

## Shared desktop and web behavior

Memory save, recall, correction, and removal controls must work through desktop and narrow browser sessions. Memory remains in files on the connected host, with existing project and agent identity boundaries.
