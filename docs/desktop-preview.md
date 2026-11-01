# Install the Windows prerelease

This guide covers [Vivary 0.1.0-beta.1](https://github.com/vivary-dev/vivary/releases/tag/v0.1.0-beta.1), the unsigned Windows x64 desktop beta. Its
main download is a per-user installer, `Vivary-Setup-<version>.exe`, and it keeps the
portable ZIP as an option.

The installer passed an installed-Windows pass on 2026-10-31.
[Verification and known limits](#verification-and-known-limits) says what that pass
covered and what remains open. The repository and the download are public. The
complete desktop and self-hosted web acceptance journey remains unfinished.

## Download and verify

The [0.1.0-beta.1 release page](https://github.com/vivary-dev/vivary/releases/tag/v0.1.0-beta.1) lists the desktop downloads under Assets. Choose one:

- `Vivary-Setup-<version>.exe` is the installer. Use it unless you need a portable copy.
- `Vivary-<version>-windows-x64.zip` is the optional portable ZIP.

Each download has a `.sha256` companion. Download both files. The automatic Source
code archives hold the source only. They do not contain a ready-to-run desktop
application.

In PowerShell, from the download folder, compare the file with its companion.
Replace the file name with the one you downloaded:

```powershell
$file = '.\Vivary-Setup-<version>.exe'
$expected = (Get-Content "$file.sha256").Split(' ')[0].Trim()
$actual = (Get-FileHash $file -Algorithm SHA256).Hash
if ($actual -ne $expected) { throw 'Vivary download checksum mismatch' }
```

The release also lists `SHA256SUMS`, which holds the digest of every asset, and
`BUILD-INFO.json`, which names the exact source commit.

If you already use GitHub CLI, download the installer and its checksum with:

```console
gh release download v0.1.0-beta.1 --repo vivary-dev/vivary --pattern Vivary-Setup-0.1.0-beta.1.exe --pattern Vivary-Setup-0.1.0-beta.1.exe.sha256
```

## Install and launch

### With the installer

1. Run `Vivary-Setup-<version>.exe` after its checksum matches. The installer is
   not code signed, so Windows can show **Windows protected your PC** with an
   unknown publisher. Choose **More info**, then **Run anyway**.
2. Setup needs 64-bit Windows and no administrator rights. It installs Vivary for
   your Windows account only, in `%LOCALAPPDATA%\Programs\Vivary`. You cannot
   choose another folder. Only one setup or uninstaller runs at a time.
3. Accept the license and wait for the files to copy.
4. On the last page, **Launch Vivary** is selected. Select **Create a desktop
   shortcut** if you want one. Then choose **Finish**.
5. Open Vivary later from **Vivary** in the Start menu.

To install without any window, run `Vivary-Setup-<version>.exe /S`. A silent
install does not start Vivary or create a desktop shortcut.

### With the portable ZIP (optional)

1. Extract the entire ZIP to a new, writable folder, such as `C:\Apps\Vivary\0.1.0-beta.1`.
2. Keep all extracted files together. Do not move `Vivary.exe` out of `Vivary-win32-x64`.
3. Open `Vivary-win32-x64\Vivary.exe` in File Explorer.

Extraction is the installation step for the ZIP. Use a short folder path, because
Windows Explorer can reject a deeply nested destination before the application starts.

### First launch

1. Choose a project, use **Open folder**, or create a disposable project with **New project**.
2. Open **Runtime settings** to inspect the installed coding runtime and its readiness before sending a message.

Both downloads hold the same application. It bundles Node, Python, and the
original Vivary runtime. It does not require a source checkout or a separate
global Node or Python install.
A first launch in a new profile passed on 2026-10-31. Report missing-runtime errors.

Vivary opens locally without a Vivary account. Claude Code, Codex, and model
provider access require their own supported installation and authentication.
Vivary finds Codex and Claude Code when they are installed as an executable, or
globally with npm or pnpm, in a directory on `PATH`. On Windows it prefers a copy
with a launcher (`codex.exe` or `codex.cmd`) in PATH order, as a terminal does. It does
not read `.com` or `.bat` wrappers. It also skips a `codex.cmd` or `claude.cmd` that
names no recognized package entry and has no npm package beside it. So a custom
wrapper can lead it to a different copy than your terminal runs.
Vivary supports Claude Code 2.1.286 or later and Codex 0.160.0 or later. For an older
copy, Settings > Coding runtimes shows Update required with the installed version, and
Vivary sends no message on that runtime until you update it and select Refresh.
When Vivary cannot read the installed version, it does not apply this check.
Use your existing runtime subscription, tools, skills, and configured connections.
Bundling Vivary does not include model-provider credentials or paid service access.
Later builds offer no Builder.io account or credits. To use Native chat, add your own
provider key when the chat asks you to connect AI, or in Settings > Agent > LLM.

The installer and the executable are not code signed. Windows may display an
unknown-publisher warning. Verify the download before deciding whether to run it.
Keep Defender enabled. No exclusion or file-association change is part of installation.

## Your data

The desktop keeps application data under `%USERPROFILE%\.vivary\workbench`.
This includes the database, run history, and managed projects. Electron stores
window and browser state separately under `%APPDATA%\Vivary` on Windows.
Existing folders registered with **Open folder** remain at their original paths.
Coding runtimes keep credentials and their own session data in their supported locations.
The installer and the uninstaller never read, change, or remove these locations.

The desktop does not honor a caller-supplied `VIVARY_DATA_DIR` as a separate test
profile. Do not use that variable to claim isolation from your existing profile.
Use disposable projects for preview testing.

## Upgrade, backup, and rollback

1. Finish or stop active work, then close Vivary normally.
2. Copy `%USERPROFILE%\.vivary\workbench` and `%APPDATA%\Vivary` to a private backup location.
3. Back up registered external project folders separately if you need a complete recovery copy.
4. Verify the new download. With the installer, run the new `Vivary-Setup-<version>.exe`.
   It removes the files the previous setup installed in
   `%LOCALAPPDATA%\Programs\Vivary`, then copies the new ones. Your data and any
   files you added to that folder stay. If Vivary is still running, setup asks you
   to close it and offers **Retry** or **Cancel**. With the ZIP, extract it into a
   separate versioned folder.
5. Launch Vivary. Confirm your projects and saved conversations remain available.
6. With the ZIP, keep the previous package until you accept the replacement. The
   installer keeps one version. To return to an earlier one, run that version's
   installer, within the rollback limits below.

To move from a September portable prerelease to the installer, close the
portable Vivary first, because two copies must not use one profile at the same
time. Then run setup. For setup this is a first install into
`%LOCALAPPDATA%\Programs\Vivary`, and it does not touch the folder you extracted
the ZIP into. The installed Vivary opens the same profile in
`%USERPROFILE%\.vivary\workbench`, with the same database file and sign-in secret.
Confirm your projects and saved conversations as in step 5, then delete the
extracted ZIP folder yourself.

Backups can contain credentials, private conversations, and project content.
Keep them private. Never attach them to a GitHub issue or upload them as release assets.

Rollback across database migrations has not completed acceptance. Do not assume an
older executable can safely read a profile changed by a newer version. Preserve
the current profile before attempting recovery, and use a matching pre-upgrade
backup when returning to an older package. Changes since that backup require
separate preservation. This preview does not provide an automatic migration rollback.

Neither download updates itself. Run a newer installer or extract a newer ZIP to upgrade.

## Uninstall

To remove an installed Vivary, close it. Then open **Settings** > **Apps** >
**Installed apps** (on Windows 10, **Apps & features**), find **Vivary**, and
choose **Uninstall**. You can also run `Uninstall Vivary.exe` in
`%LOCALAPPDATA%\Programs\Vivary`.

Setup records every file and folder it installs in `install-files.txt` in that
folder. The uninstaller removes only those files and folders, then the Start menu
shortcut, the desktop shortcut when setup created it, the uninstaller itself, the
Installed apps entry, setup's `vivary-setup.txt` marker, and last the file list.
Nothing is deleted recursively. Files you added
to `%LOCALAPPDATA%\Programs\Vivary` stay, and so does the folder when it still
holds them. The uninstaller then leaves `vivary-setup.txt` there, so a later setup
installs beside your files without deleting any.

The uninstaller keeps `%USERPROFILE%\.vivary`, `%APPDATA%\Vivary`, and every
project folder, so your projects, conversations, and settings remain. Delete those
folders yourself only if you also want to remove your data.

When another program holds a Vivary file, the uninstaller removes the rest and
keeps its Installed apps entry. Close that program, then uninstall again.

To uninstall without any window, run
`"%LOCALAPPDATA%\Programs\Vivary\Uninstall Vivary.exe" /S`. It starts a copy of
itself and returns before the removal finishes.

To remove a portable copy, close it and remove its extracted version folder. The
ZIP has no uninstaller. Keep the profile and registered project folders to preserve data.

## Try the changed experience

### Existing folders and setup preview

**Open folder** uses the Windows chooser. Cancel returns control to the app.
If the chooser times out, close it and use **Open folder** again. Remote access
from another device does not supply the desktop chooser.

In a project, open **Details**, then **Preview Vivary setup**. Expand each file
to inspect its exact proposed contents, unchanged files, and any reported conflicts.
Existing `AGENTS.md` guidance remains visible when the plan proposes appending
the managed Vivary block. Previewing does not write the proposed files.
To apply the plan, select **Confirm and apply**. Vivary writes only the reviewed
changes. Files that changed after the preview need another preview, and conflicts
block the apply. If the folder first needs an ignore-file change, **Confirm privacy
preparation** applies only that change. Then review and confirm the setup itself.
[PR #80](https://github.com/vivary-dev/vivary/pull/80) and
[PR #81](https://github.com/vivary-dev/vivary/pull/81) added this flow, and
[PR #85](https://github.com/vivary-dev/vivary/pull/85) recorded its GUI acceptance.

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
in Vivary. Cancel is the default. Through remote access, the link opens in a browser tab.

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
& "$env:LOCALAPPDATA\Programs\Vivary\resources\original-runtime\bin\vivary.cmd" --help
& "$env:LOCALAPPDATA\Programs\Vivary\resources\original-runtime\bin\vivary.cmd" adopt --help
```

The included creator contains approved adoption-request replay and bounded journal
fixes. Inspect its help and review plans before mutations. These backend changes
do not add a general GUI Apply button or publish newer PyPI/npm packages.

### Automations

The September `9884670` prerelease predates the issue #51 automation changes. This section
describes later builds, including 0.1.0-beta.1. The [#51 receipt](https://github.com/vivary-dev/vivary/blob/dev/docs/product/multi-project/receipts/51-automation-lifecycle.md)
records their test on an unpublished package. The [#114 and #115 receipt](https://github.com/vivary-dev/vivary/blob/dev/docs/product/multi-project/receipts/114-automation-quit-and-status.md)
records a later package's test of quitting during a run and of LAST CHECKED. The [#109 receipt](https://github.com/vivary-dev/vivary/blob/dev/docs/product/multi-project/receipts/109-automation-file-review.md)
records a package's test of **Automation files**. Issue #108 approval waiting and retained run inspection have maintained regression controls. Test counts, builds and reviews are recorded per commit in the pull request and its receipts. A built UI journey on the final head, live PostgreSQL execution and packaged Windows acceptance remain pending. These results do not establish released-package or final GUI acceptance.

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
You can inspect and decide your personal run while an organization is selected.
An organization run requires its own organization and your current membership.
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
- **Past runs** may include older runs whose inspection is unavailable. Their
  recorded status stays visible. A retained result may show that it is still being
  saved. Automatic recovery depends on successfully retaining that result.
- **Manage** > **Delete** refuses while an approval is waiting or resuming, or while
  a finished approval's outcome is still being recorded. Inspect a pending run and
  approve or decline it first. When an organization run's owner can no longer act,
  Delete by someone allowed to delete the job declines that wait first, then deletes.
  For a finished run, retry Delete after settlement.
  Deletion removes the definition and eligible finished history after settlement.
  Vivary keeps retained Native run threads. If deletion wins before a running automation establishes approval custody,
  that run stops without executing the pending configured action.

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
once, then follows its schedule. When Vivary serves remote access, runs continue with no
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

## Not in this release

An agent that controls a web browser for you is not part of this release.
**Remote access** in Settings only opens Vivary itself on another device. It uses
a protected HTTPS connection that you set up, for example an appropriately
configured Tailscale connection. Vivary does not create that connection or change
your firewall.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Checksum differs | Do not run that download. Download both assets again and compare. |
| Windows protected your PC | The installer is not code signed. Confirm the checksum matches, then choose **More info** and **Run anyway**. |
| Setup or the uninstaller says Vivary is running | Close every Vivary window and wait a few seconds for it to finish, then choose **Retry**. Setup never ends Vivary for you. **Cancel** stops before any file is removed. |
| Setup or the uninstaller says some Vivary files are in use | Another program, such as a terminal open in a Vivary folder, holds a file. Setup removed the files it could and kept its file list, uninstaller, and Installed apps entry. Close that program, then run setup or the uninstaller again. It continues from where it stopped. |
| A first install stopped partway, for example on a full disk | Run setup again. Setup marks a folder it creates with `vivary-setup.txt` before copying any file, so a rerun recognizes the folder and finishes the install. The uninstaller asks for that rerun instead of removing anything. |
| The uninstaller says it could not remove itself | A program, often a virus scanner, is holding `Uninstall Vivary.exe`. The uninstaller kept its Installed apps entry and file list. Wait for the scan to finish or close that program, then run the uninstaller again. |
| The uninstaller says the Installed apps entry could not be removed | The uninstaller kept setup's file list and marker. Run Vivary setup to repair the install, then uninstall again. |
| Setup or the uninstaller says `install-files.txt` is damaged, or the uninstaller says the file list is damaged | The list was damaged, for example by a power loss. The message gives the reason, such as a cut-off line or a path outside the Vivary folder. When the folder also holds `vivary-setup.txt`, run setup again. It copies Vivary over the folder and writes a new list, then the uninstaller works again. Without that marker, setup and the uninstaller stop and change nothing. Close Vivary, delete `%LOCALAPPDATA%\Programs\Vivary` by hand, and run setup again. Your projects, conversations, and settings are stored elsewhere and are not affected. |
| Setup or the uninstaller says the folder has no `install-files.txt` | The folder holds an earlier Vivary without its file list or setup's marker, so neither can tell which files it installed. Both stop and change nothing. Close Vivary, then delete `%LOCALAPPDATA%\Programs\Vivary` by hand. Your projects, conversations, and settings are stored elsewhere and are not affected. Then run setup again. |
| Setup says Vivary needs 64-bit Windows | Vivary runs only on 64-bit Windows. Setup installed nothing. |
| Setup says the Vivary folder path is too long | Your profile folder's path is so long that some Vivary files would pass the Windows path limit under `%LOCALAPPDATA%\Programs\Vivary`. Setup checked this before changing anything, so an installed Vivary still works. Use the portable ZIP extracted to a short folder such as `C:\Vivary` instead. |
| Setup or the uninstaller says it is already running | Another setup or uninstaller is open for your account. Finish or close it, then try again. |
| Setup or the uninstaller says a Vivary folder is a link | A folder inside `%LOCALAPPDATA%\Programs\Vivary` was replaced by a link or junction. Nothing was removed. Remove that link, then try again. |
| Setup says Vivary is not in its expected folder | Setup and the uninstaller work only in `%LOCALAPPDATA%\Programs\Vivary`. Run the uninstaller from **Installed apps** rather than from a copy. |
| Setup says a file is not a Vivary file | A file you put in `%LOCALAPPDATA%\Programs\Vivary` has the same name and place as a file the new Vivary installs. Setup kept your file and did not replace it. During an upgrade, setup had already removed the previous Vivary files, so Vivary does not start until setup finishes, and the message says so. On a first install, or a reinstall into a folder the uninstaller kept, nothing was removed. Move that file out of the folder, then run setup again. |
| Setup says the folder does not contain Vivary | `%LOCALAPPDATA%\Programs\Vivary` holds other files and no sign of a previous Vivary: no file list, no `vivary-setup.txt`, no `vivary.exe`, and no uninstaller. An uninstall that keeps files you added leaves `vivary-setup.txt`, so this happens only for files placed there some other way. Move them elsewhere, then run setup again. |
| An upgrade stopped partway, for example on a full disk | Run setup again to finish it. You can also uninstall first: setup writes the new file list before it copies any file, so the uninstaller removes every Vivary file, keeps files you added, and a later setup installs normally. |
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

Remote access is a separate authenticated self-hosting configuration. Neither the
installer nor the ZIP publishes your laptop to the internet. Consult the
[Workbench setup](https://github.com/vivary-dev/vivary/blob/dev/packages/workbench/README.md) before enabling remote access.

## Verification and known limits

The installer is part of this release. Its script has source checks for the
per-user folder, the exact-folder guard, removal limited to listed files with no
recursive delete, the kept user data, and the current-user registry entry. Its
build verifies every payload file against the package's file manifest, checks that
every file went into the installer, and records the payload and installer commits
in the installer's file properties and a build receipt. On 2026-10-31 a build of `32c2a26`
passed silent installation, launch, profile preservation, and uninstallation on
Windows, as described below. Upgrade over an earlier install is not yet accepted.
The installer is not code signed.

To build the installer from source, run
`npm --prefix packages/desktop run package -- --windows-x64`. It writes the
`Vivary-win32-x64` folder and `package-file-manifest.json` into a dated `dist/`
folder. Then run `npm --prefix packages/desktop run installer` with `--payload` set
to that `Vivary-win32-x64` folder, `--manifest` set to that
`package-file-manifest.json`, and `--output` set to `Vivary-Setup-<version>.exe`.
The [desktop package README](https://github.com/vivary-dev/vivary/blob/dev/packages/desktop/README.md#windows-installer)
covers the tools it needs. The rest of this section describes the 0.1.0-beta.1 release.

The release's `BUILD-INFO.json` names the exact source commit and reports
`sourceDirty: false` and version `0.1.0-beta.1`. The `desktop release` workflow built
it on a GitHub Windows runner from that commit, and `SHA256SUMS` covers every asset.
The application bundles Electron 45.2.1, Node 24.22.1, and Python 3.12.15.

The installed-Windows pass on 2026-10-31 used the build of `dev` commit `32c2a26`,
which differs from the release commit only in documentation. In a separate profile it
covered silent per-user installation, a byte-for-byte match with the portable ZIP,
first launch without an account, Settings, project creation, project health with the
bundled Python, saving and searching a fact, second-instance handoff, close and
relaunch, and uninstallation that kept user data.

Not yet accepted on the installed app: a coding-runtime turn, provider-backed automations, remote access, an upgrade over an earlier install, and signing. A File Explorer launch and native
dialogs were not part of that pass. This release runs one coding conversation at a
time on a computer.

Electron 45.2.1 lacks one Chromium fix that Electron backported to its 44 line,
cherry-pick `3318e836e90b`. The [architecture review](https://github.com/vivary-dev/vivary/blob/dev/docs/ARCHITECTURE.md#last-change-review)
records it. Vivary moves to the first Electron 45 release that carries the fix.

Automations run only while Vivary is open. Ending Vivary without quitting during a run
delays scheduling for up to ten minutes, and desktop webhook calls reach Vivary only
from the same computer. The
[#51 receipt](https://github.com/vivary-dev/vivary/blob/dev/docs/product/multi-project/receipts/51-automation-lifecycle.md) lists each limit and its tracking issue.

See the [acceptance register](https://github.com/vivary-dev/vivary/blob/dev/docs/product/multi-project/desktop-acceptance-status.md)
and [remaining release work](https://github.com/vivary-dev/vivary/issues/23). For a bug report, include the
release tag, OS version, reproduction steps, and sanitized screenshots or errors.
Do not include credentials, profile databases, or private transcripts.

A waiting automation keeps its Details route. Resolve its pending approval before
deleting the definition. Ordinary Native history pruning retains the chunk needed
to inspect and decline an unresolved wait. If the app stops after history records a
terminal decision, existing recovery sweeps finish that task and resource status
without running its action or delivery again. These source contracts still require
final built UI acceptance.
