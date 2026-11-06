# Automation quit and status in the packaged app

Issues [#114](https://github.com/vivary-dev/Vivary-New/issues/114) and
[#115](https://github.com/vivary-dev/Vivary-New/issues/115) come from the #51 run. A normal quit during an
automation run left the run `running` and the scheduler lease held, so the next launch scheduled nothing for up
to ten minutes. Settings showed no LAST CHECKED value while the scheduler checked every minute, and it offered
Open thread on past runs, which did nothing. The owner decided on 2026-09-29 to fix both on one branch, that run
threads are not openable from Settings, and that a webhook call whose run a normal quit interrupted goes back to
the queue. This receipt records the packaged Windows check of that branch.

Delivery status: merged. PR #137 merged the branch `fix/automation-quit-and-status` into `dev` as `4c19c2e`, and
#114 and #115 were closed on 2026-09-29. The branch's commits from `0c150ae` on came after this check and have not
run in a package.

## Source and artifacts

- Source: `fix/automation-quit-and-status`, branched from `dev` at `e21174b`. `9d63317` fixes #115 and `8f746bb`
  fixes #114. Three review rounds added fixes through `9e921ca`. Each fix follows a test commit that failed for
  the stated reason.
- Package: `Vivary-windows-x64-9e921ca0.zip`, 223,915,204 bytes, SHA-256
  `cbeb768eecbe7205208bfb874dec6b9f7df982bf1438fd334e786f767b448a9e`, built on Zo from `9e921ca` and checked on
  the Windows laptop. Its `build.json` names source commit `9e921ca0` with `sourceDirty: false`. Its Workbench
  output reads `prebuilt` with `sourceCommitVerified: false`, so the package does not itself prove that the
  server bundle came from that commit. The module check below finds the branch's code in it.
- Zo CI on `9e921ca`: workflow lines 112 to 115 passed 69, 447, 34, and 110 tests with no failure. Line 113 has
  one skip that predates the branch. The Python suite, the workbench typecheck, `agent-native doctor`, the HLDD
  checks, the CI workflow contract, `git diff --check`, and `test:maintained` passed.
- Provider: OpenRouter with `stealth/space-bunny-alpha`. The owner's key reached Vivary only through the launch
  environment.
- Profile: a copy of the #113 check's profile. It held no webhook automation, because #113 deleted its
  automation at the end of its run.
- Evidence: the accessibility tree and read-only reads of the app database. Screenshots were off. Times are UTC.
  Settings showed them in `America/Denver`, six hours earlier.

## What changed

- #114: Vivary's shutdown owner, `stopLocalWork`, calls Core's new `stopRecurringJobs({ timeoutMs: 10_000 })`
  first. The stop closes the scheduler, the runner, the event handler, and both webhook paths to new work. It
  aborts each in-process run that is still running with the reason `shutdown`, then waits while each run records
  itself `interrupted` and the sweep that holds the lease releases it. It writes nothing itself. A hard kill keeps
  the lease expiry and the stale-run reset as the fallback.
- #115: `list-automations` and `list-recurring-jobs` report, for an enabled scheduled entry, the later of its
  stored `lastCheck` and the scheduler's heartbeat. The Details dialog no longer renders Open thread.

The patch notes own the detail:
[Automation runs at quit](../../../../packages/workbench/patches/README.md#automation-runs-at-quit) and
[Settings automation status](../../../../packages/workbench/patches/README.md#settings-automation-status).

## Module identity

The package ships its server on disk under `resources/workbench/.output/server/`. `app.asar` holds only the
desktop entry. In the server, one file holds `Scheduler lease renewal failed`: the Core chunk
`agent-native-core+[...].mjs`. The same file holds the stop's message check, `No delivery was confirmed\.$/`.
`automation_scheduler_health` appears in code only in that file, and two other files hold it in one documentation
sentence. `index.mjs` imports the Core chunk once, and `server/node_modules` holds no `@agent-native` package. So
the plugin's import and Core's timer share one scheduler module.

## Journey and results

| Step | Result |
| --- | --- |
| 1. Automations | `vivary-114-long` was written into the copied profile before launch, in the format Core writes: every minute, `America/Denver`, a 2,000-word essay with no tools. Settings listed it as Scheduled and Enabled. The first tick, 71 seconds after launch, ran it in 50 seconds. A Personal Native chat defined `vivary-114-hook`, a webhook automation with no condition. A line-ending error in the test driver sent that prompt as seven messages. The agent defined the automation once the full text arrived. |
| 2. #115 in Settings | Details showed LAST CHECKED at 14:17 and later at 14:24, each the scheduler's latest heartbeat, so the value advanced. Past runs listed four successes and no Open thread control. Paused, the automation showed no NEXT RUN and no LAST CHECKED. Resumed, NEXT RUN was the next minute. The webhook automation showed no NEXT RUN or LAST CHECKED, its URL, and "Reachable only from this computer while Vivary is open." |
| 3. Normal quit during a scheduled run | A run started at 14:26:40.8 and was running when the window was closed at 14:26:55.4. With the app closed, the run's row read `interrupted`, finished 18 ms after the close, with the interruption message once and the code `background_automation_interrupted`. Its agent run read `aborted` with the reason `shutdown`. The lease owner and expiry were empty. The automation read `lastStatus: error` with the same message and a next run of 14:27:00, after the quit. The main process exited 15.94 seconds after the close. After relaunch, the next run started on the first tick, 71.06 seconds after launch. Details showed the interrupted run with its message and no Open thread. |
| 4. Normal quit during a webhook run | With the scheduled automation paused, a call got 202, and its run was in flight when the window was closed at 14:30:43.8. The call's task read `pending` with 0 attempts, its 245-byte payload, and the interruption message. The automation had one `interrupted` history row. The main process exited 15.46 seconds after the close. Vivary was reopened 30.8 seconds after the close. The call ran again at 14:32:25.6, 101.75 seconds after the close and 70.95 seconds after launch, and succeeded in 40 seconds. Its task read `completed`, and history held two rows for the call: the interrupted run and the success. |
| 5. Hard kill during a scheduled run | A run started at 14:35:25.7, with the lease until 14:45:25.7. Ending the Vivary process tree, eight processes, at 14:35:43.2 left the row `running`, the lease held, and the automation `running`. Vivary was reopened at 14:35:54.9. No scheduled run started until the lease expired. LAST CHECKED stayed at 14:35, because a tick that cannot take the lease records no check. At 14:46:06.0 the first tick after the expiry marked the old run `error` with the interruption message and no code, as in #51, and released the lease. The next run started at 14:47:06.0. |
| 6. Event automation | A Personal Native chat defined `vivary-114-event` on `test.event.fired` with no condition and fired the test event. One run succeeded in 1.2 seconds, with one history row and one thread whose name starts with `Trigger: vivary-114-event`. The reply was "VIVARY-114 EVENT". The thread has no chat scope, and the Personal workspace history listed no `Job:` or `Trigger:` thread. This is the first event run on record. |
| End | A quit with no run in flight took 15.48 seconds. No Vivary process was left. The raw webhook token appeared 0 times in the evidence. |

All six steps passed.

## Limits

Found in this check:

- Every normal quit took 15.5 to 15.9 seconds from the window close to the main process exit, although the
  automation rows were written within 40 ms of the close. The desktop sends the server a shutdown message and
  ends its process tree 15 seconds later. On the desktop the server calls no exit after its cleanup, so that kill
  ends it. The server's output is not captured, so no log shows the exit itself. The automation stop still
  settles inside the window.
- Details shows the list entry captured when it opened, and the list reloads when the Automations tab loads.
  Opened right after a tick, Details showed the copied profile's two-day-old heartbeat, and it still did after
  closing and reopening. Leaving the tab and returning showed the current value.
- After the hard kill, Details showed NEXT RUN at 14:38 while nothing could run until 14:46. When the stored next
  run has passed, the list reports the next occurrence from now. It does not account for the held lease or for
  the automation's `running` state.
- The interrupted run's row names its message twice in the accessibility tree, because the row sets the message
  as both its text and its tooltip. Screen text was not checked.

Known before this check:

- One scheduled run holds the scheduler lease until it ends, so no other scheduled automation starts meanwhile.
  Source shows this. The check ran one scheduled automation at a time and did not observe it.
- A rerun starts from the beginning and can repeat a local step the interrupted run took, such as a memory
  write. An event whose run a quit interrupted does not run again.
- An event condition is checked with Anthropic's API using the active provider's key, so it fails with another
  provider's key. Tracked in [#135](https://github.com/vivary-dev/Vivary-New/issues/135).

Not covered by this check:

- A quit during a Run now, an event run, or a run still preparing, and the process-task route for webhook calls,
  ran only in `tests/automation-quit.test.mjs`. The desktop runs webhook calls in process.
- The narrow layout and keyboard use of the Automations page.
