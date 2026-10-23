# Vivary Workbench

Vivary's local desktop opens without a Vivary account, signup, Zo account, or
remote database. The app uses the pinned Agent-Native shell,
conversation components, settings, actions, provider storage, and run records.

Follow the root [contributor workflow](../../CONTRIBUTING.md) for branches,
review, and integration in Vivary-New. Live
[GitHub issues](https://github.com/vivary-dev/Vivary-New/milestone/1) own task scope,
acceptance, dependencies, and status, including the planned self-hosted browser
experience. The [program frontier](../../docs/product/multi-project/index.md)
provides synchronized implementation and evidence references.
A working agent conversation does not complete the factory workflow or the
installed-platform matrix.

## Run from source

Build with the pinned dependencies, then start the application:

```console
pnpm --dir packages/workbench install --frozen-lockfile
pnpm --dir packages/workbench build
pnpm --dir packages/workbench start
```

The server listens on numeric loopback. Native creates an internal local
owner so actions and saved records retain their existing identity boundary.

Sign in through the one-time address the launcher saves in `owner-sign-in.txt`
in the data directory. The launcher prints that file's path, not the address.
Open the address in your browser. Each address works once. Vivary saves a new
one after each use and at each start. A browser that already signed in stays
signed in across restarts. Another program on the computer cannot open an
owner session without that file. The desktop app signs in on its own.

On Windows the sign-in file has the data directory's permissions. The default
directory in your user profile is readable only by your account,
administrators, and SYSTEM. If you choose a
directory elsewhere, make sure other accounts cannot read it. The same applies
to the database and session secret beside it.

The default data directory is `~/.vivary/workbench`. It contains the SQLite
database, saved runs, personal workspace, generated private session secret,
and the current one-time sign-in address.
Keep this directory out of source control and preserve its secret on restart.

```console
node packages/workbench/bin/start.mjs --port 5173 --data-dir /path/to/data
node packages/workbench/bin/start.mjs --workspace /path/to/workspace
```

Source startup requires Node 22.23.4 or a newer supported release that passes
the runtime guard, and built dependencies. The
[private desktop package](../desktop/README.md) bundles its own Node runtime.

## Settings and models

Settings provides Native appearance, provider keys, integrations, resources,
and local coding-runtime readiness. Appearance is saved through Native application state.
If an appearance save fails, Settings keeps the visible choice and provides
Retry. Theme and palette retries remain independent when both saves fail.
Saved appearance loads once when the app opens, so changing the theme cannot
restore an older saved value over an unsaved choice.
Coding runtimes shows installed CLI account status and links to official
installation and sign-in instructions.

Settings has no chat of its own. A Settings control that asks the agent, such as
**New automation** under Agent > Automations or an item in the Resources create
menu, switches to Personal workspace, opens a Native chat, and sends the prompt
there as a new conversation. A prompt sent while projects are still loading
waits for them, up to eight seconds, so it never reaches the saved project by
mistake. If the switch fails, the chat rejects the prompt, or no chat receives it
within eight seconds, an alert shows the prompt, selected for copying, with
**Copy prompt**. If the browser blocks the clipboard, the alert says so.

Code conversations use local CLI accounts. Native conversations use Native's
configured providers. Model access is separate from opening Vivary.

For a new Code conversation, choose **Claude Code** or **Codex** from **Runtime**.
The choice survives reload. Runtime setup remains available when the selected
CLI is not ready. Sending a message starts the turn. After the conversation
starts, its runtime stays fixed. Start a new conversation to use another runtime.
Codex model discovery is implemented. Linked history and broader cross-runtime
integration remain separate issue #38 work.

The Code composer keeps runtime/model identity visible and hides Native's cloud
provider picker. Codex reports its available models through its app-server API.
Choose one before starting. Vivary records that model with the conversation.
Older conversations retain their recorded model, including an unknown historical
CLI default. A saved draft with an unavailable model switches to Codex's reported
default before it can start.

The Codex integration requires ChatGPT subscription authentication and the built-in
OpenAI provider. API-key fallback and custom providers are not enabled. Vivary
uses the same resolved executable for readiness and execution, including Windows
npm installations. Credentials stay in Codex's existing store.

Codex loads its own configuration, skills, and configured connections. Vivary does
not inject Native's separate MCP catalog. The settings page lists connection names,
not credentials or a claim that each connection is reachable. Connection tools can
operate outside the shell's filesystem sandbox and retain their own access rules.

Codex uses its native app-server protocol for execution and approval requests.
Choose **Normal**, **Read only**, or **YOLO** in Runtime settings. Normal allows
project work and asks about actions requiring broader access. Read only prevents
local file edits and permission expansion. YOLO gives commands full host access
without approval prompts. Connected services retain their own access settings.
There is no Plan mode. A settings change applies to the next turn; active work
keeps the permissions recorded when it started. Global Codex configuration is
unchanged.

Approval cards show the requested command, file changes, access, or questions.
The response goes back to the live Codex request. Vivary does not execute the
approved command itself. Allow once and Decline apply to that request. Additional
permission grants last for the current turn. Persistent command rules and session
approval shortcuts are not exposed by this adapter.

Commentary appears in smaller Progress cards. Actual native subagent events have
separate Subagent activity cards with their recorded identities and statuses.
Final answers retain the main text style. Reopening history uses the same event
classification; consecutive assistant messages alone never imply subagents.

A new Codex run records its native session ID. Follow-ups resume that exact session.
Historical Vivary runs without an ID use the existing bounded-history prompt once,
then record the native session for subsequent turns. Runtime and model changes
require a new conversation. Linked conversations remain separate issue #38 work.

The published `26798df` Windows preview does not include these source changes.
The `2f4a5df` Windows EXE verified subscription file work, native-session continuity,
a configured MCP call, one actual subagent and its public result, and a command
completing after 125.19 seconds. Native Allow/Decline, Read only read/write controls,
YOLO fixture access, cross-project cancellation of a running command, mode
persistence, and shutdown also passed. Normal was restored after mode testing.

Final candidate `98515c9` corrects overlapping tool identity and pending-approval
presentation. Its production build, 75 focused tests, and type checking passed.
The 12 unchanged Native regressions passed separately. The simulated hosted protocol test and actual Windows retest held and reloaded
native approval without a false stopped warning. The Windows test then approved
a real file write and received its final answer. Saved output
remained inspectable. The final EXE preserved its answer and model after restart.
Shutdown left no candidate processes. Superseded local packages were removed.

These are bounded Codex prototype results across recorded candidates. The final
EXE retest does not repeat every earlier journey. The private preview serves the
final output with authentication preserved. PR #59 merged into `dev` on September 16,
2026 as `b81dcd7`. The exact reviewed head `f21328b` passed all 62 applicable Zo CI
steps, including Linux tests, orientation, graph review, and site checks. GitHub
Actions did not run because of billing; Windows CI jobs were not part of the Zo run.
The acceptance register owns candidate details and remaining release gates.

OpenCode Go credentials and a real read-only OpenCode CLI turn were checked
separately. OpenCode is not exposed by this Vivary selector. These CLI checks do
not establish Native provider access. Issue #38 retains runtime/model integration.
Real Native-provider turns are covered under Native provider setup below and in the
[#50 receipt](../../docs/product/multi-project/receipts/50-real-native-provider.md).

### Native provider setup

Native chat uses its own provider key, separate from any coding runtime login. There
are two supported ways to supply it.

- In the app: Settings > Agent > AI provider > Manage, or Custom keys on the Connect
  AI card. Choose the provider, paste the key, and type a model id in the Model field.
  The key is saved encrypted in the Vivary profile.
- In the host environment: start Vivary with the provider's variable set, for example
  `OPENROUTER_API_KEY`. Settings then reads "Connected via OPENROUTER_API_KEY" and
  nothing is saved in the profile. A secret manager such as varlock can supply it.

Choose the provider and model in Settings, then use Test. A new Native chat defaults to
the chosen, configured provider and model. The Model field accepts custom ids, such as
OpenRouter model ids. Without a key, Native chat shows Connect AI and does not send.

Claude Code supplies Read, Glob, Grep, Edit, and Write. Codex supplies its command,
file, and connection tools. Vivary sets this integration's approval and sandbox
bounds; Codex enforces the selected shell sandbox except in YOLO mode. Choosing a project alone is not an
operating-system sandbox.

[DeepSeek Flash titles for both chat surfaces](../../docs/product/multi-project/tickets/05-integrate-workbench-shell.md#planned-chat-titles)
are planned. The existing Full chat adapter remains; this increment does not
extend it to coding conversations.

### Credential redaction

Vivary replaces credentials with a placeholder before text reaches a model, a
saved record, a log, or the screen (issue #97). A value Vivary holds shows as
`[redacted NAME]`, such as `[redacted OPENROUTER_API_KEY]`. Held values are
credential-named settings in the server environment, keys saved in Settings,
legacy credential settings, and the credential environments and headers in
`mcp.config.json`. The held set reloads when a key is saved or removed. A common
key format that Vivary does not hold, such as an `sk-`, `ghp_`, `glpat-`,
Stripe live, JSON Web Token, or `Bearer` token, shows as `[redacted credential]`.
Names that print ordinary data, such as `nextPageToken`, `publicKey`, or
`kms_key_id`, are left alone. The original stays where it is kept, in the file,
the environment, or Settings.

Native chat tool results, tool and provider errors, run events, saved and forked
threads, automation run errors, the project context block, Codex approval cards,
original command output and receipts, and server output are redacted. Codex and
Claude Code transcripts and run records are redacted before they are written.
The host sends the coding worker salted fingerprints of the held values, not the
values, and starts the worker without credential-shaped names (issue #98).
The coding CLI still sends raw tool output to its own provider and keeps its own
session files. A key typed into a chat reaches the model in the turn it is typed.
Later turns, the saved thread, and forks get the placeholder. The
[HLDD](../../docs/ARCHITECTURE.md#data-and-trust-boundaries) lists the limits of
pattern matching, and the [patch notes](patches/README.md#credential-redaction)
list the Core call sites.

## Projects and conversations

The desktop's Open folder action uses the system directory chooser. The server
connects that folder through the existing Native-backed project registry.
Folder selection expires after two minutes. The app identifies an expired
selection and asks you to close the chooser before trying again. A selection
returned after the chooser expires does not register a project.
New project offers a workspace type and optional Capture, Sources, Navigation,
and Project brief guidance. Names and file locations are editable. It previews
the original creator's exact files before creating a separate folder under the app data directory's `projects` folder. It then
registers and selects that project. Cancel writes nothing. Existing files and
unavailable folder grants are preserved. Browser startup can also connect its
initial folder with `--workspace`.

For an existing thin workspace, open Project details and choose **Review guidance
change** after editing the optional guidance choices. Review the proposed file
contents, retained files, conflicts, and retired guidance before confirming.
Cancel changes no project files. Retired guidance stays in the folder. Unchanged
choices preserve authored guidance, and reconfiguration preserves `STATE.md`,
project identity, and conversations. A lost response can retry the same approved
request without repeating completed writes. These built-in choices are installed
with the creator and require no external catalog.

The canonical `/` workspace keeps the selected conversation in the center.
Project details, files, and page preview open only when requested. Panels can
resize, close, reopen, and expand for focused work. The old Agent, Files,
Workbench, and Full chat URLs redirect to this workspace.

Page preview shows its owning project and host. **Review command** discovers
installed launchers for the project's `dev`, `start`, and `preview` package scripts.
It shows the command, script, folder, and address before **Approve and start**.
The Native owner action rechecks that review before execution. It refuses
scripts with pre/post hooks.

Starting never downloads a package manager. The process runs with the host account's file access and a limited
environment. It is not an operating-system sandbox.

**Stop preview command** targets only the process owned by that project and caller.
The app keeps ownership until shutdown, even when the folder connection changes.
On POSIX hosts, an unexpected launcher exit also stops its process group.
On Windows, cleanup after the launcher has already exited remains unsupported.
The app reports that failure without targeting a saved PID. Use commands that
remain in the foreground. Packaged Windows acceptance remains under issue #8.

A lost start response can check the same request without launching twice.
An explicit start refusal permits a fresh review. An uncertain response keeps
the same request. Reviews expire after ten minutes. Restarting Vivary invalidates
unapplied reviews and never recovers or kills a process from a saved PID.

The host reserves each managed preview port before checking and launching.
Another project must choose a free port or wait for verified cleanup.
The instance retains live requests and unexpired retry records within a fixed
128-request limit. It removes only expired records whose processes are settled.
If the limit is full, new starts wait for capacity. Existing retries and Stop
remain available. Expired, removed requests cannot execute again.

A failed readiness probe shows an unavailable message without replacing a page
whose process is still alive. Recovery preserves the page's input and script
state. Stop, process exit, or a changed folder binding unloads the managed page.

Closing and reopening the panel preserves its page. Changing projects, host scope,
or folder binding unloads it. Returning can restore a still-owned running preview
after checking the project binding. A manually opened address stays selected while
the owned command's status changes. Failed manual navigation does not reopen the
previous page.

**Open running page** accepts an existing HTTP or HTTPS address without claiming
its process. Local process start and inspection use numeric `127.0.0.1` addresses.
You must confirm that the browser runs on the displayed host before embedding
a host-local page. Phone-to-host routing belongs to issue #30.

The live frame uses a separate, temporary credential store, sandbox restrictions,
and no referrer. Browsers without credentialless-frame support cannot embed it.
Project modules can execute in their own origin. Vivary rejects its own origin
as a preview and refuses framing through response headers, including redirects.
Preview pages do not receive personal browser cookies or privileged Node access.
The panel reports blocked embedding without opening your personal browser.

**Attach preview to chat** adds the selected project, host, and address to the
open Code conversation. It preserves your draft and sends nothing. Send your
request to ask the selected coding runtime to inspect the page, capture a
screenshot, and report console errors or failed requests through its supported
tools. Missing browser tools remain unavailable. Attachment alone grants no
installation, file-editing, or credential permission.

Each preview attachment belongs to its project, folder binding, and conversation.
Native chat excludes these attachments.

For a selected registered folder, **Details > Preview Vivary setup** shows exact
proposed guidance content, retained files, and conflicts. Select the workspace
type or use automatic detection, then expand each file to review its full content.
**Confirm and apply** authorizes only that saved review. **Cancel** discards the
review without changing project files. Changing the type requires another preview.
Refreshing rebuilds an unapproved preview from current files and options. A changed
folder binding invalidates an unapproved review. Approved requests remain preserved
and cannot execute through a different binding.

The Native owner action `vivary-project-adoption` stores the reviewed target,
project binding, policy revision, options, content hash, and original request ID
in private application settings. Apply revalidates project access and delegates
to the original creator's request-aware adoption. Folder selection and the content
hash alone do not grant write permission. The public `vivary-original-command`
action still accepts adoption previews only. Agent and tool callers cannot invoke
the setup action.

A lost response retains the original request across reload and restart.
**Retry approved request** checks the creator's completion record without repeating
completed writes. **Review recovery** shows the creator's proposed restoration
for incomplete writes and requires a separate confirmation. Possible completed
work cannot be rolled back. Do not delete recovery records to force another apply.
Successful setup retains the registered project ID and provides links to files
and chat.

If the folder lacks ignore rules for private recovery records, the first preview
shows only the proposed `.gitignore` change. **Confirm privacy preparation**
authorizes that exact change. Existing ignore text remains intact. No setup
files, recovery journal, or completion receipt are written by this step.
The saved request survives reload and restart. **Retry privacy preparation**
checks the reviewed result after a lost response without repeating the write.
If later external edits prevent reconciliation, the request stays pending. Restore
the reviewed folder and ignore state before retrying. Vivary does not discard an
approval whose write result remains uncertain. An interrupted append can leave
part of the proposed ignore text. Review the file and restore the reviewed state
before retrying. Preparation never replaces or truncates existing ignore text.

The approved ignore change remains if you cancel later setup or recover an
incomplete setup. **Review Vivary setup** creates a fresh review before any
other files can change. Setup still needs its own **Confirm and apply**.
Changed inputs require another preview. Existing runtime records, tracked runtime
paths, unsafe files, or conflicting ignore rules block privacy preparation.
Vivary does not remove existing files from Git tracking.

Retryable setup requires ignore protection for `.vivary/runtime/`, including
its temporary records. These records can contain original file contents. Git
ignore rules do not exclude them from ordinary folder backups or synchronization.
See the [creator contract](../create-vivary/README.md#retrying-an-approved-adoption-request).
The runtime's 256 KiB combined output limit rejects oversized previews in full.
Full [issue #14](https://github.com/vivary-dev/Vivary-New/issues/14) and
[issue #15](https://github.com/vivary-dev/Vivary-New/issues/15) acceptance remains
open. The new two-confirmation journey still requires packaged Windows testing.

Search opens beside Files and finds file names, literal text, or a regular
expression inside the selected project only. Results show the path, line,
column, and an excerpt; choosing one opens the file at that line. Each request
stops at explicit limits (50,000 entries, 2,000 files read, 200 matches, 20
per file, a 1.5 s budget, 200 ms per file for a regular expression) and says
which limit it hit; More results continues from where it stopped, and for a
tree that does not change between pages nothing is repeated or skipped.
Limits are soft deadlines checked between filesystem operations. Filename
mode lists names from directory entries and reads nothing. Content search
applies the file panel's skip list and secret rules, skips links it sees,
verifies a file's identity when opening it, and skips binary, oversized,
and overlong content. A superseded query is abandoned by the panel while the
server finishes its bounded page; a pattern that is too slow skips that file
and the status line says so. There is no index, shell, or bundled search
binary. Coding agents search
the same folder through their own tools: Claude Code's Grep and Glob run in
the project directory, and Codex uses its sandboxed shell there.

Project details runs the original Vivary read operations for the selected
project. **Check project health** runs Doctor. **Check notes** validates typed
notes. **Find context** ranks project context for a question. **Show features**
lists optional capabilities for a preset. **Show receipts** lists recent
sanitized command receipts for every project on this host, with totals for the
whole log. Each section runs on its own, so several can run at once.

Doctor, find, and check use the front door's `--public` path. Doctor checks the
workspace's files and settings and names no path the user authored, so typed
notes are reported only by Note check. Find and check read through the privacy-filtered
facade. Files that Git ignores, sensitive file names, and a Vivary workspace's
private paths stay out of results, and each result counts what it left out. A folder that is neither a
Git repository nor a Vivary workspace gets a clear refusal instead of results,
and so does a Git repository on a host without Git. A question that contains a
file or URL path or credential-like text is refused with its own message.
Findings and results link to files in the same project. Every report is an
observation. It never repairs, installs, or runs anything.

The Native agent reads the same reports through one Vivary tool,
`vivary-project-read`. The tool has no project field. Its project comes from
the chat, and the tool refuses a personal chat. The panel and the tool get the
same result, capped to fit the tool result limit with true totals. The result
shows the project root as `.` instead of its host path. The tool call keeps
caller `tool` everywhere outside project services. Project services read the
chat's scope from the request, never from the caller, match it to one
registered project, admit the call for that project alone, and look up the owner's registry scope on its behalf. It cannot list
projects, connect a folder, or reconnect one. The runner lets it run the five
reads and none of the owner's commands. Coding runtimes keep their own file tools and do not receive this tool.

Original commands never refuse a caller for being busy. Reads run in parallel.
A command that writes a project's files, such as an approved setup, runs alone
within that project. A limit sized to the machine's processor count, and never
below four, only makes extra commands wait. A command that still cannot start
after 30 seconds returns a message asking you to try again. A command whose
component writes a receipt writes it to a private file, and the app appends
that file to the shared log after the command ends, so parallel commands cannot
overwrite each other's receipts. The app deletes the private file once it is
appended. A receipt the app could not append stays in its private folder. A
later start's first command appends it if the folder is ten minutes old by then,
and skips a receipt the log already holds. The app writes the receipt itself for
every command whose component wrote none. A governed command or a write that
finished without its component's receipt then fails. Shutdown waits for the
receipt of every command whose child started. A read's report stands without
its receipt.

Selecting a project selects its working directory, Code history, and files.
Personal workspace opens the app's default folder. Native owns the actual runs
and transcripts. Project-bound Native history includes the maintained saved-head repair and history
controls. Deterministic-provider journeys do not replace an approved real Native-provider
turn. The runtime admits one active Code request at a time. Code supports tool output,
follow-ups, visible history, approvals, and Stop. Its current engine/model identity is
read-only; switching remains planned. The active-run control stays available in
Settings and when a project folder becomes unavailable.

Project selection and conversation pointers use Native application state.
Personal workspace is stored as the scoped value
`{ scopeKey, projectId: null }`. The reader still accepts a missing value or
the older `null` value as Personal workspace.
If a selection save fails, the page keeps the requested project visible and
shows Retry. Retry rechecks project availability and owner scope before saving.
The choice remains unsaved until that write succeeds.

State writes reuse Native's public in-memory session. A Native session may omit
its token. In that case, the app uses Native's standard cookie-backed state
writer. When Native supplies a token, the client sends it only on an exact
same-origin application-state PUT or a named project/agent action POST. The
preview bridge accepts that header
only after its existing request and owner checks pass. A rejected token is not
replayed while Native refreshes the session. Rejected tokens stay only in page memory so every action and state control
blocks stale retries. Tokens are never written to disk, browser storage, or logs.
Native and Code conversation drafts use authenticated Native application state
under the selected project and conversation. This state survives project switches,
refresh, and a change in the local server port. Saving a draft does not send it.
A failed save keeps the text visible for retry. A successful send or explicit
Discard leaves a versioned empty record so an older save cannot restore the
text. The desktop window waits for dirty drafts to save before it stops the
local server. A file draft also survived a packaged desktop restart in the
separate file-editing journey. Completed Code transcripts remain in Native's
persistent run store. The hosted chat-draft journey is recorded in the
[continuity receipt](../../docs/product/multi-project/receipts/17a-chat-restart-and-drafts.md).
The unpublished `250b402f` Windows EXE restored separate Native and Code
drafts after normal close and a changed-port reopen. It kept the window open
when a draft save failed, then saved the text on Retry. PR #88 review found
that draft-only Native conversations and Code follow-ups could still be lost
from history after switching conversations. The `eb63459f` Workbench build
keeps scoped draft IDs in Native application state without copying draft text
into an index. A started Code run retains its original draft ID. The hosted
GUI reopened both draft-only Native conversations and the Code run's follow-up
after a changed-port restart. The first `eb63459f` Windows retest found a
session-readiness race before a Code draft read. A follow-up dirty hosted build
restored the draft after session recovery and checked archived and unassigned
Native selection. Clean-source packaged retest and on-screen keyboard input
remain pending, so issue #9 acceptance stays open.

Local folder grants persist in server-only Native settings. Startup reopens
and rechecks the canonical path, device, inode, and creation time. Filesystems
that omit creation time retain its zero value. Exact saved stamps still apply.
Detected missing or replaced folders remain unavailable without deleting records.
Without creation times, inode reuse during downtime can hide a replacement.
This mode supplies ordinary local access. Content snapshots, VCS custody, and
strict mutation evidence belong to the existing Core providers.

Code work continues on the host after navigation or browser closure, until the
agent completes, fails, or the user selects Stop. There is no fixed turn deadline.
The global control shows running work and native requests, including when another
project is selected. Open conversation returns to the same run and transcript.
Decline and Stop remain available if its folder becomes unavailable.

Host restart marks unfinished work and former launch-approval records interrupted.
It never replays pending actions or old unsent instructions. Saved history remains
readable. Start a new turn explicitly to continue.

Each Code invocation uses a separate ordinary Node worker around Native's
executor. Stop interrupts the native turn before bounded process-tree cleanup.
Startup and cleanup still have time limits. Unverified cleanup blocks further
runs, including after restart.

Open **Files** to browse the project tree and select a file. Markdown opens as
formatted content. Text and source files open for reading. Choose **Edit** to
change text, **Save** to write it, or **Rename** to change its name. Saving checks
the disk version and preserves the draft when a conflict or failure needs recovery.
Binary or unsupported files and files beyond the bounded size limit are refused.
Viewing a file does not send its content to a model.

**Review connection** can recover a project with one recorded local folder,
including a folder registered outside Vivary's managed Projects directory.
The review shows the saved host path for an external folder. Check that it is
the intended folder before confirming a changed identity. Confirmation rechecks
the reviewed folder, its parent, and the saved access revisions. A changed review
requires another preview. Cancel changes nothing.

Stop or deny active coding requests before reconnecting. Reconnecting preserves
the project and its conversations. It changes no project files and starts no agent. It cannot relocate a folder, grant an arbitrary path,
or reconnect a project with multiple folder bindings. Restore missing or linked
folders at their recorded paths before review. Complete Windows release
acceptance remains under issue #23.

### Prepare and save a handoff

In a saved project conversation, **Prepare handoff** asks that conversation's agent
for a structured reply. **Save handoff** validates its completed reply and writes a
marked block at the end of the designated state document, retaining other text.
A newer user request requires another Prepare, even if its reply stopped, failed,
or is still running. Failed or partial replies are never completed check evidence.
The [architecture contract](../../docs/ARCHITECTURE.md#prepare-handoff) owns read
bounds, project facts, and persisted record details.

Freshness checks run on opening the control, after conversation updates and
successful Files saves or renames, and through explicit rechecks. They make no
model call. A saved handoff becomes Out of date when the document, project facts,
or recorded conversation progression changes. Older saves without progression
facts require an update before Fresh is available. Only the selected Native branch
counts. An unavailable document offers **Check again** after the file or workspace
settings are repaired. An existing file too large for editing, a nontext or linked
file, or an unreadable file is reported as noneditable; it is never replaced by a
new file.

A version conflict keeps the current document and requires another Prepare.
After a write error, **Retry** is offered only when an authorized reread confirms
the original document version and binding. If the outcome cannot be confirmed,
or saving the record fails after the file write, inspect the document in Files or
your editor, then prepare again. The message states that the file may have changed;
Vivary does not assume success from a request marker in the text.

### Current acceptance and gaps

The [desktop acceptance register](../../docs/product/multi-project/desktop-acceptance-status.md)
distinguishes the tested private candidate from the complete release target. In
particular, the owner accepted real Native-provider turns and closed issue #50 after
PR #100 merged into `dev` as `8a5d262`. Automations passed their packaged journey under
issue #51, which the owner closed after PR #116 merged as `c39e22f`. The
[#51 receipt](../../docs/product/multi-project/receipts/51-automation-lifecycle.md) records
the run and its limits. Issue #113 makes webhook automations run in the
packaged app through an in-process runner in the maintained Core patch, and
the desktop keeps its port across launches so a webhook URL stays valid. The
[patch notes](patches/README.md#in-process-webhook-automations) record it.
Issue #104 removes Builder.io offers from the local app. Its missing-access
card and Settings point to your own provider keys, and
`server/plugins/00-builder-offers.ts` sets Core's switch from the access mode.
Codex selection and file execution passed on the
locally tested candidate. Broader issue #38 integration, clean-profile setup, search,
memory, existing-folder adoption, and final self-hosted access remain open.

## Development preview

Zo is the implementation and private preview host. It is not a product
dependency. Before testing, identify the served source and any held PR composition.
Refresh it only at an authorized idle point, preserving its command, private access,
and data. A source merge alone does not update a running build. Recheck folder
availability after refresh. An unavailable project keeps history and offers reviewed
recovery. Never replace its grant silently to make a preview appear healthy. The optional `bin/serve-preview.sh` launcher serves the same app
through the existing private Zo proxy and requires `PORT`,
`VIVARY_DATA_DIR`, the exact external HTTPS `APP_URL`, and
`VIVARY_TRUSTED_PROXY=zo-owner-only`. Keep that service private.

For a session-cookie investigation, set `VIVARY_SESSION_DIAGNOSTICS=1` in the
server environment. The default is off. Each checked request logs only Cookie
header presence, expected cookie-name presence, and the candidate token count.
The count includes candidate cookies and an eligible private-preview header.
It does not count authenticated owners or establish owner authentication.
Raw cookies and tokens are never logged. Disable the flag when the
investigation ends.

Use one supervised Node process. Terminal shutdown awaits Code cleanup and Native
close hooks before exiting. Shutdown stops active runs; startup marks
interrupted Native records before accepting another message. SQLite and files
stay in local persistent storage. Multi-instance deployment is unsupported.

Codex 0.153.4 cannot start its default restricted-network sandbox on the current
Zo host. The maintained Native adapter supplies per-run configuration while keeping
restricted networking and workspace writes. No global CLI configuration change or
sandbox bypass was applied. File-tool proof comes from the Windows candidate;
Zo verified real context-only turns and native-session continuity.
This is a development-host compatibility gap, not a requirement to run Vivary
on Zo.

## Source and checks

`source-provenance.json` records the historical Littleagent shell capture.
Git records later changes. Private history, local evidence, and public delivery
remain separate.

Use the existing relevant checks:

```console
pnpm typecheck
pnpm test:project-services
node node_modules/tsx/dist/cli.mjs --test tests/local-root-provider.test.mjs tests/local-registry-model.test.mjs
node node_modules/tsx/dist/cli.mjs --test tests/local-code-agent.test.ts tests/local-runtime-setup.test.ts tests/code-execution-host.test.ts
pnpm build
pnpm run doctor
```

The maintained regression checks (issue #22, packet 06h) run from this
directory under Node 22, the CI pin recorded in `.node-version`. The native
SQLite module is built for the Node major that ran `pnpm install`; a mismatch
fails fast with one sentence naming it.

```console
pnpm test:maintained
```

That runs the registry, project-services, shell, mutation, chat-title, and
credential redaction suites in sequence with disposable proof roots and a disposable database.
Set `VIVARY_REGISTRY_PROOF_ROOT`, `VIVARY_12H_PROOF_ROOT`,
`VIVARY_17A_PROOF_ROOT`, or `VIVARY_TEST_CORE_PACKAGE_JSON` to absolute paths
only when a task needs to own them. Core creates an empty `data/` directory
under the working directory, which is ignored here.

Exercise changed flows through normal startup. The private handoff preserves
actual browser and desktop results, including failed attempts. These checks do not
establish the complete desktop/web release journey or macOS runtime acceptance.

## Remote access

In the desktop app, Settings > Remote access opens Vivary on another device. It
accepts an already protected private HTTPS origin and a dedicated loopback ingress
port. You set up that HTTPS connection yourself, for example an appropriately
configured Tailscale connection. Tailscale is an example, not a bundled or required
component. Vivary does not create the tunnel or change the firewall. Access starts
off. Confirm the change in the native desktop dialog, open `/pair` on that origin,
and compare the code on both screens before approving the browser. Approved
browsers share this host's projects, files and Native history. Remote access is
separate from an agent controlling a browser. Code, routes and test scripts keep
the `browser-access` name.

Grants and the enabled setting survive restarts. Pending challenges expire on
restart or after five minutes; grants expire after 30 days. Disable ends browser
streams while retaining grants. Revoke ends that device's streams and future
admission. If saving a revoke fails, admission closes and the UI reports failure;
retry before restarting because only saved revocation survives a process restart.
An unavailable ingress port leaves the desktop and its repair controls usable.
Remote browsers cannot approve devices or open the desktop folder chooser. Remote
preview requires the optional isolated origin described below. Real-phone and
packaged Windows preview acceptance remain open under issue #30.

Focused lifecycle and capability checks run in `pnpm test:browser-access`, included
in `test:maintained`. After building the normal app, run
`pnpm test:browser-access-app` for the disposable loopback admission, Native state,
restart and streaming-revocation journey. These commands use existing test runners.

### Optional isolated paired-browser previews

Remote preview stays off when the optional preview origin in desktop Remote
access settings is empty. An owner can prepare a second protected HTTPS port on
the same hostname and a separate loopback ingress port, then confirm those exact
values in the native dialog. Vivary does not create certificates, routes or public
exposure. Both transport paths must already be protected before enabling access.

The paired owner uses the existing project preview review, start, status and stop
controls. Remote embedding accepts only that registered project's owned launch.
An arbitrary running URL cannot be forwarded. The host verifies the connected
socket's process identity before sending HTTP. Unsupported ownership inspection
fails closed. Windows inspection still requires packaged verification.

A supported browser must provide credentialless frames. The preview opens only
inside Vivary, with separate preview authority and no app credentials forwarded.
Preview access lasts five minutes and reopening is explicit. Workers, external
sign-in flows and websocket upgrades are unsupported. Projects with hardcoded
loopback resource URLs need their own reviewed public-base configuration.

Opening another project or launch needs a full Vivary refresh. Save file edits
first. Vivary flushes existing chat drafts and project selection and refuses the
refresh if saving fails. Browser Back/Forward restoration requires a fresh reload
before preview access resumes. Removing the frame alone does not clear storage.
