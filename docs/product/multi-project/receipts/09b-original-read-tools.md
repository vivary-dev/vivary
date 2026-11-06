# Original project read tools acceptance

Evidence-record: 09b
Date: 2026-09-24
Issue: [#19](https://github.com/vivary-dev/Vivary-New/issues/19)
Latest verified source: `e6ccddf53901f216276a97fd6a790be58ac8b479`
Hosted result: the 12-step journey passed three runs in a row on `e6ccddf5`, with Workbench and the bundled Python runtime built from that commit, and three runs in a row each on `64c227eb`, `db2be221`, `480e616e`, and `9e9b0d82`. It also passed on `bd12e620`, after a first run there stopped at its first step, described below, and on `9c026639`, `366ce16c`, `8576af0e`, `cc54be25`, and three times on `e87099d1`. A local fake model provider drove the agent, so no real model was called.
Packaged Windows result: the unpublished `e87099d1` package passed the full panel, agent, isolation, missing-folder, restart, and no-Git journey. The unpublished `8576af0e` package then passed the journey's affected steps on the same profile. The unpublished `bd12e620` package opened that profile and passed the checks listed below. The final `e6ccddf5` package then passed the panel reads and the agent turn on that profile on 2026-09-25.
Delivery status: [PR #89](https://github.com/vivary-dev/Vivary-New/pull/89) merged into `dev` as `bd57c4b` after the owner approved its Entire trail. The owner closed issue #19 on 2026-09-26.

## Result

The Details panel and the Native agent read five reports about the selected
project: Doctor, the note check, context find, optional capabilities, and the
sanitized command receipt log. Both call one module,
`packages/workbench/server/project-read.ts`, and receive the same result. The
agent tool `vivary-project-read` has no project field. Its project comes from
the chat's pinned scope. The panel's owner action names a project ID, which the
existing project-services admission resolves. Neither path accepts a host path.

Doctor, find, and check run the front door's `--public` path. Doctor checks the
workspace's files and settings without reading notes. Find and check read
through Tropo's privacy-filtered facade. A Git worktree uses its ignore rules. A
Vivary workspace without Git uses the workspace policy. Any other folder, or a
Git worktree on a host without Git, gets a clear refusal from find and check
instead of results.

The original runner runs reads in parallel and runs a write alone within its
project. A caller waits at the processor-sized ceiling, and a command that
cannot start within 30 seconds returns a retryable message. Each child writes
its receipt to a private file of its own, and the app appends it to the shared
log. The agent's tool call keeps caller `tool`. Project services match it to
its chat's project through the scope the request carries, and resolve that
project alone. The runner lets a tool call run the five reads and nothing
else.

## Review

A four-model panel reviewed `3c87c010`, and its accepted items were fixed in
`a18ebc1`. A second four-model panel reviewed `486f7a50` and found seven
issues, all fixed by `cc54be25`:

- Doctor reported findings from Git-ignored notes, with their paths and field
  values. `vivary doctor --public` now skips the note walk.
- Receipt totals counted only the latest 40 records. `logs --json` now adds a
  whole-log summary.
- Run failures reached project-read as untyped error codes. The runner now
  returns them as typed values.
- The chat resolver relabeled a tool call as an HTTP caller. It now keeps
  caller `tool` with an explicit read admission.
- The Core parent-walk guard caught every error and had no test. It now checks
  the rendered thread before the lookup, and a test covers it.
- A missing receipt log was detected by matching Python's stderr text. The
  runner now reports it.
- Parallel Python children could overwrite each other's receipt on Windows.
  Each child now writes its own file.

A third panel reviewed `8576af0e`. Fixes landed in `0ba213c`, `12a3735`,
and `208f565`:

- Public Doctor still named module folders that Git ignores. It now counts
  module index problems without naming them.
- Run folder cleanup could turn a finished write into an error. Cleanup now
  retries and never decides a command's outcome.
- Tool admission reached shared gates. One entry point in project services
  now admits a chat's tool call for its own project alone.

A fourth panel reviewed `366ce16c`. Fixes landed in `f3974ee`, `d9f4bc2`,
and `9c026639`:

- Public Doctor copied a Tropo exception that named an outer folder's host
  path. Public messages became fixed sentences.
- A governed write whose component recorded nothing still succeeded. It now
  fails with the receipt error.
- The send guard and the tool matched a chat to its project by two rules.
  Both now use the chat scope id.

A fifth panel reviewed `9c026639`. Fixes landed in `8842bba`, `7394a03`,
and `bd12e62`:

- Public Doctor's privacy still relied on each message calling a helper.
  Doctor now records each problem as a rule, and public output prints only a
  sentence from a closed table. A test fails when a rule has no public
  sentence.
- The chat match took its scope id from the caller. It now reads the scope
  from the request.
- A crash between the receipt append and cleanup could append a receipt
  twice. The app now deletes a receipt once it is appended, and a folder
  whose receipt was not appended waits for the next sweep.
- Shutdown returned before a stopped command wrote its receipt. It now
  waits for the receipt.
- Tests read the policy table they checked. They now spell out each
  expected receipt source, and the table carries a tool column that the
  runner enforces.

A sixth panel reviewed `1323cd8`, and each open comment from the Codex
reviewer was checked against the same head. Fixes landed in `d58fb68`:

- A component command that exited 0 without its receipt left no line, and a
  governed write in that state failed with nothing logged. The app now
  records every command whose component wrote no receipt, and such a write
  fails after its line is appended.
- A failed delete after an append kept the receipt's folder, and the next
  sweep appended the receipt again. The app now tracks whether it appended,
  and the sweep skips a receipt the log already holds. The sweep removes old
  `request-` folders again.
- Shutdown could return while an admitted command had not yet spawned. Each
  command is now tracked through its cleanup, and shutdown waits for all of
  them.
- Two modules read the chat scope. Project services now classify it once, as
  not a project, Personal, or a project. The runner takes the reads a tool
  call may run from the read command schema, which replaces the tool column.
- A source regex was the only check that every Doctor rule has a public
  sentence. `report()` now refuses a rule without one in either mode. Public
  output names missing files and ignore patterns again, from Vivary's own
  lists.
- The panel showed the previous project's report for one render, said "No
  matching context" when limits cut a search short, and hid skipped receipt
  lines. A receipt without a boolean `ok` counted as a success. These are
  fixed, and `.markdown` results open like `.md` ones.

The hosted journey on `d58fb68` then found three Project health panels. The
round-6 fix gave the read panel the same key as the adoption panel beside it,
and React duplicates siblings that share a key. `9e9b0d82` gives the read
panel its own key.

A seventh panel reviewed `f5145d6`. Fixes landed in `480e616`:

- Round 6 made shutdown wait for every command from its start, so a stalled
  project check could hold shutdown forever. Shutdown now waits for stopped
  children and for the receipts of commands whose child started. A command
  that has not spawned cannot spawn once shutdown begins, and one that
  arrives after it began is refused before it touches files.
- A cancel that landed before the spawn recorded a stopped run for a child
  that never existed. A run is now marked started only after the executor
  returns.
- The runtime check in `report()` could turn a missing table entry into a
  traceback inside adoption and repair. Rules are now a `DoctorRule` enum
  with one table of sentences and allowed values. A test checks the table
  covers every rule and, through the syntax tree, that every `report()` call
  names one. Nothing raises at runtime.
- The panel's receipt rows and heading defined failure differently. The CLI
  now counts a receipt without a true `ok` as failed in its filter, totals,
  and text, and the rows follow it.
- An incomplete find blamed every gap on limits. The panel now names the
  reasons from the report's own omissions. The panel keys itself by project,
  so a caller cannot collide with its key.

An eighth panel reviewed `0ac6108`. Fixes landed in `db2be22`:

- Round 7 let shutdown resolve before a stopped control command removed its
  request file. The request is now written only after admission and removed
  as soon as its child exits, before the receipt is recorded. A test stops a
  control command through shutdown and finds no request file when shutdown
  resolves.
- The round-7 incomplete note read Tropo's omission category where the cause
  lives in `reason`, so every real report showed the fallback. It now keys on
  kind and reason as Tropo writes them, names only causes that clear
  `complete`, and counts Git-ignored config and sensitive names as private.
  Its test uses rows exactly as Tropo emits them.
- Refusing a Native tool call had become a per-runner convention. The shared
  runner refuses one again for any verb outside the read schema, and checks a
  cancel before the spawn.
- `DoctorRule` is now an `Enum` whose values are the public rows, under
  `@unique`, so the parallel table and its sync test are gone. A project
  scope that matches no project is a 403 from project services.

A ninth panel reviewed `6926d79`, and its plan was debated with one of its
reviewers before it landed. Fixes landed in `64c227e`:

- Round 8 let project services' plain 403 errors leave the chat send guard
  unchanged. h3 answers any error that is not its own `HTTPError` with a
  500, and Core's client retries that up to eight times. The guard now
  turns a 401 or 403 into an h3 error with the same fixed message, and a
  test runs it through h3.
- A control command admitted just before shutdown could still write its
  request after shutdown resolved. The runner now checks closing and cancel
  before the write, registers the command with shutdown, writes, checks
  again, and spawns with no wait in between. The receipts object owns the
  request file.
- The panel's notes kept rebuilding Tropo's accounting from omission rows
  and were wrong in three rounds. They now claim only what the rows state:
  the private count reads `privacy_excluded` rows, a second line names
  sensitive exclusions by file and folder, and an incomplete report says
  so, naming the token budget only when a `budget_limit` row is present.
  PR #90 asks whether Tropo's facade should state these counts outright.
- The shutdown tests moved to their own files, so each shutdown runs in its
  own process. The control test runs two control commands on one project
  and finds that the queued one never writes a request.

A tenth panel reviewed `29c22db`. Fixes landed in `e6ccddf`:

- Core's privacy policy writes a sensitive-named file as
  `privacy_excluded/sensitive_name`, so the private and sensitive notes both
  counted it. Each row now counts in one note only.
- The tool resolver shared the send guard's h3 conversion. A Native tool
  call now gets a refusal with the `vivary_project_read_access` error code.
- Shutdown resolved before a stopped command's private folder was removed.
  It now waits for the folder, and a stopped command's duration ends when
  its child does.
- The round-9 control test also passed on the code before round 9. It now
  holds the request write, and it fails on the older ordering.
- CI's type-check never reached the server code, because the server is
  loaded through a registry that CI did not generate. CI now runs the
  package typecheck, which generates it first.

One reviewer then verified each of these fixes and found them clean. A
pre-existing chat client behavior, a sign-in prompt for project refusals,
is issue #91.

The round-6 PATH link check is withdrawn. It ran a synchronous `realpath` per
PATH entry on every command, and a PATH entry that links into a project is the
owner's own configuration. A rendered component test for the panel was
declined, because the hosted journey renders the real panel and caught the
key bug. The panel's display rules are unit-tested instead. Splitting the
runner file, which stays under 700 lines, is left for later.

Four Codex comments were declined. A schema-valid report is the command's
whole output, and Doctor and check exit 1 for findings, so the exit code
does not override the report. The receipts heading already names the filter
its list used. Whole-log totals need the full log read. Only the app appends
to the shared log, and Node opens it for append, which libuv maps to
`FILE_APPEND_DATA` on Windows (`fs__open` in libuv's `src/win/fs.c`), so each
line is one atomic append.

## Hosted journey

Each hosted run built Workbench and the bundled Python runtime from the tested
commit on Zo. The journey registered a Git coding project and created a Second
brain notes project through the GUI. The coding project holds two Git-ignored
files, one of them a decision with an invalid field value. Every run passed the
same 12 steps:

- A personal chat refused project reads.
- Each project's panel ran all five reads at once, and every report equaled the
  bundled CLI's output for the same project.
- A check finding link opened its file inside the project.
- The panel fit a 390-pixel viewport.
- The agent ran Doctor, check, and find in one turn and received the panel's
  exact reports.
- A model-supplied project ID, malformed input, and a path-like question were
  refused.
- The notes chat read only its own project.
- A missing folder showed Unavailable, the server answered 409, and the
  restored folder read again.
- Receipts listed the app's own find and check runs.
- Authored files stayed byte-identical in both projects.

On `8576af0e` and later, no report named the Git-ignored decision or its
value. The Python test for `doctor --public` creates a real workspace in a Git
repository with a Git-ignored note that has an invalid value. Plain Doctor
names the note, and public Doctor does not.

The first run on `bd12e620` stopped at its first step. The runtime menu's
Native chat choice did not open a chat within 30 seconds, and the page showed
no error. The next run on the same build passed all 12 steps. The crash repro
on that build opened 24 Native chat turns without the failure. Three runs
each on `9e9b0d82`, `480e616e`, `db2be221`, `64c227eb`, and `e6ccddf5` then
passed all 12 steps.

## Agent panel crash

Repeated hosted runs showed the Native agent panel's error boundary after a
refused tool turn. A focused repro reached it on its third turn. Core's
assistant message component walked to a parent entry that the thread store no
longer held. The existing Core patch now stops the walk at a parent the rendered
thread does not hold, without catching other errors. The repro ran 32 turns
each on `cc54be25`, `8576af0e`, `366ce16c`, and `9c026639`, and 24 turns
each on `bd12e620`, `9e9b0d82`, `480e616e`, `db2be221`, `64c227eb`, and
`e6ccddf5`, with no error boundary and no page error.
The remaining console errors are 404 responses from Core's thread lookup before
a new thread row exists and from Core's `available-clis` route, which Workbench
does not mount. The build before the Core change shows the same responses.

## Packaged Windows journey

Each unpublished Windows ZIP has 3,108 files. Their Workbench metadata reports
`sourceCommitVerified: false`, so source identity rests on the clean build and
package receipts.

| Candidate | Bytes | SHA-256 |
| --- | --- | --- |
| `e87099d1` | 223,729,572 | `7b09249f23b5987fe87c9d9d1b8c681932c1855c16dd9cb310225c714c52e177` |
| `8576af0e` | 223,730,222 | `6a57fa91666df3bf90e6214f882409bc0686374cc64b341dd868d53ecdc7032e` |
| `bd12e620` | 223,732,283 | `442475042220d70957d5057f7a5515292b5025e65f4449029824c1fa79adfaac` |
| `9e9b0d82` | 223,733,172 | `c135906d41fdb9b998aa9d76b517189f42e7ac8c46355a1dd58a66f8f3fba746` |
| `480e616e` | 223,733,740 | `41c6e7e2db7270b3f34be2eadfb9a305270fec5318899cb26606b9a35a90829c` |
| `db2be221` | 223,733,848 | `208532e3c33aa8aeb1be368a535756055ba95cc52ce7cddc36e908a8f0f21d8f` |
| `64c227eb` | 223,733,771 | `f7c1decc6a02fbbf13f367374317df7208b8f3a989f83cea958e183716f9ac75` |
| `e6ccddf5` | 223,733,935 | `16dc77871a3b49258c2a7755e12f43b8eef0a7341f2489af5a18683ca97847fd` |

The `e87099d1` EXE ran with an isolated application profile, no provider
credentials, and a local fake model provider. The GUI created two projects.
RelayService received two notes, a Git-ignored private note, and an `.env`
file, then became a Git worktree. FieldNotes stayed a Vivary workspace without
Git. With Git on the path:

- Check reported one private file excluded. Find for "gamma relay" returned
  `notes/relay.md` and `docs/routes.md` but not the private note that contains
  the same words. Result links opened their files.
- Optional features listed the Coding preset. Receipts listed 16 entries with
  no invalid lines.
- The agent ran Doctor, check, and find in one turn, and no tool result held a
  drive path, user folder, or candidate folder.
- A model-supplied project ID, a find without a query, a dash-leading query,
  and a path-like question were each refused. The panel stayed usable.
- FieldNotes check covered 4 notes, and find returned only `field-log.md`.
- Renaming the RelayService folder showed Unavailable. Restoring its name and
  choosing Retry read it again.

A restart with only `C:\Windows\System32` and `C:\Windows` on the path kept
both projects and the chat. RelayService check and find showed the refusal
that names the missing Git requirement. FieldNotes check covered 4 notes with
no errors, and find returned `field-log.md`.

The `8576af0e` EXE then opened the same profile, as an upgrade would. Before
launch, RelayService received a Git-ignored note whose `status` field holds a
deal name. The package's bundled `vivary doctor` named that note, and
`vivary doctor --public` did not.

- Project health showed Healthy with no findings. Nothing in the window named
  the private note.
- Note check covered 5 notes with no errors and 2 private files excluded.
- Receipts showed 3 of 29 commands failed. The shared log held 29 valid lines,
  including receipts that child commands wrote to their own files, and no
  per-run directory remained.
- The agent ran Doctor, check, and find in one turn through the tool admission.
  No tool result named the private note or held a host path. Refused input
  showed one period per message, and the panel stayed usable.
- Without Git, Project health still showed Healthy, and Note check showed the
  Git refusal. The chat survived the restart.

The `bd12e620` EXE opened the same profile and restored both projects and the
RelayService chat with its history.

- The package's bundled `vivary doctor` named the Git-ignored deal note.
  `vivary doctor --public` returned `ok` with no errors, no warnings, and no
  host path.
- Opening the project ran `adopt --json`. Its child wrote its receipt to a
  private file, and the app appended it to the shared log. The log held 42
  valid lines, and no per-run folder remained.

The panel reads and the agent turn did not run on this package or on the
later `9e9b0d82`, `480e616e`, `db2be221`, and `64c227eb` packages, because
the owner was using the laptop.

On 2026-09-25 the `e6ccddf5` package opened the same profile with the owner
away from the laptop. In RelayService's Project details:

- Project health reported Healthy.
- Check reported 5 notes, 0 errors, and 2 private files excluded.
- Find for "gamma relay" returned `notes/relay.md` and `docs/routes.md` and
  reported 2 private files excluded.
- Optional features and recent receipts both displayed.

A Native chat in RelayService then asked the fake provider's agent for
Doctor, Check, and Find in one turn. The agent called `vivary-project-read`
three times, and the reply read
`PROOF-DONE doctor:reported check:reported find:reported`. The tool results
named the project by its ID and label, with no host path and no private note.

Each normal close, including the `e6ccddf5` run, left no Vivary process within
20 seconds, and the provider and app ports closed. Both fixture folders matched their snapshots from before
each run in hashes, sizes, and modification times.

During the `e87099d1` run, an accessibility click on the find field shifted the
whole window up by about 40 pixels. A hosted probe then moved keyboard focus to
the same field at four window sizes, and only the Details panel's own scroll
container moved. The shift came from the automation's scroll-into-view request,
not from the app.

## Verification and limits

On `e6ccddf5`, the Workbench checks read their commands from `ci.yml` and
passed: typecheck, `tsc`, the two tsx lists (58 of 58, and 264 of 266 with one
existing skip and one Codex launcher timeout test that failed while another
job loaded the host, then passed three runs alone and in GitHub CI), the two node lists (28 of 28 and 12 of 12), and
`test:maintained`. The runner and read tests passed five repeated runs. Line
endings and `git diff --check` were clean. The vivary CLI suite passed 21 of
21.

`test_create_vivary.py` fails on Zo with or without this work, so it ran on
the Windows laptop from a clean export of `db2be221`. Its 74 Doctor tests
passed with one skip.

The `9e9b0d82` package's bundled plain Doctor named the Git-ignored deal note
in RelayService, and its public Doctor returned `ok` with no finding and no
host path.

A Zo restart rolled back the hosted run files for `486f7a50`, so this receipt
does not count them. The Windows runs used fixtures and a fake provider. They do
not claim a real model's tool choices. The hosted and Windows runs used
synthetic projects, not the ordinary user profile. The private handoff keeps
the screenshots, provider logs, and snapshot files.
