# Scoped file memory acceptance

Evidence-record: 18a
Date: 2026-09-25
Issue: [#21](https://github.com/vivary-dev/Vivary-New/issues/21)
Latest verified source: `285f65c76e4bc45756f8b89382cb9ffda257d60a`
Hosted result: the 11-step journey passed three runs in a row on `285f65c7`, the final code commit (runs `run-285f65c-01` to `03`), with Workbench and the bundled Python runtime built from that clean commit (`issue21-build-285f65c7.json` exit 0, runtime manifest `285f65c7`). It also passed three full runs on each of `d1e24b9`, `22d4cc0` (runs 01, 02, and 04), and `6f5fb707` (runs 04, 08, and 09), and three runs in a row on every earlier head back to `4fbc54ef`. Runs that stopped early on those heads stopped for the two Workbench reasons under Observations, never in a memory step. A local fake model provider drove Full chat, so no real model was called there. Git was not on the app's PATH.
Real-agent result: one Codex account ran two model turns per check. It passed on `d1e24b9` (run `codex-d1e24b9-01`) and `22d4cc0` (run `codex-22d4cc0-01`). After a restart, a fresh Codex conversation answered "The relay budget is 43 credits per week" with no tool events, and after a Correct the same resumed thread answered "47 credits per week". It also passed on every earlier head from `17e2996e` to `0e9ae6b`. On `1bd2242` and `6f5fb707` the Codex CLI on Zo answered 401 Unauthorized during a credential refresh, and it recovered before `22d4cc0`. `285f65c` changes only file removal and cleanup, not the Code prompt path. No real Claude Code turn ran, and no real Native-provider Full chat turn ran.
Packaged Windows result: the unpublished `90ab1eb7` package, built from the PR #93 merge, passed Remember, isolation, restart, recall, Correct, and Forget through Full chat on 2026-09-25, described under Packaged Windows journey. No Code run was part of the Windows check.
Delivery status: [PR #93](https://github.com/vivary-dev/Vivary-New/pull/93) merged into `dev` as `90ab1eb` after the owner approved its Entire trail and CI passed. Three-model reviews and the Codex GitHub review ran on each fix round. The final targeted verification of `285f65c` found the removal and cleanup fixes clean and one nit, recorded under Observations. Issue closure waits for the owner.

## Result

A project fact is one Markdown file with `source` and `confirmed`
frontmatter, saved in `.vivary/knowledge/` or a folder the `memory` role
names. Tropo types it as `vivary_fact`. The Memory section in Project details
remembers, corrects, and forgets facts through their files. Code and Full chat
load the project's instructions, state, and facts at the start of every
message. Project chats lose Native's owner-wide `resources`, `save-memory`,
`delete-memory`, and `chat-history` tools and its database tools `db-schema`,
`db-query`, `db-exec`, and `db-patch`. Personal and legacy chats keep them.

## Hosted journey

Each run used Workbench and the bundled runtime built from `17e2996e` on Zo
and passed the same 11 steps:

- The GUI created a thin project, Alpha, and registered a plain folder, Beta,
  that had no Git and no Vivary files.
- Alpha remembered "Relay budget". The file
  `.vivary/knowledge/relay-budget.md` held `source` and `confirmed`
  frontmatter, and `vivary check --public` reported 0 errors and no finding on
  the fact.
- Beta remembered "Deploy window" in its own `.vivary/knowledge/`.
- After an app restart, a Personal chat request carried no project block and
  kept Native's tools.
- A fresh Alpha Full chat request's system prompt carried Alpha's fact only.
  The fake provider removed the Full chat sentence about Native's owner-wide
  tools, hashed the rest, and that revision equaled the panel's last-load
  revision. The request's tools excluded `resources`,
  `save-memory`, `delete-memory`, and `chat-history`, and the block stated
  that those tools are unavailable.
- A fresh Beta chat carried Beta's fact only.
- Correct rewrote the same file. The already open Alpha chat's next request
  carried the corrected fact with a new revision.
- Forget showed the disclosure and deleted the file. The next request said no
  facts are saved.
- Renaming Beta's folder made the memory read refuse with 403 or 409.
- The Memory panel fit a 390-pixel viewport.
- No page errors appeared.

Core's compact resources context note still appears in project chat prompts.
Core cannot remove it per request, so the block says the tools are
unavailable.

## Real-agent check

Run `codex-17e2996-01` used one Codex account with model `gpt-6-astra`. After
a restart, a fresh Codex conversation answered "The relay budget is 43 credits
per week". Its transcript had no tool events and showed the note "Loaded
project context ctx-…: 1 fact from .vivary/knowledge, instructions from
AGENTS.md, .vivary/context.md, state from STATE.md." After a Correct in the
panel, the same resumed Codex thread loaded changed context, its note said the
context changed since the last turn, and it answered "47 credits per week".

Claude Code was not signed in on Zo, so no real Claude turn ran. Claude's
prompt path is covered by unit tests only. Real Native-provider Full chat
turns remain [issue #50](https://github.com/vivary-dev/Vivary-New/issues/50).

## Observations

- One journey run (04) got "The result is uncertain" on folder registration,
  with "SqliteError: database is locked" in the server log. Three later runs
  did not repeat it.
- One Codex run (03) got a "This fact changed after you opened it" conflict
  when the panel had loaded its view immediately after an app restart and the
  file had not changed. A replay on the same data made four clean
  corrections. The cause is not isolated. Stale file metadata on Zo's 9p
  filesystem right after the restart is suspected. The panel's "Use current
  version" recovers.

- After an app restart, choosing Native chat within about a second of the
  page load can be overwritten when the app restores the saved Code draft
  (`?run=new&draft=`). Four journey runs on `6f5fb707` hit this. The
  Workbench code is the same as on `1bd2242`, where it did not show. The
  journey now waits for the restore and confirms the choice held. This is
  a Workbench selection race, not part of project memory.
- Folder registration returned "The result is uncertain" with "SqliteError:
  database is locked" in two more runs on `6f5fb707`, five times in all.
  Retrying the same registration is the product's recovery. This is a
  Native database lock on Zo, not part of project memory.
- On `1bd2242` and `6f5fb707` the Codex CLI on Zo answered 401 Unauthorized
  while it refreshed its credential. One retry stalled on the database lock
  above. The credential is the owner's to repair.

- Known remove window: `remove`, which Forget uses, takes the file's
  identity a few system calls after its version check. If another program
  replaces the fact at the same path inside that window, Forget can delete
  the newer save. The file stays inside the project, and the window existed
  before the final fixes. A separate follow-up covers taking the identity
  from the version check itself.

Journey script bugs fixed during QA are not product findings.

## Final fixes

The last code commit, `17e2996e`, rolls back a Code turn's context revision
when the turn fails, stops, or is interrupted, so the next resumed Codex turn
sends the full block. Only the Full chat block names Native's owner-wide tools.
The revision is the SHA-256 of the Code form of the block, so Code and Full chat
loads of the same content share one revision. The hosted journey and the Codex
check above ran on this commit.

## Pre-merge review fixes

A pre-merge review of PR #93 and the Codex GitHub reviewer found issues that
the next commits fix. The hosted journey and Codex check above predate them,
and unit tests cover them until those checks run again:

- Project chats also lose Native's database tools, which could read the
  owner-scoped resources table.
- Memory privacy fails closed. A positive `.gitignore` rule matches without
  regard to case, including letter-bracket rules, and Remember checks the
  exact new file name against the rules. The fifth review replaced this
  matcher with one that ignores negations. Correct and Forget refuse an ignored
  fact file. Doctor's own matching is unchanged.
- A resumed Codex thread gets the full block every turn, like Claude. The
  unchanged-line branch and its revision rollback are removed.
- The context cache is reused only when the files it depends on did not change
  around the engine call, and invalid answers are never cached.
- The block escapes control characters in paths, reserves room for
  instructions, bounds every path list, names law files past the first three,
  and says facts come from files that anyone who can write to the project can
  change.
- A locked or unreadable fact file becomes a skipped entry or a fixed message,
  and non-portable Windows paths are refused.

## Second review fixes

A second review of `3e21310` and `2324e7f` found places where memory failed
open or said the wrong thing. Unit tests cover these fixes until the lead
reruns hosted QA:

- The engine reports the Markdown file names it checked in each memory folder.
  The Workbench loads, corrects, and forgets only those, so a file past the
  engine's first 200 names or created during its call is skipped as not
  checked. This replaces the earlier claim that only ignored files are not
  loaded or changed.
- The engine reads `.gitignore` with or without a byte order mark, and a
  positive rule with a bracket it cannot parse matches. The third review
  narrowed this rule.
- Law files past the first three are named only when policy and privacy allow
  them. A
  private, boundary, protected, or non-portable law file is never named.
- Forget notices never mention a draft, and a Forget of a removed file says it
  was already removed.
- A lock is EBUSY, EPERM, or EACCES on Windows and EBUSY elsewhere. Elsewhere
  EACCES and EPERM are a permission refusal with their own wording.
- The settings message and paths escape C1 controls and the Unicode line and
  paragraph separators, and every memory write failure has fixed wording.

## Third review fixes

A third review of `865f39e` found that parts of the second round were too
broad or could stall. Unit tests cover these fixes until the lead reruns
hosted QA:

- Only a POSIX class, an equivalence class, or a collating symbol inside a
  bracket expression, or an unclosed `[`, makes a rule uncertain. Ordinary
  sets such as `[._]*.sw[a-p]` and an escaped `foo\[bar` no longer make
  every memory folder private. The fourth review narrowed what memory reads
  itself further.
- The engine and the Workbench list a memory folder with one rule set. The
  engine leaves links and names the Workbench cannot carry out of
  `checked_files` and bounds its size, so one odd file name cannot fail the
  whole answer.
- The Workbench compares checked paths exactly and reports a link as linked
  and an uncheckable name as unsupported, the same on every load.
- Path lists stay inside their limits, and fact text turns every line and page
  break into a space.

## Fourth review fixes

A fourth review of `a7251ea` compared the bracket rule with Git 2.54. Unit
tests cover these fixes until the lead reruns hosted QA:

- A bracket body with a backslash, or one that starts with `]`, `!]`, or `^]`,
  makes a rule uncertain, so it matches. Git reads these forms differently
  from Python's `re`, and rules such as `[\d]raft.md` ignored files that
  memory still loaded.
- Fact text escapes every C0 and C1 control that it does not turn into a
  space.
- On Windows the Workbench listing counts a real symbolic link or a junction
  as a link. The engine counts only a real symbolic link and leaves a junction
  out of its checked files, so the Workbench skips it as linked, which fails
  closed.

## Fifth review change

A fifth review of `05bed13` ran memory's matcher against Git 2.54 and found
forms that still failed open. Memory's matcher now can only over-match. A
differential test and unit tests cover it until the lead reruns hosted QA:

- Memory treats a path as private when any positive rule could match it and
  ignores negations, so it may refuse a file Git would re-include. The owner
  can choose a memory folder that no rule matches.
- A rule matches in exact case or without regard to case, an unbounded `**`
  crosses `/`, and a rule and path match as code points or as UTF-8 bytes.
- A `.gitignore` splits only on a newline, as Git splits it.
- The differential test checks every case in its table against
  `git check-ignore` with `core.ignorecase` false and true. On Zo's Git 2.39.5
  it checks 34 cases and 76 files, misses none, and over-ignores 9. The
  previous matcher misses 19 of those files.
- The panel refuses control characters the context block would escape, so a
  500-character panel fact is never cut.

## Sixth review fixes

A sixth review of `aa568d9` ran randomized differentials against Git 2.54 and
2.43. Unit tests and the differential test cover these fixes until the lead
reruns hosted QA:

- A run of two or more stars reads the same whatever its length, as in Git,
  so `***/foo` and `a/***/b` match what Git matches.
- A negated bracket holding an ASCII capital letter outside a range, such as
  `[!B]`, is uncertain, so the rule matches.
- An entry ends at its first NUL, as in Git.
- The matcher tracks reachable positions without backtracking, and a rule
  over 1,024 characters is uncertain. The seventh review found the total cost
  still had no cap and added a budget.
- A leading `/` anchors a rule to its folder, so `/top.md` no longer matches
  `sub/top.md`. The earlier over-match was safe but broader than Git.
- The differential test adds a seeded cross product. On Zo's Git 2.39.5 it
  checks 368 generated cases and 2,944 paths with no misses and 429
  over-ignored. The previous matcher misses 8 of those paths.

## Seventh review fixes

A seventh review of `0e9ae6b` ran about 16,000 randomized cases against Git
2.54 in both case modes with no misses. Unit tests and the differential test
cover these fixes until the lead reruns hosted QA:

- Each context read spends from a fixed matching budget. When it runs out,
  every path not yet decided counts as private, and the context block and the
  panel say the ignore rules were too costly to check in full.
- A rule over 256 characters is uncertain, and a read parses each
  `.gitignore` once and decides each folder once.
- The differential test adds rows that use the repository's root
  `.gitignore`, including anchored and nested rules.
- A nested open bracket such as `[[]x.md` no longer prints a Python warning.

## Final review fixes

A final review of `1bd2242` found one regression and one unbounded cost.
Unit tests and the differential test cover these fixes until the lead reruns
hosted QA:

- A rule with a bracket always gets the either-case pass. The seventh round
  skipped it for rules without cased characters, but a range with uncased
  ends such as `[@-_]` spans letters that Git folds, so memory loaded files
  Git ignores.
- Each positive rule and path pair costs its rule length plus 64 budget units, the
  bracket check and the parsed rule are cached per rule, and a read that loads
  more than 2,000 rules stops and fails closed. On Zo 600 rules against 300
  files take about 0.85 seconds and 5,000 rules stop at once.
- The differential test adds rows and a generated dimension for letter-free
  rules built from such ranges. On Zo's Git 2.39.5 the generated set checks 488
  cases and 3,904 paths with no misses. Against the `1bd2242` matcher it
  misses 86.

## Codex review findings

The Codex GitHub reviewer left 21 inline findings on the later pushes. Three
were already handled or superseded. The rest are fixed after `3205557`, and unit
tests cover them until the lead reruns hosted QA:

- Writes pass the binding they read from, and project files refuse a
  different one. Remember re-checks the refreshed roles and protected paths.
  The Details view and the Full chat block resolve the project again after the
  load. A Code send compares `policyRevision`.
- A locked unlink or rename re-checks the file before each retry.
- A create, save, or Rename confirms the written file is inside the root with
  no link on its path.
- A load reads at most 4 MiB of fact and omitted law files, and omitted law
  files pass the same admission as the first three.
- An oversize or hard-linked `.gitignore` keys the memo on its stat.
- The creator bounds `ignore_files`, scrubs UNC paths, refuses a malformed
  thin marker, and probes folder privacy with an unlikely name. Tropo compares
  normalized owner folders.
- Confirmed dates must be real calendar dates, and the panel clears an
  unavailable project and never names a refused folder as storage.

## Final verification fixes

Final verification of `22d4cc0` found two warnings and four nits. Unit tests
cover these fixes until the lead reruns hosted QA:

- Cleanup after a refused write removes only the file this write made. It
  checks every path component for a link and the file's device and inode
  first, so a folder swapped for a link cannot send the delete to another file.
- Every byte a load reads counts toward the 4 MiB bound, and each listed file
  is read once.
- A write that finishes after the project became unavailable does not refresh
  the panel or reopen a draft.
- Tropo keeps an owner folder's trailing `/` when it compares folders,
  confirmed dates accept years 0 to 99, and a lock error during a retry's
  re-read becomes the fixed locked message.
- After `d1e24b9`: a create or Rename whose post-write binding check fails
  because the project became unavailable removes what it wrote. Remove, which
  Forget uses, and a Rename's source delete delete only the file whose version
  they checked, identified by device and inode, after checking every path
  component for a link again. Otherwise they refuse and delete nothing. File
  identities are compared as bigints.

## Packaged Windows journey

The unpublished `90ab1eb7` Windows ZIP has 3,118 files, 223,806,285 bytes,
and SHA-256 `0b4af397a49815046ab6a3fbc1983d6dc2b320195abe5855d9c878624c9282a3`. Its
Workbench metadata reports `sourceCommitVerified: false`, so source identity
rests on the clean build and package receipts. The EXE opened the retained
isolated profile from the #19 check with no provider credentials and a local
fake model provider. Git was on the app's PATH, and neither memory project was
a Git repository.

1. The GUI created two thin projects, MemoryAlpha and MemoryBeta. Remember
   saved "The relay budget is 43 credits per week" in MemoryAlpha, and
   `.vivary/knowledge/relay-budget.md` appeared. Remember saved "Deploys go
   out on Tuesdays" in MemoryBeta.
2. After an app restart, both projects returned. A fresh Full chat in each
   project received only its own fact, at revisions `ctx-081815a3c1f8` and
   `ctx-de185d92150a`, and the block said the memory tools are unavailable.
3. Correct changed the fact to 47 credits. The next message in the open
   MemoryAlpha chat received the corrected fact at `ctx-f183b53e7457`.
4. Forget showed that transcripts, Codex thread history, Git history, and
   backups may still hold the fact, then removed the file. The next message
   in the same chat received no facts at `ctx-228691c92b35`.

None of the four model requests offered `resources`, `save-memory`,
`delete-memory`, `chat-history`, or a database tool, and no project block held
a host path. Core's compact resources note still names save-memory, as on Zo.
A normal close left no Vivary process, the provider and app ports closed, and
the RelayService and FieldNotes fixtures matched their snapshots from before
the run in hashes, sizes, and modification times.

The first Correct attempt appended the new text to the old text, because the
automation's Ctrl+A did not select the field's text. A second Correct with
the text selected saved 47. The cause was not isolated.

## Not run

- A Code run on the Windows package.
- The narrow-browser journey on a real phone.
- The journey with optional semantic providers enabled.
