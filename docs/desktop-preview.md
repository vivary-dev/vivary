# Install the Windows prerelease

Verified 2026-09-22. This is an unsigned Windows x64 portable preview of Vivary.
It includes PR #78's desktop browser-link fix and the preceding application changes. It is available
from the [GitHub prerelease](https://github.com/vivary-dev/vivary/releases/tag/desktop-preview-2026-09-22). The repository and download are public.
The complete desktop and self-hosted web acceptance journey remains unfinished.

## Download and verify

Download `Vivary-windows-x64-9884670.zip` and its `.zip.sha256` companion from
the release Assets list. The automatic Source code archives do not contain a
ready-to-run desktop application.

The ZIP is 236,072,825 bytes. Its SHA-256 must be:

```text
e9c0abf09e9e5a66c1dbea9ec3e05d479829138d35372b10c90a34124d1b81a0
```

In PowerShell, from the download folder:

```powershell
$expected = (Get-Content .\Vivary-windows-x64-9884670.zip.sha256).Split(' ')[0].Trim()
$actual = (Get-FileHash .\Vivary-windows-x64-9884670.zip -Algorithm SHA256).Hash
if ($actual -ne $expected) { throw 'Vivary archive checksum mismatch' }
```

If you already use GitHub CLI, download the pinned assets with:

```console
gh release download desktop-preview-2026-09-22 --repo vivary-dev/vivary --pattern Vivary-windows-x64-9884670.zip --pattern Vivary-windows-x64-9884670.zip.sha256
```

## Install and launch

1. Extract the entire ZIP to a new, writable folder, such as `C:\Apps\Vivary\9884670`.
2. Keep all extracted files together. Do not move `Vivary.exe` out of `Vivary-win32-x64`.
3. Open `Vivary-win32-x64\Vivary.exe` in File Explorer.
4. Choose a project, use **Open folder**, or create a disposable project with **New project**.
5. Open **Runtime settings** to inspect the installed coding runtime and its readiness before sending a message.

There is no MSI or setup wizard in this release. Extraction is the installation
step. The application bundles Node, Python, and the original Vivary runtime.
It does not require a source checkout or a separate global Node or Python install.
Clean-profile first-run acceptance remains open, so report missing-runtime errors.

Vivary opens locally without a Vivary account. Claude Code, Codex, and model
provider access require their own supported installation and authentication.
Use your existing runtime subscription, tools, skills, and configured connections.
Bundling Vivary does not include model-provider credentials or paid service access.
Later builds offer no Builder.io account or credits. To use Native chat, add your own
provider key when the chat asks you to connect AI, or in Settings > Agent > LLM.

The executable is unsigned. Windows may display an unknown-publisher warning.
Verify the download before deciding whether to run it. Keep Defender enabled.
No exclusion or file-association change is part of installation.

## Your data

The desktop keeps application data under `%USERPROFILE%\.vivary\workbench`.
This includes the database, run history, and managed projects. Electron stores
window and browser state separately under `%APPDATA%\Vivary` on Windows.
Existing folders registered with **Open folder** remain at their original paths.
Coding runtimes keep credentials and their own session data in their supported locations.

The desktop does not honor a caller-supplied `VIVARY_DATA_DIR` as a separate test
profile. Do not use that variable to claim isolation from your existing profile.
Use disposable projects for preview testing.

## Upgrade, backup, and rollback

1. Finish or stop active work, then close Vivary normally.
2. Copy `%USERPROFILE%\.vivary\workbench` and `%APPDATA%\Vivary` to a private backup location.
3. Back up registered external project folders separately if you need a complete recovery copy.
4. Verify and extract the new ZIP into a separate versioned folder.
5. Launch the new executable. Confirm your projects and saved conversations remain available.
6. Keep the previous package until you accept the replacement.

Backups can contain credentials, private conversations, and project content.
Keep them private. Never attach them to a GitHub issue or upload them as release assets.

Rollback across database migrations has not completed acceptance. Do not assume an
older executable can safely read a profile changed by a newer version. Preserve
the current profile before attempting recovery, and use a matching pre-upgrade
backup when returning to an older package. Changes since that backup require
separate preservation. This preview does not provide an automatic migration rollback.

To remove only the portable application, close it and remove its extracted
version folder. Keep the profile and registered project folders to preserve data.
There is no uninstaller or automatic update mechanism in this artifact.

## Try the changed experience

### Existing folders and setup preview

**Open folder** uses the Windows chooser. Cancel returns control to the app.
If the chooser times out, close it and use **Open folder** again. Browser access
to the same host does not supply the desktop chooser.

In a project, open **Details**, then **Preview Vivary setup**. Expand each file
to inspect its exact proposed contents, unchanged files, and any reported conflicts.
Existing `AGENTS.md` guidance remains visible when the plan proposes appending
the managed Vivary block. Previewing does not write the proposed files.
Applying setup to an existing folder is not available in this GUI yet.

### Project-owned page preview

Start your project's page using its normal command, then open **Preview** and enter
its HTTP or HTTPS URL. Vivary displays the owning project above the address field.
Preview embeds an already running page. It does not start a development server.

Closing and reopening Preview within the same project retains the page.
Switching projects clears the URL, embedded page, and new-tab target. Returning
to the first project also starts empty. This prevents another project's page from
appearing under the wrong owner.

Some pages and sign-in flows refuse embedding. Choose **Open preview in a new tab**.
The Windows app shows the full destination in a native **Open in browser** dialog.
Choose **Open in browser** to launch your default browser, or **Cancel** to stay
in Vivary. Cancel is the default. Browser access opens the link in a browser tab.

File URLs, custom protocols, embedded credentials, and POST requests are refused.
Provider setup links retain their direct browser behavior. If the browser cannot
open, copy the address from Preview into your normal browser.

### Project search and health

Use **Search** beside Files to find a file name or text inside the selected
project. Results open files at the matching line. Search also supports regular
expressions and reports invalid patterns. Switching projects clears old results.
This is project-file search. It does not establish full chat-content or semantic search.

Open **Details**, then **Check project health** to view the bundled Doctor's
findings. Non-Git writing and research projects remain valid project types.
Warnings and failed checks stay distinct. Search and health have earlier
candidate evidence, but this release's visual review did not repeat those journeys.

The creator also prevents cooperating apply/recovery processes on the same host
from overlapping work in one physical folder. That protection does not cover
arbitrary editors, older binaries, or another machine.

### Coding runtimes and original commands

New Code conversations can select the supported runtime and model. Saved
conversations retain their runtime and native session identity. Codex integration
includes its catalog, configured tools, action approvals, permission modes,
follow-ups, progress, and Stop. Earlier Windows candidates exercised real Codex
journeys. This exact artifact's visual review did not repeat paid model calls.

The bundled command launcher is available for command-line inspection:

```powershell
& 'C:\Apps\Vivary\9884670\Vivary-win32-x64\resources\original-runtime\bin\vivary.cmd' --help
& 'C:\Apps\Vivary\9884670\Vivary-win32-x64\resources\original-runtime\bin\vivary.cmd' adopt --help
```

The included creator contains approved adoption-request replay and bounded journal
fixes. Inspect its help and review plans before mutations. These backend changes
do not add a general GUI Apply button or publish newer PyPI/npm packages.

### Automations

The published `9884670` prerelease predates the issue #51 automation changes. This section
describes later builds. The [#51 receipt](https://github.com/vivary-dev/vivary/blob/dev/docs/product/multi-project/receipts/51-automation-lifecycle.md)
records their test on an unpublished package. The [#114 and #115 receipt](https://github.com/vivary-dev/vivary/blob/dev/docs/product/multi-project/receipts/114-automation-quit-and-status.md)
records a later package's test of quitting during a run and of LAST CHECKED. The [#109 receipt](https://github.com/vivary-dev/vivary/blob/dev/docs/product/multi-project/receipts/109-automation-file-review.md)
records a package's test of **Automation files**. Issue #108 adds approval waiting
and retained run inspection in source. Its tests and built UI journey are still
pending, so the following approval controls do not describe accepted package behavior.

An automation is a saved instruction that the agent runs on a schedule, when an event
happens in Vivary, when another program calls its webhook URL, or when you choose
**Run now**. It belongs to you, not to a project. To create one, open **Personal workspace**,
start a **Native chat**, and ask the agent for it. Say what it does, when it runs, and your
time zone. **New automation** in Settings > Agent > Automations opens the same kind of chat
with your prompt. If the prompt cannot reach a chat, Vivary shows it with **Copy prompt**.

Each run writes one chat thread, named `Job: <name>` for a scheduled run and
`Automation: <name>` for **Run now**. Vivary keeps these threads outside interactive chat history. With the issue #108
source change, **Details** > **Past runs** > **Inspect run** shows their retained
messages, tool inputs and results in Settings. A run can read
your resources, change your personal resources, memory, chat history, and progress, and
notify you in the in-app inbox. It cannot write or delete shared files.
An instruction, skill, or memory change a run writes waits for you:
AGENTS.md or a file under instructions/, skills/, or memory/. A run cannot
write the shared LEARNINGS.md or delete your instruction and memory files.
Chats and later runs keep using the saved accepted text while a proposal waits.
Settings > **Automation files** lists the proposed text. **Accept** makes that
version active. **Discard** restores the saved previous version, or removes the
proposal if none was saved. An earlier pending file created before this fix
has no saved previous version, so its overwritten text cannot be recovered.

If the file changed after the list showed it, Accept and Discard do nothing,
and the file shows its new text with a notice. Read it again before choosing.
If a decision cannot be confirmed, Settings shows a separate notice. Check the
list and try again if that file is still waiting. Reviewing another file does
not clear the notice.
Edits by you or a chat keep the proposal waiting. Accept or discard a proposal
before moving its path. The prompt reports the number of waiting files without
quoting their proposed text.
The default twelve tools cannot send email or messages, reach the web or other agents,
or change settings, jobs or automations. A configured MCP tool explicitly listed by
name adds only that capability. Each call waits for your approval of its exact input.
An unavailable or hidden configured tool refuses the run before it starts.

A run at a gate shows **waiting_approval** in Past runs. Choose **Inspect run**, read
the retained thread and pending action, then choose **Approve once** or **Decline**.
Approve continues the same automation run with its original restricted tools.
Decline ends the run without that action. There is no always-allow choice.
While it waits, another run of that automation cannot start, its schedule does not
advance and no final reply is delivered. An app restart preserves the waiting run.
If the approval expires or its definition or connector changes, approve is refused.
You can still decline to end it. A refresh failure disables the decision controls.

If the app stops after approval is consumed, the action may have happened without a
confirmed result. History shows interrupted and does not automatically retry that
ask. Check the destination before starting fresh work. A webhook waiting for approval
stays with its existing queued call and is not redispatched after restart.

Settings > Agent > Automations holds the controls:

- The switch on an automation pauses or resumes it.
- **Manage** > **Details** shows its settings and past runs. For a scheduled automation,
  LAST CHECKED is the last time the scheduler checked your automations, about once a
  minute. A check that failed does not count, and a new automation shows none until
  the first check after you create it.
  For an event, webhook, or paused automation, it is the last time a check
  skipped it, and it stays empty until one does. While the Automations tab is open and
  the window is visible, **Details** refreshes these values every 30 seconds, and it
  refreshes them when you return to the window. Past runs stays within 30 seconds of
  LAST RUN. To do this the tab asks the local server for the four automation lists every
  30 seconds, and for past runs too while **Details** is open. If a refresh fails, the
  tab keeps the last values. The section whose list failed shows "Could not refresh
  automations. The values shown may be out of date.", and **Details** shows "Could not
  refresh. These values may be out of date." above its fields when the list that holds
  that automation failed. If past runs fail to refresh, Past runs shows "Could not
  refresh run history." A note goes away once its refresh succeeds. Pausing, resuming,
  editing, or deleting an automation also hides its list's note until the next refresh
  fails. That is about 30 seconds later, or about 90 seconds if Vivary accepts requests
  but never answers, because requests time out after 60 seconds. A value far older
  than 90 seconds with a note shown is the last one Settings received, because the
  latest refresh failed. Vivary may be down, unreachable, or failing. Builds without the
  [issue #141](https://github.com/vivary-dev/vivary/issues/141) fix show the values
  from when the Automations tab loaded. In those builds, open another Settings tab,
  come back, and open **Details** again to refresh them.
- **Manage** > **Run now** runs it once. The next scheduled run does not change.
- **Manage** > **Edit** changes the schedule and time zone. Pick a preset, or enter a cron
  expression under **Advanced**.
- **Manage** > **Delete** removes the automation and eligible run history. Waiting approval history
  stays available so you can decline it. Vivary keeps its
  run threads. A run already in progress finishes and writes its reply.

To change what an automation does, ask the agent in a Personal workspace Native chat.

A webhook automation runs when a program sends an HTTP POST to its webhook URL. Ask the
agent for a webhook automation, then copy the URL from **Manage** > **Details**. The agent
cannot show it, because Vivary hides the URL's token like a password. The URL starts with
`http://127.0.0.1:` and the app's port, so only programs on this computer can call it, and
only while Vivary is open. Anyone on this computer who has the URL can start the
automation. Vivary keeps the same port across launches. It picks ports from 42100 to 42999,
below the range Windows reserves for Hyper-V, WSL, and Docker. If the saved port is
unavailable when Vivary starts, or an earlier build saved a port in that reserved range,
Vivary picks a new one and says so. Then copy the new URL
from **Details** and update the program that calls it.

Vivary answers an accepted call with status 202, a repeated event with 200, and an unknown
URL with 404. A call that repeats an event id, sent as the `X-Webhook-Event-Id` header or
as an `id` field of a JSON body, runs once. A call without an id always runs. When 20 calls
for one automation are already waiting, Vivary answers new calls with 429. A call that
Vivary accepted before it quit runs once after you reopen Vivary, unless it waited more
than 24 hours. Then it is not run, and **Details** shows it as an error. When you quit
Vivary during a webhook run, the run ends as interrupted and the call goes back to the
queue. After you reopen Vivary, it runs again from the start the first time Vivary looks
for waiting calls at least 90 seconds after the quit. Vivary looks 10 seconds after it
opens and then once a minute, so the call runs about 10 seconds after you reopen Vivary
when the quit was more than about 80 seconds earlier, and 70 to 130 seconds after you
reopen it otherwise. Later calls for that automation wait behind it. If Vivary was ended
without quitting, for example from Task Manager, the call runs again from the start about
15 minutes after its first run began, once Vivary is open. Either way a step the first run already took, such as a
memory write, can happen twice, and **Details** shows two runs for the call: the
interrupted one and the rerun. The request body reaches the run as untrusted data, and
the run has the same limits as any other. Each webhook run writes a chat thread whose name
starts with `Trigger: <name>`.

An automation can have a condition that decides whether a call runs. Vivary checks the
condition with Anthropic's API, whatever provider you use for chats, and sends the request
body to Anthropic for the check. It needs an Anthropic API key. Without one, a call to that
automation does not run, and **Details** shows the reason. Remove the condition, or add an
Anthropic key.

An event automation runs when something happens inside Vivary. Vivary emits six events:
`agent.turn.completed` when a Native chat reply finishes, `notification.sent` when a
notification reaches your inbox, `run.progress.started` and `run.progress.updated` when
a run reports progress, `automation.run.finished` when a scheduled, Run now, or webhook
automation run ends, and `test.event.fired` when you ask the agent in a chat to fire a
test event. Vivary also fires `automation.run.finished` for a refused, failed, or
expired webhook call. A run that an event started does not fire
`automation.run.finished`, so automations on that event cannot keep starting each other.
An automation also never starts from its own run. The agent accepts other event names,
but nothing in Vivary emits them, so such an automation never runs. An event run uses
the provider chosen in Settings, as a scheduled run does. A condition on an event
automation is checked the same way as a webhook condition, with Anthropic's API,
whatever provider you use for chats, and Vivary sends the event's data to Anthropic for
the check. It needs an Anthropic API key. Without one, or when Anthropic rejects the
key, the event does not start a run, and **Details** shows the reason. Each event run
writes a chat thread whose name starts with `Trigger: <name>`.

Automations run only while Vivary is open. Closing the Vivary window quits the app, and
nothing runs while it is closed. After you reopen Vivary, a missed automation runs at most
once, then follows its schedule. When Vivary serves browser access, runs continue with no
browser tab open.

Quitting Vivary during a run ends the run, and **Details** shows it as interrupted.
Builds with the [issue #138](https://github.com/vivary-dev/vivary/issues/138) fix exit
after cleanup instead of waiting for the desktop fallback. The private `4f7a0394`
Windows package closed idle, active scheduled and active webhook runs in 573, 319
and 301 ms. All observed package processes were gone within 761, 450 and 455 ms.
Active-preview normal close and abrupt Electron loss also removed the recorded
preview tree and closed its port. Terminating only the server removed its complete
recorded descendant tree in 613 ms while Electron remained alive. The earlier
`d8cb7665` crash failure is superseded by these checks.
These are measured runs, not fixed timing guarantees. The 15-second fallback remains
configured. Pending or failed cleanup retains the server for the parent's tree kill.
If Electron disconnects, the server gives cleanup 15 seconds before attempting
to stop its own tree. The [acceptance receipt](product/multi-project/receipts/138-desktop-quit-exit.md)
records the package, persistence outcomes, controls and historical failures.
The next launch checks schedules about 70
seconds after it starts. If Vivary was ended without quitting, for example from Task
Manager, the run shows as running, and that automation waits up to 10 minutes after the
next launch while your other automations run on schedule. During that wait, **Details**
shows when scheduling resumes instead of a next run that would pass with no run. An
automation whose next run falls after the wait keeps that time. For up to 90 seconds after
Vivary was ended it reads "After the current run finishes", because the ended run still
looks live.
Builds without the [issue #140](https://github.com/vivary-dev/vivary/issues/140) fix show a
next run about a minute away that passes with no run.

Schedules are cron expressions read in each automation's saved time zone. Vivary checks
once a minute, so the shortest interval is one minute, and a run can start up to a minute
after its scheduled time. Vivary computes the next run when a run finishes. A run that
lasts longer than its interval delays the next one, and runs of one automation never overlap.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Checksum differs | Do not run that archive. Download both assets again and compare. |
| No window after launching from a terminal | Try File Explorer. An inherited `ELECTRON_RUN_AS_NODE=1` can make Electron run as Node. Remove that variable only from the launch shell and retry. |
| Windows asks which app should open a file | Cancel. Recheck that you launched the extracted `.exe`. Do not change file associations. |
| Folder selection times out | Close the chooser, then choose Open folder again. |
| Browser Open folder fails | Use the Windows app's folder chooser. |
| Existing project says Unavailable | Restore access to its original folder and refresh. The app retains its saved conversations. |
| Runtime is unavailable | Check that the supported coding runtime is installed and authenticated separately, then inspect Runtime settings. |
| Embedded preview is blank | Confirm the page server is running and the address uses HTTP or HTTPS. Use its new-tab link and confirm the destination in the Windows dialog. If launch fails, copy the address into your browser. |
| Setup content extends beyond the panel | Scroll horizontally, widen the panel, or maximize it. |
| An automation waits after Vivary was ended during its run | Wait. If Vivary was ended without quitting, for example from Task Manager, the automation that was running waits up to ten minutes, and your other automations run on schedule. When the wait ends, the interrupted run shows that it stopped before it recorded a result, and its schedule resumes. During the wait, **Details** shows when scheduling resumes instead of a next run that would pass with no run, and "Waiting for the next schedule check" once that time has passed. An automation whose next run falls after the wait keeps that time. Builds without the [issue #140](https://github.com/vivary-dev/vivary/issues/140) fix show a next run about a minute away that passes with no run. Builds with the [issue #114](https://github.com/vivary-dev/vivary/issues/114) fix end the run at a normal quit. Builds without the [issue #139](https://github.com/vivary-dev/vivary/issues/139) fix make every automation wait. |
| LAST CHECKED in **Details** looks old | The scheduler checks about once a minute, and **Details** refreshes every 30 seconds while the window is visible, so the value can be about 90 seconds old. After the window was hidden or minimized, **Details** refreshes when you return to it. When a refresh fails, the tab keeps the last values and shows "Could not refresh automations. The values shown may be out of date." above the list, and **Details** shows "Could not refresh. These values may be out of date." when the list that holds that automation failed. A value far older than 90 seconds with that note shown is the last one Settings received, because the latest refresh failed. Vivary may be down, unreachable, or failing. Builds without the [issue #141](https://github.com/vivary-dev/vivary/issues/141) fix show the values from when the Automations tab loaded. In those builds, open another Settings tab, come back, and open **Details** again. |
| A failed automation run is not retried | Vivary does not retry runs. Fix the cause, then wait for the next scheduled run or choose **Run now**. |
| A configured tool is unavailable, or its approval expired or changed | Check the configured tool and automation definition. Decline the old waiting action, then start fresh work when the configuration is correct. Builds before issue #108 refuse all listed MCP tools. |
| Text shows `[redacted NAME]` or `[redacted credential]` | Vivary replaced a credential before the model, the screen, or storage received it. The original is unchanged where it is kept. If an agent needs a key, keep it in the project's own configuration instead of asking the agent to print it. |
| A webhook call cannot connect | Vivary must be open, and the caller must run on this computer. Compare the port in the caller's URL with **Manage** > **Details**. After Vivary reports a port change, update the caller. |
| A webhook call gets 404 | The URL is wrong or the automation was deleted. Copy the URL again from **Manage** > **Details**. |
| A webhook call runs late after a restart | A call accepted before a quit, or one whose run the quit interrupted, runs the first time Vivary looks for waiting calls at least 90 seconds after the quit. Vivary looks 10 seconds after it starts and then once a minute, so the call runs about 10 seconds after the next start when the quit was more than about 80 seconds earlier, and 70 to 130 seconds after it otherwise. A call whose run was cut off because Vivary was ended without quitting runs again about 15 minutes after that run began. Later calls for that automation wait behind it. An approval wait remains waiting after restart, and a consumed approval is never automatically redispatched. |
| A webhook call gets 429 | The automation has 20 calls waiting. Wait for them to run, then send the call again. |
| A webhook or event automation with a condition never runs | Conditions need an Anthropic API key. Open **Manage** > **Details** for the reason, then add an Anthropic key or remove the condition. |

Remote access is a separate authenticated self-hosting configuration. This ZIP
does not publish your laptop to the internet. Consult the
[Workbench setup](https://github.com/vivary-dev/vivary/blob/dev/packages/workbench/README.md) before enabling remote access.

## Verification and known limits

The exact source commit is `98846706227432e26f519d1b546889261eb08ff1`.
This is the merged PR #78 source commit.
The tag identifies the packaged source, rather than later documentation commits.
`resources\workbench\build.json` reports `sourceDirty: false`, version `0.0.0`,
and channel `private-preview`. These internal development labels remain in the
reviewed binary. The GitHub artifact is publicly downloadable as a prerelease.

The prebuilt Workbench metadata reports `sourceCommitVerified: false`. The build
log records a Workbench build immediately before packaging. The metadata does
not assert complete compiler-input provenance. The executable is unsigned.

Six applicable GitHub CI jobs passed on the reviewed PR #78 fix head. The site
job skipped. Twenty-seven desktop and startup tests passed on Zo. These source
checks are separate from packaged Windows evidence. Historical Entire trail
approval failures remain recorded and are not relabeled as passing.

The exact Windows package displayed the complete destination with Cancel selected
by default. Cancel dismissed the dialog without opening a preview tab. Confirming
opened Chrome at the exact path, query, and fragment, and page interaction passed.
Switching projects cleared the old preview. Graceful close stopped all observed
app processes and released the listener. Restart retained the selected project
and an empty Preview. Local profile backups were hash-verified before launch.

The September 21 candidate retains its separate setup-preview, chooser-recovery,
and 390-pixel browser evidence. Those journeys and earlier real model turns were
not repeated on this package. Native minimum-width testing, full native existing-folder
registration, conflict cases, clean-profile onboarding, upgrade/removal acceptance,
Native-provider turns, full adoption, search/memory coverage,
self-hosted phone access, and integrated debugging remain outside this bounded review.
Automations were not part of this package's review either. In later builds they run only
while Vivary is open. The original #51 candidate could not use MCP tools or wait for
approval. Issue #108 changes that behavior in source and still needs acceptance.
Ending Vivary without quitting during a run delays scheduling for up to ten minutes,
and desktop webhook calls reach Vivary only from the same computer. The
[#51 receipt](https://github.com/vivary-dev/vivary/blob/dev/docs/product/multi-project/receipts/51-automation-lifecycle.md) lists each limit and its tracking issue.

See the [acceptance register](https://github.com/vivary-dev/vivary/blob/dev/docs/product/multi-project/desktop-acceptance-status.md)
and [remaining release work](https://github.com/vivary-dev/vivary/issues/23). For a bug report, include the
release tag, OS version, reproduction steps, and sanitized screenshots or errors.
Do not include credentials, profile databases, or private transcripts.
