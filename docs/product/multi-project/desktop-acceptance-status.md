# Desktop acceptance status

Updated 2026-10-02. This page is the current tracked acceptance register for the
Windows desktop and self-hosted Workbench. GitHub issues still own task
scope and lifecycle. Dated receipts preserve detailed evidence. This page states
what a new contributor or tester can rely on now.

## Windows first launch and packaged runtime, September 23

The [issue #8 Windows receipt](receipts/23b-windows-desktop-acceptance.md) records
the unpublished `df4aedc` candidate and its current packaged-app journey.
The ZIP has 3,108 files, is 221,884,442 bytes, and has SHA-256
`85263c5dab59977e5c4a5b556e2742624abad01f98d33d135b63e9e30ecd2184`.

Zo build, 27 focused desktop and startup tests, five runtime-status tests,
and Workbench typecheck passed. Workbench build metadata still labels its
prebuilt output `sourceCommitVerified: false`.

A fresh application and Electron browser profile under the existing Windows
account opened without signup. The first-run path contained only Windows system
directories.

Bundled Node, Python, and SQLite supported the packaged GUI and
setup without a global Node or Python executable or source checkout. Missing
coding CLIs and a separate signed-out Codex state showed distinct setup guidance.
All 2,011 recorded original-profile file hashes matched before and after the run.

The native chooser selected a Unicode folder and Vivary opened its file.
Separate privacy approval changed only the reviewed ignore file. A later
four-file setup Apply survived an injected HTTP response loss. Retry reused the
same operation and left the written bytes, hashes, and modification times
unchanged.

A real Codex/Astra turn read project files, wrote the requested
result, and exposed tool output. Stop ended an active shell turn's descendants.

The packaged npm preview rendered in its frame, then Stop cleared the frame,
stopped the process, and released the port. A second launch reused the first
instance. Idle and active shutdown released observed processes and listeners.
Restart preserved the conversation and stopped status with an empty preview.

Earlier Explorer extraction and launch remain evidence for their named
candidates, not a new Explorer check on `df4aedc`. Independent review
accepted this candidate. The `df4aedc` ZIP is not the public
`9884670` prerelease. The [shared plan and apply receipt](receipts/07b-shared-workspace-plan-apply.md)
records the later #14 acceptance. Issues #15 and #23 retain their separate
acceptance.

## Original project read tools, September 24

[Issue #19's receipt](receipts/09b-original-read-tools.md) records the Details
panel and Native agent reads of Doctor, the note check, context find, optional
capabilities, and sanitized receipts. Both use one server module. The agent
tool takes its project from the scope its chat request carries and keeps
caller `tool`, and the runner lets a tool call run these five reads alone.
Doctor, find, and check use the original `--public` path, so files that Git or
the workspace marks private stay out of every report.

The 12-step hosted journey passed three runs in a row on `e6ccddf5`, with a
bundled runtime built from the same commit. Panel reports equaled the bundled
CLI's output. The agent received the same reports in one turn. A
model-supplied project, malformed input, and a path-like question were
refused. A missing folder showed Unavailable and recovered. Authored files
stayed byte-identical. A fake provider drove the agent, so no real model ran.

The unpublished `e87099d1` Windows archive passed the full packaged journey in
an isolated profile, including a restart without Git. The unpublished
`8576af0e` archive then passed the affected steps on the same profile. The
unpublished `bd12e620` archive opened that profile and restored both projects
and the chat. Its bundled plain Doctor named a Git-ignored note, and public
Doctor did not. A child's receipt reached the shared log, no per-run folder
remained, and the fixtures kept their hashes and modification times. The
final `e6ccddf5` archive, SHA-256
`16dc77871a3b49258c2a7755e12f43b8eef0a7341f2489af5a18683ca97847fd`, then
passed the panel reads and the agent turn on 2026-09-25. Project health,
Check, Find, optional features, and receipts displayed, and the agent
received Doctor, Check, and Find in one turn with no host path or private note.

The same work fixed a Native agent panel crash after refused tool turns through
the existing Core patch, with a regression test. Ten review panels' findings
are fixed. PR #89 merged into `dev` as `bd57c4b` after the owner approved the
Entire trail.

## Scoped file memory, September 25

[Issue #21's receipt](receipts/18a-scoped-file-memory.md) records project facts
saved as files, loaded by Code and Full chat at every message, and corrected
and forgotten from the Memory panel. The 11-step hosted journey passed three
runs in a row on the final code commit `285f65c7` with a bundled runtime built
from the same commit, a fake provider, and no Git on the app's PATH. It covered two projects,
isolation, a restart, Correct and Forget in an open chat, a refused folder, and
a 390-pixel panel. One real Codex conversation recalled a fact after a restart
and used the corrected fact in the same thread. No real Claude or
Native-provider turn ran. PR #93 merged into `dev` as `90ab1eb`. The
unpublished `90ab1eb7` Windows archive passed Remember, isolation, restart,
recall, Correct, and Forget through Full chat on 2026-09-25. No Code run was
part of the Windows check.

## Original review and control tools, September 26

[Issue #20's receipt](receipts/09c-original-review-control-tools.md) records
Review and Impact in Project details and in the `vivary-project-read` agent
tool, and Decide and Control in a new Evaluate panel and a second agent tool,
`vivary-project-evaluate`. Review and Impact use the original `--public` path,
which builds its graph only from notes that Git and the workspace do not mark
private. A link to a private note reads like a link to a missing id, and a
private Impact target gets the same refusal as an unknown one. The server
binds the actor. A tool call is always this project's agent, with contributor
authority, and the owner evaluates as themself or as that agent. The agent may
run decide, claim, release, expire_leases, and dependencies, and may not
submit a receipt, verdict, or execution log. Nothing is saved.

The 22-step hosted journey passed three runs in a row on `33cbcbb`, with a
bundled runtime built from the same commit. It covers owner and agent parity,
refusals of server-owned fields and owner-only operations, equal results for a
claim under a private file and under a random name, no host path in tool
results, unchanged authored files, one receipt per child run, and a 360-pixel
layout. A fake provider drove the agent, so no real model ran.

Two review rounds' findings are fixed in `5aa6aa6`, `24461c0`, and `33cbcbb`.
A third review of `33cbcbb` found no new issues. Native has no capsule
producer, so an agent
decide needs a capsule the owner hands over. The unpublished `1249572d`
Windows archive, SHA-256
`74573156a2add16a2e49c677fcedfffb4df4d064503e1a4779554f751c6ecc3a`, passed
Review, Impact, Decide, claim, and release in Project details and a 14-check
agent turn on 2026-09-26 with a fake provider. Project files kept their
snapshots. No real provider turn has run. PR #95 merged into `dev` as
`7fb73bd`, and the owner closed issue #20 on 2026-09-26.

## Conversation drafts, September 24

[Issue #9's receipt](receipts/17a-chat-restart-and-drafts.md) records the
clean `12c8b354` hosted and packaged draft journeys, including distinct
Native, Code, and unassigned drafts, exact IDs after changed-port restarts,
and the manual unsent on-screen keyboard `x` across refresh and restart.
Later `702f93e` and `1889fe6` fixes received focused fixture observations
for failed-save recovery, owner rejection, queued selection, older Code
follow-ups, and page hide. The earlier private hosted receipt files were
lost in a Modal snapshot rollback. Their reported observations remain
qualified fixture evidence, not a claim that the files survive.

The first `9682472b` package failed because its installed Core had an older
patch without the host-owned draft runtime behavior. The frozen lockfile
was unchanged. Reinstalling its pinned Core and Toolkit patches and
rebuilding produced a package whose Core chat and history chunks match the
working `1889fe6` package byte for byte. The initial hosted `9682472b`
check reached a Native `history=project` route but did not pass a stable
draft or existing-row check. The stale package is retained as failure
evidence, not acceptance.

The repaired unpublished Windows archive, SHA-256
`a4ccb0ebfb6e4788c5a7e0a9019c070b85ff5b859a9ee09495f35569238689e3`,
passed the affected packaged journey. The unsent keyboard text reopened
with a stable editor. Under a held SQLite write, choosing an existing
project Native history row kept its project owner mounted. Alt+F4 waited
until the lock was released. A changed-port bare-root restart restored the
exact selected conversation and full unsent draft. Seven tested drafts
remained unsent. The accepted user and provider counts did not change.
All 2,011 original-profile files retained their hashes, and candidate
processes and ports were closed. Workbench prebuilt metadata still says
`sourceCommitVerified: false`. Separate clean build and package evidence
carry the source qualification. The fixture did not call a real model.

All seven GitHub checks passed on the source, and the PR review threads are
resolved. PR #88 merged into `dev` as `0c8c7eb` on 2026-09-24, and issue #9
closed. At delivery, the GitHub and Entire `dev` refs matched that commit.
The Entire gate counted the author's approval.
Parent outcome 17 retains its separate gates.

## Built-in guidance, September 23

[Issue #16's receipt](receipts/07c-builtin-patterns-reconfiguration.md) records
hosted acceptance on clean `7784b8d9`. Capture, Sources, Navigation, and Project
brief compose with editable names and paths. The journey created a workspace,
edited its files, retired Sources, added Navigation, and reopened the same
project. Authored Capture and state survived. A changed choice invalidated its
preview, and retry recovered a lost Apply response without another write.
Desktop and 390-pixel layouts passed. A focused `1ae19565` journey also passed
legacy configuration migration, UTF-8 BOM preservation, long Unicode names,
and restart. No model call was requested.

The installed creator matched source and passed exact-file and Doctor checks.
Windows CI covered governed operations and orientation. This source has no
packaged EXE journey yet. Final artifact acceptance remains under #23.

## Populated-folder adoption, September 23

[Issue #17's receipt](receipts/08a-populated-folder-adoption.md) records current
hosted acceptance on `2d620af` and prior packaged Windows acceptance on
`f024979`. S2 adoption preserved 400 ordinary Markdown notes and 12 PDFs,
wrote the exact reviewed setup content, and reopened Files and guidance after
restart with the same project. Mixed-schema preview blocked an invalid record
without claiming unrelated notes as typed records.

Current-source fixes also preserve Vivary's internal records, report the actual
nested config path, resolve links against proposed documents and align inventory
with indexed extensions. A hosted preview of an existing ignore-file patch
showed the reviewed-change exception and preserved all files after Cancel.
All seven GitHub CI jobs passed, including Windows. The later fixes have not
run inside an EXE containing that source. The earlier Windows journey remains
qualified integration evidence, and final ticket #23 retains exact-artifact
acceptance. No model call was requested.

The original installed profiles remained unchanged during the Windows proof.
The packaged Workbench reports `sourceCommitVerified: false`, and no
post-restart Native HTTP response was captured. The public `9884670`
prerelease does not contain these unpublished changes.

## Owner session bootstrap, October 1

Issue #157 requires an owner proof before Vivary creates a local owner session.
The unpublished `15063405` Windows package, `Vivary-windows-x64-15063405.zip`
(222,418,656 bytes, SHA-256
`e369f720e116a04ccfd744b3fc67b75cd26c6c71576d8f8b7953861beaf77fa9`), passed the
packaged check on 2026-10-01 with fresh profiles and no provider credentials.

- The window opened directly into the signed-in workspace. A normal quit and a
  relaunch on the same profile kept it signed in.
- A profile first signed in under the earlier `0ac3bc10` package opened signed in
  on `15063405` at the same draft, and its owner session count did not change, so
  the existing session was reused.
- Raw requests to the desktop port from another local program returned 401 with
  no header, a guessed capability, or a one-time sign-in header. None returned
  owner data or a cookie.
- The desktop wrote no `owner-sign-in.txt`. None of the seven Vivary process
  command lines held a 43-character token or a secret header name. The server's
  arguments were only its port and data folder.
- Settings > MCP showed the local-owner note in place of Native's setup guides,
  and its link opened Coding runtimes.
- View > Reload kept the window signed in on the `0ac3bc10` package. It was not
  rerun on `15063405`, whose later changes do not touch the desktop session path.
- A normal quit ended every candidate process within 16 seconds.

Hosted checks on Zo are separate from that result. A Chromium journey in
standalone local mode signed in through the one-time address and refused a
replay. A disposable private-proxy instance behind the real Zo proxy did the
same. Its 393 proxied requests carried no `Cookie` header, and 381 were
authenticated by the `X-Vivary-Session` header. The package's Workbench output
keeps `sourceCommitVerified: false`, like earlier candidates.

## Browser access and isolated preview, September 30

Issue #30's unpublished `0c552b88` Windows candidate passed core physical Android
access, including pairing, project selection, restart, an authorized host file-tool
turn, draft recovery and revocation. Later phone preview and draft-refresh
observations are owner reports. Corrected denial wording after the final phone
refresh was not reported.

The unpublished `77282275` replacement uses Node 24.19.0, a slim shared work-panel
grip, contained Project details scrolling and saved keyboard-resize width.
Native Windows checks passed the slim divider, contained Details scrolling and
keyboard width restoration, with counter and live updates retained.
One earlier backend crash remains unattributed. The runtime update addresses a
known upstream defect without establishing that crash's cause.
The [issue 30 packet](packets/23d-self-hosted-browser-access.md) owns candidate
attribution and remaining limits. These results do not establish full desktop
release acceptance under #23.

## Project preview and debugging, September 22

[Issue #31's receipt](receipts/11e-live-project-preview.md) records reviewed
project commands, owned-process Stop, isolated module-capable preview, and a real
Codex/Astra repair loop on Zo. The integrated and focused review browser journeys passed.
The agent captured screenshots and inspected console/request failures, repaired
one import, and verified the page. Its image-viewing tool failed in Zo's sandbox,
which the conversation reported. The lead inspected the captured images.

The original conversation restored after restart and the corrected page appeared
beside it in Vivary. Phone routing remains under #30. The `df4aedc`
packaged Windows preview journey is recorded above. macOS preview execution and Windows cleanup after
an already-exited launcher remain unaccepted. The Zo result remains separate
from the Windows check.

## Existing-folder privacy and recovery, September 22

The generic existing-folder setup flow now offers a separately reviewed ignore
change when private recovery records lack protection. That confirmation changes
only `.gitignore`. The owner must then preview and confirm setup independently.
The approved ignore rule remains after subsequent cancellation or rollback.

Focused creator and application checks cover exact reviewed bytes, file
preservation, stale reviews, retry after a lost response, persisted operation
identity, tracked-runtime refusal, and interrupted setup recovery. A running local
app on Zo also passed visible folder registration, preview and cancellation,
privacy-only confirmation, stale-ignore refusal, refreshed setup apply, and
same-project/request replay after process restart. This used a disposable profile
and folder with no model call.

The runtime keeps uncertain operations pending when it cannot prove their
result. External edits after a possible write require restoration of the reviewed state before
retry. A publishing journal without its expected completion receipt still
refuses both replay and rollback. This increment does not change that boundary.

The owner reported protected-folder Windows acceptance on source `020fe0a5`.
The `df4aedc` Windows receipt above now covers the two-confirmation flow,
same-account fresh-profile launch, injected renderer response loss, and a real
agent turn. The later [#14 receipt](receipts/07b-shared-workspace-plan-apply.md) records
creator-to-service lost-result recovery and the affected Windows conflict and
stale-review journey. Issue [#15](https://github.com/vivary-dev/Vivary-New/issues/15)
retains its GUI creation and reconnect scope. The [issue #8 receipt](receipts/23b-windows-desktop-acceptance.md)
records its separate first-launch result.

## Shared workspace plan and apply, September 23

[Issue #14's receipt](receipts/07b-shared-workspace-plan-apply.md) accepts the
shared creator contract for new and existing folders on source `a800094`.
PR #47's bundled and hosted new-folder checks carried forward. Seven current
normal-app Zo cases matched Native and CLI existing-folder plans on one
physical target, then checked exact Apply bytes, a binary retained file,
conflicts, changed options and retained input, no-write replay, lost creator
result, and reviewed rollback after interrupted writes.

The unpublished `df4aedc` Windows package has unchanged affected app code.
Its GUI showed an existing-target conflict with disabled Apply. Changing a
retained binary file invalidated an approval. A fresh review applied four
exact files and reopened the same project in the applied state after restart.
The first Apply HTTP response and post-restart Native HTTP response were not
captured. The visible state, disk bytes, and creator receipt support the result.
No new model call was part of this #14 run. The earlier #8 Codex turn read the
created guidance and context. Issue #15 still owns its separate GUI creation
and reconnect journey. Full release acceptance remains under #23.

## GUI workspace setup and reconnection, September 23

The [issue #15 receipt](receipts/07d-gui-workspace-creation.md) records the
exact `27499cf` Workbench build and the hosted GUI journey. A managed project
created the five reviewed files. An authorized external folder registered,
previewed retained and proposed content, canceled without a write, refused a
stale review, and applied a fresh approved plan. Files and chat opened from the
selected project.

A same-path folder replacement required an explicit connection review at phone
width. Cancel preserved file bytes and modification times. Confirming restored
access under the same project identity. Two app restarts retained selection and
Files access. A project-scoped Native user message was fixture-seeded after the
first restart. The GUI showed it before and after a later reconnection and after
one subsequent restart. It was not a UI-authored or model-produced message.

A second same-process replacement showed **Review connection** after the owner
used **Refresh projects**. One earlier run lacked that control while the page
was still loading, without enough captured client state to classify it. The
settled refresh path passed.

The exact-source unpublished Windows EXE then created the managed workspace
through GUI review. Its five file hashes matched the Native preview. The
system chooser registered a separate long Unicode external folder and Files
opened its existing guidance. After a same-path, byte-identical folder
replacement and normal restart, the selected project showed **Review
connection**. The GUI displayed the full saved path and identity warning.
Cancel preserved all four files. Fresh confirmation returned Native HTTP 200
for the same project ID with binding revision 2. A second normal restart
restored Files access and kept the managed project selectable. The original
account profile's 2,011 recorded files retained their hashes and counts. The
package ZIP SHA-256 is
`d041f0aca7fe2edcb170259eea282476b80ee083f5d6d471f439605cbcbad6c6`.
Workbench metadata still reports `sourceCommitVerified: false`. No Windows
model or conversation-history persistence claim follows from this run. The
[issue #8 Windows receipt](receipts/23b-windows-desktop-acceptance.md) and
[issue #14 receipt](receipts/07b-shared-workspace-plan-apply.md) retain their
separate candidate and capture limits. PR merge and issue closure remain
pending.

The later `8fb3ed0` candidate fixes picker-selected children of the managed
Projects directory whose names do not meet creator naming rules. Its focused
Windows check passed saved-path review, explicit reconnection, same-project file
access, and file/profile preservation. The [#15 receipt](receipts/07d-gui-workspace-creation.md)
records this correction separately from the full `27499cf` journey.


## Release boundary

The [public Windows prerelease](https://github.com/vivary-dev/Vivary-New/releases/tag/desktop-preview-2026-09-22) contains the tested `9884670`
application. Stable desktop and self-hosted web acceptance remain incomplete.
The repository and download are public. No access invitation is required.

Exact source: `98846706227432e26f519d1b546889261eb08ff1`, the merged PR #78 commit.
ZIP size: 236,072,825 bytes.
SHA-256: `e9c0abf09e9e5a66c1dbea9ec3e05d479829138d35372b10c90a34124d1b81a0`.

The executable is unsigned and retains `version: 0.0.0`, `channel: private-preview`,
and prebuilt Workbench `sourceCommitVerified: false`. The tag pins the binary's
source, not later documentation commits. See the [install guide](../../desktop-preview.md).

Earlier archives remain available. Dated sections preserve their own candidate
evidence and do not imply retesting on the replacement.

### September 22 browser-link and lifecycle review of `9884670`

- Native Windows confirmation showed the complete URL and default Cancel choice.
  Explicit Cancel dismissed it without opening a preview tab.
- Confirmed Open launched Chrome at the exact path, query, and fragment.
  Interaction with the resulting page passed.
- Switching projects cleared the prior preview. Graceful close stopped all
  observed app processes and released the old listener. Restart retained the
  selected project and an empty Preview.
- Backups of 48 application-profile and 1,678 Electron-profile files passed hash
  verification before launch. Existing projects remained available.
- The archive checksum and clean source identity matched. Packaged `main.mjs`
  matched the source byte for byte. Distribution review found no profiles,
  authentication databases, or private continuity files.
- Twenty-seven desktop/startup tests and six applicable GitHub CI jobs passed
  on the reviewed fix head. The site job skipped. Source tests and simulated
  Electron events remain separate from the actual Windows checks above.

This bounded review does not repeat earlier full UI or model-runtime journeys.
Clean-profile onboarding, complete existing-folder registration, upgrade/removal
acceptance, Native-provider turns, and automations remain open. Historical Entire
trail-approval failures remain recorded. GitHub and Entire source refs were
verified separately from those approval results.

### September 21 visual review of `250aaa0`

- Direct Windows: checksum verification, launch with the existing profile,
  saved projects/conversation visibility, and real folder-chooser timeout recovery.
- Browser against the packaged app: setup proposals preserving existing guidance,
  unchanged fixture hashes, page owner label, interactive embedded page,
  same-project retention, cross-project clearing, Files/chat navigation, reload,
  and a 390-pixel layout with readable address-validation errors.
- The owner approved the screenshots, then authorized a GitHub prerelease.
- Seven [candidate GitHub CI jobs](https://github.com/vivary-dev/Vivary-New/actions/runs/35671130849) passed,
  including Windows governed verification and Windows/Linux orientation proof.
  The separate Entire gate failed on missing recorded reviewer approval, zero of one.

Native restart, minimum-width behavior, full native registration, conflict cases,
clean-profile first run, upgrade/removal acceptance, and real model turns remain
unrun on this exact candidate. Browser evidence does not establish native acceptance.
Setup code requires horizontal scrolling at ordinary split-panel width.
Browser Open folder still needs the desktop chooser. Setup preview has no GUI Apply.

The older-candidate evidence below remains relevant only to the scope it records.

## Windows evidence by candidate

### Broad `31d9afc` acceptance pass

The broad Windows journey ran on the `31d9afc` candidate. It verified Explorer
launch and extraction, bundled runtime use, managed project creation, project files,
Usage ranges and Workspace scope, approvals, a real Claude Code follow-up, Stop from
another project, restart recovery, draft persistence, second-instance reuse, and idle
and active process cleanup.

Observed application processes used the packaged Node and Python runtimes. The test
profile also had developer tools installed, so this does not prove a clean Windows
profile with no global Node or Python. Clean-profile acceptance remains open.

Usage opened successfully against the preserved application profile, which had no
Native usage records and reproduced the missing-table failure before W04. Separately,
the focused automated regression starts with a disposable empty database, returns
empty metrics, and proves that the metrics path creates `token_usage` before querying.

### Focused final `26798df` retest

The final `26798df` candidate retested the W05 containment and the artifact/lifecycle
seams most likely to regress. Windows Explorer extracted all 3,110 files at a deep
destination, and every extracted file matched the archive. A new Code conversation
showed plain `Claude Code · sonnet` identity with no Model button or provider path.
Runtime settings showed Claude Code and Codex as Ready, while the UI correctly offered
no unsupported Codex selection.

One approved Claude Code turn read the managed project's 79-byte `STATE.md`. Its raw
output matched disk and all five project files stayed unchanged. The completed
conversation retained its engine/model identity. A second Explorer launch reused the
same application window and retained that conversation. Final shutdown removed every
observed application process and released the listening port.

The focused final retest did not replay every broad `31d9afc` journey. W01 through W04
retain their broad `31d9afc` Windows evidence. W05 and the final artifact/lifecycle
seams have direct `26798df` Windows evidence.

### Codex integration candidate `3dd5aa8`

This later candidate was built and packaged on Zo and tested locally in the Windows
EXE. It has not replaced the published `26798df` archive. Its ZIP contains 3,107
files, is 234,930,723 bytes, and has SHA-256
`e53b3389f819322be2d7841f297ce0f613aafc036ff0297d11724bd46a7c26b8`.
Its full source commit is `3dd5aa8a7de4125b8508ed43ad69cef4a74f3975`.

The Windows journey verified:

- Codex subscription model discovery, including three consecutive refreshes, and
  recovery of a saved draft's historical `default` choice to GPT-6-Astra.
- An approved Codex turn read `PROBE.md`, copied it to `RESULT.txt`, and read the
  result back. Independent disk hashes matched. The UI exposed command details.
- A follow-up recalled the exact file marker without tools. The native Codex
  session ID stayed unchanged.
- Denial started no model or tools and created no output file.
- Stop from another project paused the Codex run. Its recorded worker and
  descendants exited, and the delayed output file stayed absent.
- Restart retained the selected project, transcript, runtime/model, and paused
  status. Closing the EXE removed the application processes and released its port.
- Runtime settings listed five Codex models and the configured connection names.
  Names establish configuration, not successful calls through every connection.

Earlier local candidates `6e86971` and `ab8ae26` exposed Windows discovery cleanup
races. A valid model catalog could be discarded when taskkill found an already
exited launcher or its pipes were still closing. The final candidate waits for
confirmed completion and keeps genuinely unconfirmed cleanup blocked. The failed
local packages were removed after shutdown; their receipts remain on Zo.

Evidence is retained on Zo under `.tmp/38-codex-integration/`, including native
screenshots, file hashes, transcript events, native-session identity, and process
snapshots. These checks used the existing authorized Windows profile. They do not
establish clean-profile installation or complete the broader issue #38 scope.

### Native Codex candidate `2f4a5df`

Commit `2f4a5df6b23a81789961bea1199fd20cec74df55` replaces the earlier
per-message launch approval and two-minute limit with native Codex action approvals.
Send starts a turn immediately. Runtime settings offer Normal, Read only, and YOLO.
Each turn keeps the permission mode selected when it starts. Progress and actual
subagent activity appear in compact cards, with the main answer as ordinary text.

The Zo production build and remote checks below passed. Its Windows ZIP contains
3,108 files, is 234,956,990 bytes, and has SHA-256
`b757e8d94711412ac1bb3b9420615972d5bb72e6e9dd3882b6469ee7940e23e8`.
The downloaded ZIP hash was verified and the replacement EXE launched on Windows.
The exact EXE verified immediate Send,
continuation of the existing native session, and a file copy with independently
matching SHA-256 hashes. The configured Node REPL returned `4` for `2+2`. One real
child appeared in a compact card with its public result. A local command completed
after 125.19 seconds and wrote the expected file. Screenshots and execution events
are retained on Zo in `.tmp/38-codex-integration/v2-windows-proof.json` and the
adjacent `v2-01` / `v2-02` screenshots.

After the unintended Escape pause, resumed Windows QA verified native command
Allow once and Decline. The allowed command wrote `ALLOW_PROBE`, and the denied
output file stayed absent. A second command reached its started marker. Stop from
another project ended its observed process, PID 22904. Its delayed output file
stayed absent beyond the command's 90-second delay. Closing the EXE through its UI
left no candidate process running. `v2-windows-proof.json` retains these results.

Read only performed a real file read, and the operating system denied its write.
The target file stayed absent. The setting persisted across restart. YOLO wrote
and read an authorized fixture outside the project without an approval prompt.
Normal was restored after these checks.
Windows QA also exposed two presentation defects: overlapping same-name tools
could merge, and pending native approvals could show a stopped-agent warning.

### Focused replacement retest `98515c9`

Commit `98515c91f4a8731c677e209498f49400a6f95a4c` preserves separate tool
inputs/results by native call identity. Native approval waits stay active, including
reopened conversations. The run-state API includes the phase needed by the client.
The first correction in `a1486b0` omitted that API field. Its failed hosted receipt
is retained, and the boundary regression now verifies the actual serialized state.

The final production build, all 75 focused tests, and type checking passed.
The 12 unchanged Native regressions also passed. Logs are `v4-build-run.log`,
`v4-all-tests.log`, `v4-types.log`, and `v3-native-regressions.log` under
`.tmp/38-codex-integration/`.

The replacement Windows archive contains 3,108 files and is 234,957,073 bytes.
Its downloaded SHA-256 matched
`160573c0632c103000502adc4625a0550c0b3dbdd97e69cebfda85d2c7362bd5`.
In the actual EXE, a Normal-mode approval stayed pending without a false stopped
warning, including after a Ctrl+R reload. The output file was absent before
approval. Allow once wrote `FINAL_98515C9`, and the final answer arrived in the
same native session. The saved output popover also displayed the retained result.
`v4-windows-proof.json` and adjacent screenshots retain this affected retest.

The earlier `2f4a5df` journey supplies the broader Windows proof above. The final
EXE retest covers the changed approval/display behavior, not a replay of every
journey. The final EXE preserved its completed answer and model after restart.
Shutdown left no candidate processes. Superseded local packages were removed, leaving
one extracted candidate and its ZIP. Profile and evidence were preserved. This is
bounded Codex prototype acceptance, not complete desktop acceptance.

The `3dd5aa8` results remain historical evidence for the earlier implementation.
They do not establish acceptance of the replacement execution policy or activity UI.
These candidates do not replace the published `26798df` private preview archive.

### Project-health candidate `43ae417`

Commit `43ae4171a56ab89069420a5512d1f735351e608a` is merged `dev` after
[PR #66](https://github.com/vivary-dev/Vivary-New/pull/66), which added the
"Check project health" block to the Details panel for
[issue #18](https://github.com/vivary-dev/Vivary-New/issues/18). The candidate
was built and packaged on Zo and tested on the laptop on 2026-09-18. It has not
replaced the published `26798df` archive, and no prerelease was opened. Its ZIP
contains 3,111 files, is 222,950,043 bytes, and has SHA-256
`b4ace1eb58b1715ccebcf40228af6c24840d980562fcb58198e79035b9e3f6db`. The laptop
verified that hash before extracting the folder.

The fixture was a disposable `writing` workspace created with the bundled
runtime, plus one ordinary note and an unknown `author` field in
`.vivary/context.md`, with no Git repository.

| Step | Result on `43ae417` |
| --- | --- |
| First launch | Pass. "Connected host" shown, loopback server on 127.0.0.1 |
| Runtime readiness | Claude Code ready, proven by the tool turn below. Codex showed "Check needed" because the laptop's npm Codex CLI 0.148.0 could not parse the configuration written by the Codex desktop app; a laptop environment gap, not the build. Codex readiness on this candidate is therefore not established |
| Register existing folder | Pass on the second attempt. The first attempt showed the generic "The folder could not be connected. Try again." after the native picker stayed open past the client action timeout; see [issue #68](https://github.com/vivary-dev/Vivary-New/issues/68) |
| Details shows "Not checked yet" | Pass |
| Check project health | Pass. `Healthy · 4 typed notes, 0 links` with one W202 warning, identical to headless `doctor --json` |
| Break and recover | Pass. `Needs attention · 5 typed notes, 0 links` with one E101 error and the W202 warning kept, identical to headless; removing the record and clicking Check again returned to Healthy |
| Narrow window | Pass at 488 px, the Electron default frame minimum; the health block, its warning, and Check again stayed reachable and clickable |
| Real tool turn | Pass. The Claude Code runtime wrote the requested file |
| Approval | Not rerun on `43ae417`, last proven on `98515c9` with Codex Normal mode |
| Denial | Not rerun on `43ae417`, last proven on `98515c9` with Codex Normal mode |
| Stop from another project | Pass. Writes stopped at 26 files and stayed there |
| Restart persistence | Pass. Project, three turns, and "Not checked yet" restored |
| Second-instance reuse | Pass. The second EXE exited, leaving one main process and one listener |
| Shutdown cleanup | Pass twice. No candidate-owned vivary, node, or python process remained, and the port was released |

Exact health comparison: headless `doctor --json` returned `ok: true`, no
errors, one warning
`tropo finding: .vivary/context.md:4: warning W202: unknown field 'author' for type 'project'`,
4 graph nodes, and 0 edges. The Details panel showed `Healthy · 4 typed notes,
0 links` with the identical warning line. With `changes/bad.md` missing its
`slice` field, headless returned `ok: false`, one error
`tropo finding: changes/bad.md:1: error E101: missing required field 'slice' for type 'change'`,
the same warning, and 5 nodes; the panel showed `Needs attention · 5 typed
notes, 0 links` with the same error and warning. An earlier expectation of
three notes was wrong; both surfaces count four (`AGENTS.md`, `STATE.md`,
`.vivary/context.md`, `notes/idea.md`).

Approval and denial were not rerun because this candidate launches the Claude
Code runtime with `auto-edit` permission mode and file tools only, so writes
inside the project never prompt, and Codex was not runnable on the laptop, as
the readiness row records. That is a laptop environment gap, not a build defect. Rerunning both with the Codex runtime in
Normal mode against a path outside the project remains due on this candidate.

Evidence is retained privately on Zo under
`.tmp/09a-windows-43ae417/laptop-evidence/`, with `doctor-headless.json` and
`doctor-headless-broken.json` one level up. These checks used the existing
authorized Windows profile and do not establish clean-profile acceptance.

## Defects fixed during Windows acceptance

| Finding | Current behavior |
| --- | --- |
| W01: Explorer extraction failed on long Python cache paths | Packaged Python omits runtime pip metadata and bytecode caches. Distlib's launcher license remains included. |
| W02: an invalid rename returned a generic server error | Project-boundary failures return a clear client error, such as `Choose a file inside the selected project.` |
| W03: project-name rules were hidden behind native validation | The form explains the ASCII character set, length, start/end rules, and Windows reserved names. |
| W04: Usage queried before `token_usage` existed | The metrics path creates its table before querying. A disposable empty-database regression returns empty metrics. |
| W05: CLI model aliases opened Native provider setup | The Code composer hides that picker and keeps the effective CLI engine/model visible as read-only text. |

## Remote Codex verification, 2026-09-16

The final `98515c9` hosted fixture held native approval for 4.5 seconds, reloaded
the pending conversation, and held it for another 4.5 seconds. Neither state showed
a false stopped warning. After approval, the final answer arrived. Native forms,
activity-card expansion through completion, and restart parity passed with no page
errors. The receipt is `native-ui-fixture-20260916T174242/receipt.json` under
`.tmp/38-codex-integration/`. This focused run skipped the earlier 125-second check.

The private preview was refreshed to `98515c9` output. Unauthenticated actions
still returned 401, and unauthenticated external access redirected with 302.
[PR #59](https://github.com/vivary-dev/Vivary-New/pull/59) merged into `dev` as
`b81dcd76a80613ae248eebacfb5f7d5a0269c1a7` on 2026-09-16. The merge tree matches
tested head `f21328ba21ad5a381d9c6f49247a5d3984fb0f03`; GitHub and Entire refs
were verified at the merge. All 62 applicable Linux workflow steps passed on Zo,
the approved CI host. Evidence is retained in `.tmp/zo-ci-codex-f21328b/`,
including the step logs, results, final proof, and merge proof. GitHub Actions
did not start because of billing. Windows governed-platform and orientation
workflow jobs were not run; the Windows UI evidence above remains separate.
The merge does not publish a new download or complete the broader desktop issues.

The `2f4a5df` production build passed on Zo. All 70 focused Codex, runtime,
approval, transcript, and lifecycle tests passed, with no failures or skips.
All 12 Native patch/storage regressions and type checking also passed. Evidence
is retained under `.tmp/38-codex-integration/` in `v2-all-tests.log`,
`v2-native-regressions.log`, `v2-types.log`, and `build-receipt.json`.

Real GPT-6-Astra turns through the production app verified immediate Send,
continuation of one native Codex session, context retention, restart/history,
fixed model identity, and saved permission settings. The earlier two-turn receipt
is `native-code-journey.json`. The latest build then displayed one actual Astra
subagent and its public result. Native child identity and completion events
establish delegation. Reopening the completed conversation preserved the card and
exact result on desktop and narrow layouts. `real-subagent-journey.json` and
`reopen-real-subagent.log` retain that result. An earlier native child receipt
marked `uiAccepted: false` records the rendering defect before this fix.

The deterministic production UI fixture separately verified:

- Command Allow once, file Decline, permission approval, question validation, and
  submitted MCP form values, including changing a visible checked default to false.
- One subagent card from native-shaped start/completion events for one child.
  Empty wait events created no extra cards.
- A card opened during a pending action remained open through completion and an
  actual live-to-history component remount. Restart retained the activity content.
- A turn remained active for 125.15 seconds, then stopped from another project.
- Desktop and 390px layouts in light and dark themes, no horizontal overflow,
  no browser errors, and cleanup of the test application.

The receipt and screenshots are in
`.tmp/38-codex-integration/native-ui-fixture-20260916T165256/`.
This fixture simulates Codex protocol events. It proves application handling of
those events, not real model execution, subagent execution, or external MCP calls.

Earlier remote checks verified runtime/model selection, saved choices, recovery of
legacy and retired draft models, and retained history when a folder was unavailable.
Codex file commands remain unverified on Zo because its restricted-network sandbox
failed with `bwrap: loopback: Failed RTM_NEWADDR`. The sandbox stayed enabled.
Windows candidates `3dd5aa8` and `2f4a5df` provide actual file-tool proof above.
A repeated Zo folder-fixture rename later failed with `EXDEV`. History stayed
readable, but that fixture could no longer prove folder recovery. Earlier successful
recovery evidence remains dated separately. No project grant was replaced to hide
the failure.

OpenCode Go separately completed a read-only file turn through its CLI using
`opencode-go/glm-5.3-flash`. It is not integrated into Vivary by this increment.
Broader issue #38 integration remains open. Real
Native-provider turns passed under #50 on the unpublished `265a7ede` Windows package,
and the [#50 receipt](receipts/50-real-native-provider.md) records the run and its limits.
PR #100 merged into `dev` as `8a5d262`, and the owner closed #50 on 2026-09-26.
The #51 automation lifecycle passed on the unpublished `c096528a` Windows package, with
automations created through a Personal Native chat. The
[#51 receipt](receipts/51-automation-lifecycle.md) records the run, a Zo check with no
client connected, three fixed defects, and the limits tracked in issues #108 through #115.
PR #116 merged into `dev` as `c39e22f`, and the owner closed #51 on 2026-09-27.
The fixes for #114 and #115 passed their packaged check on the unpublished `9e921ca0`
Windows package, and the [#114 and #115 receipt](receipts/114-automation-quit-and-status.md) records the run and
its limits. PR #137 merged into `dev` as `4c19c2e`, and #114 and #115 were closed on 2026-09-29.
Run-written instruction files (#109) passed their packaged check on the unpublished `e50ae89c`
Windows package, and the [#109 receipt](receipts/109-automation-file-review.md) records the run and its
limits. PR #151 merged into `dev` as `b63ed90f` on 2026-09-29 and closed #109.
The fixes after the packaged check ran on Zo only; `e50ae89c` is not final-head package proof.

## Capability and acceptance gaps

The Windows Code cleanup/status follow-up at `e240f31` has a
[source-verification receipt](receipts/windows-code-cleanup-status-source-2026-10-04.md)
with fresh Linux VPS test results. The historical packaged scanner failure
was not reproduced and its cause remains unknown. Replacement-package identity
and transfer, real desktop cleanup, Stop, and restart remain pending laptop
acceptance; this source result does not extend the packaged evidence below.

| Area | Verified now | Still required |
| --- | --- | --- |
| Code conversations | Windows `2f4a5df` file work, session continuity, MCP call, real subagent card, 125.19-second command, native Allow/Decline, active-command Stop, and shutdown | Linked conversations, and broader cross-runtime work under [issue #38](https://github.com/vivary-dev/Vivary-New/issues/38) |
| Codex CLI | Subscription turns, file tools, MCP call, child public result, long command, native action decisions, and command cancellation in local `2f4a5df`. The `df4aedc` Windows package completed a real Codex/Astra file turn and Stop | Further connection-specific journeys and broader issue #38 scope. The public `9884670` prerelease retains its earlier-candidate proof boundary |
| Native conversations | Project-scoped storage, history controls, saved-head repair, and deterministic-provider journeys. Real OpenRouter turns with project read and evaluate tools, follow-up history, project isolation, rename, pin, archive, Stop, provider failure, and Retry passed on the unpublished `265a7ede` package ([#50 receipt](receipts/50-real-native-provider.md)). The unpublished `0697293f` package recorded OpenRouter's reported $0 cost for a free model, read an old guessed cost as unknown, and labeled a reply the owner stopped before and after the next message (PR #128). The unpublished `9698ca24` package archived a chat from its row menu, restored one with the keyboard and one in the narrow sheet, showed the Restored line with Open, refreshed the section after another archive, and restored and opened a chat (PR #132). PR #132's commits from `2ae5b82` on have not run in a package | The limits in the #50 receipt. PR #126 closed #101 and #102 and merged into `dev` as `4032e96`. PR #128 closed #103 and #106 and merged into `dev` as `080eecf`. PR #129 closed #107 and merged into `dev` as `a4032a0`. PR #132 closed #105 and merged into `dev` as `390271a` |
| Models and providers | Codex model choices come from its catalog; saved conversations keep their model; CLI choices do not enter Native provider setup | Broader provider modes and other runtime catalogs in their owning issues |
| Credentials | Held credentials and common key formats are replaced with placeholders before a model, storage, a log, or the screen sees them. The unpublished `88b60dd9` package showed placeholders in a Native tool result read from a probe resource, with no raw copy stored ([#97 receipt](receipts/97-credential-redaction.md)). PR #118 merged into `dev` as `8e7a8fc` | The limits in the receipt |
| Coding worker environment | The coding worker starts without credential-shaped names. In the unpublished `d5c960ce` package, a command in a Codex run read 100 names from the worker's environment and none was credential-shaped, where the worker in the `ec82a872` package held ten, including the sign-in secret and the database URLs. Codex's own MCP server with a secret header still answered ([#98 and #117 receipt](receipts/98-coding-worker-environment.md)). PR #125 merged into `dev` as `9cf1ed7` | The limits in the receipt |
| Coding worker startup | A worker that reports ready after the 15-second startup deadline or an abort never receives its run, and the deadline error says the worker did not start within 15 seconds. The worker in the unpublished `d5c960ce` package became ready in 546 to 621 ms on one Windows laptop ([#98 and #117 receipt](receipts/98-coding-worker-environment.md)). PR #125 merged into `dev` as `9cf1ed7`. Part A of #121, PR #129, merged into `dev` as `a4032a0`: one slow cleanup no longer refuses later runs, and the unpublished `09e5c3b4` package stopped a real Codex run 0.7 seconds after Stop with no process left and accepted the next turn. Part B of #121, PR #134, merged into `dev` as `e21174b`, and #121 was closed on 2026-09-29: a failed stop's refusal is a typed record that a later check lifts when nothing is left, and the Code panel lists each leftover process by name and PID with End them and Continue anyway. The unpublished `681e2ac9` package ran a seeded refusal through a restart, the real scan, End them, and the next turn, including a 500 px window. The unpublished `042dce25` package observed a real Windows child whose parent had exited, listed it after Stop, ended it through End them, preserved an unrelated process using the same executable, and accepted the next offline Code turn ([#133 receipt](receipts/133-windows-orphan-tracking.md)) | Periodic observation can miss ancestry that exists entirely between scans. Active observations can be lost if the host exits before final cleanup verification. The #133 receipt records timing, caps, and provider limits. The separate Codex model-discovery row records the bounded #130 result |
| Webhook automations | Webhook automations run in the unpublished `ec82a872` package: an accepted call ran once, a repeated event id was a duplicate, a wrong token got 404, the saved port and URL survived a relaunch, and delete disabled the URL ([#113 receipt](receipts/113-webhook-automations.md)). PR #122 merged into `dev` as `15fed03` | The limits in the receipt |
| Provider setup offers | The local app shows no Builder.io offer on the missing-access card, provider setup, model picker, or any Settings tab in the unpublished `ec82a872` package, and the provider-key path stays ([#104 receipt](receipts/104-local-provider-offers.md)). PR #122 merged into `dev` as `15fed03` | Self-hosted mode keeps Core's offers |
| Automations | Owner-scoped automations created in a Personal Native chat, every-minute runs with no overlap, in-process Run now, pause and resume, chat and dialog edits, the MCP refusal and next-run retry, a local-only probe, closed-app and quit recovery, and delete passed on the unpublished `c096528a` package. Settings prompts reached a Personal Native chat on the `f0c3cac0` retest. Scheduled runs continued on Zo with no client connected ([#51 receipt](receipts/51-automation-lifecycle.md)). The #114 and #115 fixes passed on the unpublished `9e921ca0` package: a quit during a scheduled run marked it interrupted within 18 ms and released the lease, the next launch ran at its first tick, a webhook call cut off by a quit ran once after relaunch, a hard kill kept the lease until it expired, LAST CHECKED advanced, Details offered no Open thread, and an event automation ran once ([#114 and #115 receipt](receipts/114-automation-quit-and-status.md)). PR #137 merged into `dev` as `4c19c2e`, and #114 and #115 were closed on 2026-09-29. PR #137's commits from `0c150ae` on have not run in a package. Run-written instruction files waited for review on the unpublished `e50ae89c` package: a run's `AGENTS.md`, instruction file, and memory were marked, its shared write and delete were refused, Settings listed, accepted, and deleted them, and a chat's prompt held the run's `AGENTS.md` only after **Accept** ([#109 receipt](receipts/109-automation-file-review.md)). PR #151 merged as `b63ed90f` and closed #109. The fixes after that check ran on Zo only | The historical #114 and #115 receipt remains intact. The private `4f7a0394` package supersedes its normal-quit delay: idle, active scheduled, and active webhook closes exited without waiting for the 15-second fallback, with persisted interruption, scheduled run-lease deletion, and webhook requeue ([#138 receipt](receipts/138-desktop-quit-exit.md)). Follow-ups #140 and #141 remain separate. The historical limits in the #109 receipt. The #144 preservation and deletion fix passed 39 SQLite/component cases and an 18-check built-app Settings and owner-chat journey at `66031bfd` ([receipt](receipts/144-automation-instruction-preservation.md)). The later `c0b0bbc0` Windows [follow-up](receipts/windows-runtime-followups-2026-10-02.md) passed accepted-store projection, Discard, stale Accept refusal, and refreshed Accept through Settings with a synthetic automation context. It did not run Windows owner chat, the unattended wrapper, or the scheduler. The limits tracked in issues #108 and #112. The #110, #111, and #141 fixes are in source with no packaged result yet. The #139 scheduled run-lease release at quit was observed in the `4f7a0394` package. Its full two-automation Windows journey remains untested here. The #139 fix removes the receipt's limit that one scheduled run holds back the app's other scheduled automations |
| Projects | Managed creation, external reconnect, and shared Native/CLI plans passed their named journeys. Current `2d620af` hosted proof and qualified `f024979` packaged Windows proof cover populated-folder adoption, preserved originals, and mixed-schema blockers under #17. Installed guidance composition and reviewed reconfiguration passed hosted acceptance under #16 | Remaining parent packet 08 scope and final artifact acceptance under #23 |
| Files and continuity | Read/Edit/Save/Rename, conflicts, completed history, clean shutdown, and project-file search with line navigation included in `250aaa0`. Repaired `9682472b` package restored seven unsent drafts and selected Native history after delayed write, pending close, and changed-port reopen. Issue #9 closed after [PR #88](https://github.com/vivary-dev/Vivary-New/pull/88) merged on 2026-09-24 as `0c8c7eb`. The dated restart acceptance above records matching delivery refs and the author's approval | Chat-content search stays in its owning issue. Scoped memory (#21) passed its hosted journey and one real Codex check and waits for packaged Windows acceptance |
| Bundled Python bytecode | On private `c0b0bbc0`, direct CLI capabilities warm median was 246.854 ms versus 936.837 ms without cache. Bridge catalog warm median was 204.739 ms versus 771.420 ms. Repeated warm calls left cache inventory, timestamps, and sizes unchanged, and no bytecode appeared in the install folder ([#155 follow-up](receipts/windows-runtime-followups-2026-10-02.md)). The same-profile `d6241f03` upgrade replaced cache `afa9f119` with `a75c292c`, removed the old cache, preserved an unrelated sentinel, retained the project and completed a creator preview | These are direct interpreter timings, not GUI latency. Long paths were measured with Windows long-path support enabled. Only this upgrade and sentinel were checked |
| Codex model discovery | The private `c0b0bbc0` packaged Settings UI showed Ready and two models with a synthetic CLI, cleaned up discovery processes that answered then lingered, showed a stalled-request timeout, and recovered Ready on Refresh in the same server session ([#130 follow-up](receipts/windows-runtime-followups-2026-10-02.md)) | No real Codex service or provider call. No deliberate taskkill failure was induced. Lower-level tests own that failure branch, and #133 retains its separate orphan-process scope |
| Desktop quit process exit | The private `4f7a0394` package passed idle, scheduled and webhook normal closes with main exits of 573, 319 and 301 ms. It persisted interruption and shutdown aborts, deleted the scheduled lease and requeued the same webhook task with its attempt refunded. Active-preview normal close and abrupt Electron loss removed all recorded processes and closed the preview port. Server-only termination removed all 16 recorded server-tree processes in 612.23 ms while Electron stayed alive. Original fixture hashes and grants were preserved ([#138 receipt](receipts/138-desktop-quit-exit.md)) | Measured runs, not timing guarantees. Provider responses were synthetic and loopback. Native tests own deliberately failed cleanup and observed-EOF controls. Earlier failed candidates and observer-only failures remain in the receipt. This private acceptance does not establish a release or the separate #141 Details-refresh journey |
| Creator shutdown | The private `c0b0bbc0` Windows package completed UI creation, then normal quit stopped a second actual bundled creator held in flight by a reviewed external helper. Its stopped receipt preceded the 30-second command timeout and 60-second helper deadline. The desktop, server, creator, and helper were gone, and reopening retained only the successful project ([#156 receipt](receipts/156-creator-shutdown-windows.md)) | The pause was synthetic. No grandchild was created in this packaged run. The separate Windows CI shutdown fixture covers a Python grandchild. This check does not establish absence of partial filesystem changes after interruption |
| Original Vivary | Bundled ten-verb CLI and packaged Python. Managed creation uses the packaged creator. The Details health check matched headless Doctor in the Windows `43ae417` EXE. Issue #20 adds public Review and Impact and owner and agent Decide and Control, with hosted and packaged Windows fake-provider proof | Complete GUI/agent flows for every original operation on the final product journey |
| Web and preview | [Issue #31](receipts/11e-live-project-preview.md) adds reviewed commands, isolated module-capable preview, desktop/narrow checks, and a real Codex/Astra repair loop on Zo. The `df4aedc` Windows package reviewed, started, displayed, and stopped an npm preview. The [issue 30 packet](packets/23d-self-hosted-browser-access.md) records core physical Android access on `0c552b88`, local isolated preview on `4d565337`, and `ce5abf7a` Windows sizing. Phone preview and draft-refresh observations are owner reports. Native Windows checks on `77282275` passed the shared slim grip, contained Details scrolling and keyboard width restoration with preview state retained. | The earlier backend crash remains unattributed. Corrected phone denial wording after the final preview refresh was not reported. Separate Linux-server installation, macOS preview and Windows cleanup after an already-exited launcher retain their own acceptance gaps. Agent image viewing is unavailable in the tested Zo sandbox |
| Distribution | Public `9884670` portable prerelease remains the published build. The unpublished `df4aedc` package passed fresh application-profile first launch, bundled-runtime use, second instance, and idle/active cleanup | Upgrade/removal behavior, the remaining desktop/web journey, and stable-release approval |

Earlier Windows checks used an existing configured profile. Credentials are
never bundled. Claude Code,
Codex,
and Native provider accounts remain separate from access to Vivary. The accepted
current distribution may be a versioned archive or an installer. Signing and an
installer are future distribution choices. They are not requirements for the current
Windows milestone.
macOS is later roadmap work outside the active Windows milestone.

## Historical packaging evidence boundaries

The following build and CI notes describe the September 16 candidate. The current `9884670` evidence and the earlier `250aaa0` checks are recorded above.

The candidate's Workbench output was built in a clean isolated checkout and 620
compiled files matched the fresh build. The Windows SQLite binding and runtime marker
were the two expected target replacements. Package metadata still records the
prebuilt Workbench output as `sourceCommitVerified=false`, so byte equivalence and
the clean checkout provide confidence without claiming compiler-input provenance.
Sensitive-path review was filename based. These limits do not invalidate the tested
journeys, but they remain part of the artifact record.


GitHub Actions run 35059510035 did not start because account billing or spending
restricted Actions. Separately recorded Zo Linux gates do not establish the unrun
GitHub Windows governed-platform or orientation jobs. [Issue #22](https://github.com/vivary-dev/Vivary-New/issues/22)
owns maintained regression checks. The direct Windows UI journeys above are runtime
evidence, not a substitute claim for those CI jobs. No billing or account change was made.

Do not infer public readiness from this page, a Git merge, or an issue closure.
Final acceptance remains with the [desktop release journey](desktop-release.md#acceptance-journey)
and its live milestone issues.
