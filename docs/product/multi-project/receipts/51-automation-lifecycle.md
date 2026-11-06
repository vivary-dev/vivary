# Automation lifecycle in the packaged Windows app

Issue [#51](https://github.com/vivary-dev/Vivary-New/issues/51) requires the automation lifecycle to
pass through the normal packaged UI. This receipt records the owner-approved run on 2026-09-26, a Zo
check with no client connected, the three defects found and fixed on `feat/automation-lifecycle`, the
review rounds, and the limits that remain.

Delivery status: [PR #116](https://github.com/vivary-dev/Vivary-New/pull/116) merged into `dev`
as `c39e22f` after all eight checks passed, including Entire Gates. The Settings retest passed on
the `f0c3cac0` package. The owner accepted the run and closed issue #51 on 2026-09-27.

## Source, artifacts, provider

- Source: `feat/automation-lifecycle`, branched from `dev` at `8a5d262`. The code commits are
  `79067e0` (Run now in process), `4c07324` (local-only runs), `c096528` (review fixes and the
  argument-key bypass), `77628c4` (Settings prompt handoff), and `f0c3cac` (handoff review fixes).
  `962bd39` changes a test regex only.
- Journey package: `Vivary-windows-x64-c096528a.zip`, 223,845,560 bytes, SHA-256
  `c33dc2bd552dd4834f2e38079c82918bf3c078e05b8d41de6c35b6a8b3ee2168`, built on Zo from `c096528` and checked on Zo and the laptop. Zo
  CI on `c096528` passed lines 113 to 115 of `.github/workflows/ci.yml`, the Python suite, the
  workbench typecheck, and `test:maintained`. Line 112 failed one test whose regex did not match the
  patched `save-memory` entry. `962bd39` fixed the regex with no product change.
- Settings retest package: `Vivary-windows-x64-f0c3cac0.zip`, 223,850,141 bytes, SHA-256
  `d6be9949d45fb52a13dfc0ad8bd18b3182b67534379391cb3ab9f44e85ebf15d`, checked on Zo and the laptop,
  built from `f0c3cac` after CI
  lines 112 to 115, the Python suite, the typecheck, and `test:maintained` passed on Zo.
- Provider and model: OpenRouter, `stealth/space-bunny-alpha`, as in [#50](50-real-native-provider.md).
  The owner's key reached Vivary only through the launch environment.
- Fixtures: the automation `vivary-51-fixture` in time zone `America/Denver`, and the `orchard-notes`
  project for the #50 regression step.
- Evidence: the accessibility tree and read-only reads of the app database. Screenshots were off,
  because another app's notification overlapped the Vivary window.

## Automations in Vivary

Vivary uses Core's Native automations and adds no scheduler. An automation belongs to the owner, in
Personal scope, or to an organization. It never belongs to a project. A run cannot use the project
tools, because they refuse the automation caller.

The owner creates an automation by asking the agent in a Personal workspace Native chat, which calls
`manage-automations` with `define`. After `77628c4`, Settings > Agent > Automations > New automation
sends its prompt to the same kind of chat (defect 3).

Core stores each automation as the resource `jobs/<slug>.md`. The `automation_runs` table holds its
history and keeps the latest 50 runs per automation. Each run writes one chat thread named
`Job: <name>` that holds the instructions and the reply.

## Triggers and schedule

- Core offers schedule, event, and webhook triggers, plus Run now. The journey exercised schedule
  and Run now. Event triggers were not exercised. The packaged app cannot dispatch webhook triggers
  ([#113](https://github.com/vivary-dev/Vivary-New/issues/113)).
- A schedule is a cron expression. A scheduled automation with no schedule runs once an hour.
- The recurring-jobs timer runs inside the server process. It checks every 60 seconds, starting 10
  seconds after the server starts. So the finest schedule is one minute, and a run can start up to a
  minute after its scheduled time.
- Each automation saves its own time zone. When the request names none, Core uses the owner's saved
  scheduling time zone, then the browser's zone.
- Core computes the next run when a run finishes. In the journey, an every-minute automation whose
  runs took 54 to 99 seconds ran about every two minutes, with no overlap.
- The Edit dialog offers presets (hourly, daily at midnight, daily at noon, weekdays at 9:00, weekly
  on Sunday at 9:00, and Custom), a time zone, and an Advanced cron expression field. That field
  accepts intervals under an hour. A chat edit can also change the instructions and the MCP list.

## Host lifecycle

- Runs happen only while the Vivary server runs. Closing the window quits the app. While the app was
  closed for about six minutes, no run happened.
- A run needs no client. The Zo check below ran four scheduled runs with no request to the app.
- After a relaunch, Core does not replay missed runs. It runs a due automation at most once, then
  follows the schedule.
- One process holds the scheduler lease in `automation_scheduler_health`. The lease lasts 10 minutes
  and renews every 60 seconds. A normal quit during a run neither ends the run nor releases the lease,
  so the next launch schedules nothing until the lease expires
  ([#114](https://github.com/vivary-dev/Vivary-New/issues/114)). The #114 fix changes this, and the
  [#114 and #115 receipt](114-automation-quit-and-status.md) records its packaged check.

## Permissions

The owner decided on 2026-09-26 that unattended runs are local-only. That covers scheduled, event,
webhook, and Run now runs. Interactive chats do not change. Before the decision, a run could send
owner data to any public URL and rewrite automations with no approval. The owner chose local-only
over documenting the risk and over removing automations everywhere.

- A run gets an allowlist of 12 Native tools: `resources`, `save-memory`, `delete-memory`,
  `chat-history`, `manage-progress`, `manage-notifications`, `manage-jobs`, `manage-automations`, and
  four lookups over files bundled with Core. This build offers 11 of them, because Core registers
  `source-search` only when its source corpus is bundled.
- A run cannot send email or messages, reach the web or other agents, call MCP tools, or change
  settings, jobs, or automations. It cannot read or change agent profiles, remote agent manifests,
  or MCP configuration. Notifications from a run reach the in-app inbox only.
- A run can pass only the argument names its tool declares, and never a name with `=` or a leading
  `-`.
- An automation that lists MCP tools fails before any model call. An approval cannot be granted after
  the fact in an unattended run. Core's runner passes no approval callbacks, so an approval stop
  reaches the model as text, and history recorded a success for a step that never ran. So Core
  refuses the run until runs can wait for the owner
  ([#108](https://github.com/vivary-dev/Vivary-New/issues/108)).
- Two outward paths stay, and only the owner sets them from a chat or the app: reply delivery to the
  automation's delivery platform, and dispatch to a paired execution host. A run can no longer
  change either.

The [patch notes](../../../../packages/workbench/patches/README.md#local-only-automation-runs) own
the allowlist and every refusal.

## Journey and results

| Step | Result |
| --- | --- |
| 1. #50 regression | In `orchard-notes`, a Native chat called `vivary-project-read` and replied `2`, the file count. Stop ended a long reply after about 4 seconds with "The agent stopped before finishing". |
| 2. Empty state | Settings > Agent > Automations showed "No automations yet" under Personal and "No organization automations yet" under Organization, with no load error. |
| 3. Create | New automation in Settings dropped its prompt (defect 3). A Personal workspace Native chat then defined `vivary-51-fixture`: Personal scope, cron `* * * * *`, `America/Denver`, enabled. The database held `jobs/vivary-51-fixture.md` with the next run one minute later. The model added "No MCP tools." to the instructions on its own. |
| 4. Scheduled runs | Four runs succeeded 60 seconds apart with no overlap. Each wrote its own `Job: vivary-51-fixture` thread with the reply "VIVARY-51 OK." The resource's last status read success, and its next run advanced. |
| 5. Run now | The confirmation dialog stated what a run can and cannot do. The run was claimed within a second and succeeded in its own thread with no error. The scheduled run in the same minute ran separately. Before `79067e0`, this path always failed. |
| 6. Pause and resume | Pause disabled the automation. No run started for more than three minutes while the scheduler kept checking. Resume set the next run to the following minute, and one run followed with no burst. |
| 7. Edit | A chat edit changed the reply to "VIVARY-51 EDITED", and the next run used it. The Edit dialog changed the schedule to `*/2 * * * *` through its Advanced cron field. The list showed "Every 2 minutes", and runs came two minutes apart. |
| 8. Failure | A chat edit listed the MCP tool `mcp__vivary51__missing`. The next run failed with "This automation lists MCP tools (mcp__vivary51__missing). Automation runs cannot call MCP tools. Nothing ran. No delivery was confirmed." and the code `automation_mcp_tools_refused`. It created no thread and made no model call. |
| 9. Retry | A chat edit removed the MCP tool, and the next scheduled run succeeded. Core has no automatic retry, so the next scheduled run is the retry. Details listed the error between successes. |
| 10. Local-only probe | The instructions asked the run to fetch `https://example.com` and to define `vivary-51-probe`. The run replied that 0 of 2 steps completed, because it had no web tool and could not change automations. The thread held no tool call, and no `vivary-51-probe` resource exists. |
| 11. Quit and relaunch | A long run was in progress when Alt+F4 quit Vivary. The main process ended within 16 seconds. No run happened while the app was closed. After relaunch, the interrupted run read `running` until the old lease expired, then "The run stopped before it recorded a result, for example because the app quit or its worker restarted. No delivery was confirmed." The first new run started about five minutes after relaunch. The roughly ten missed minutes were not replayed. |
| 12. Delete | With a run in progress, Delete removed the automation. The list read "No automations yet", and the database held no `jobs/` resource and no run rows. The 22 run threads stayed in chat history. The in-flight run's thread still received its reply 15 seconds after the delete. No run or thread started afterward, and the scheduler released its lease. |

Steps 1, 2, and 4 to 12 passed on `c096528a`. Step 3 passed through the Personal Native chat and
failed through Settings. `77628c4` and `f0c3cac` fix the Settings path.

The Settings retest ran on `f0c3cac0` with the same profile. With `orchard-notes` active, Settings >
Agent > Automations > New automation opened a new Native chat in Personal workspace within five
seconds. The prompt was its first message, with the automation context once, and the agent
defined `vivary-51-retest` (hourly, `America/Denver`). The database stored the thread under
Personal workspace and held `jobs/vivary-51-retest.md`. Delete removed it. In the empty state,
Ask the agent also reached a new Personal Native chat and created nothing.

## Zo check with no client connected

At `962bd39`, a Zo check ran `bin/start.mjs` in local mode with a throwaway data folder, a fake
provider, and no real key. It created `noclient-check`, every minute in `America/Denver`, and then
sent no request to the app for 300 seconds. Four runs succeeded in that window, 60 seconds apart,
each with one provider request. Each request offered 11 tools, and no run called a tool. The
scheduler's health row recorded checks inside the window. A pause then held for 123 seconds with no
new run while the scheduler kept checking. A delete removed the automation and its run rows.

## Defects fixed on this branch

1. **Run now failed in local and hosted modes.** Core's `queueAutomationRunNow` wrote a `running` row
   and sent the run back to the app over HTTP. In production that self-dispatch needs an app URL and
   an `A2A_SECRET`. The packaged app sets no app URL in local mode and no `A2A_SECRET` in hosted mode.
   So every click failed, and the 30-second sweep retried the row forever. A Zo check at `371cfad`
   returned HTTP 500. Setting `A2A_SECRET` was rejected, because it would turn off keyless loopback
   MCP and add a second key for shared secrets. `79067e0` registers an in-process runner where the
   recurring-jobs timer starts, and Run now hands the row to it. Core's claim still lets one
   delivery of a row run. `c096528` scopes the runner to its app id and logs a failed run once.
   Step 5 passed on the package.
2. **An argument key bypassed the local-only checks.** The review of `4c07324` found it. Core's CLI
   bridge turns each argument into a `--name value` pair, and its parser reads `--name=value` with the
   last flag winning. A run could call `resources` with `path: "notes/ok.md"` and an extra argument
   named `path=jobs/x.md`. The refusal checked the first path, and the write script received the
   second. `c096528` refuses undeclared names and names with `=` or a leading `-`. For an automation
   caller, the bridge passes each value inline. A Zo check refused a run's crafted
   `path=jobs/crafted.md` argument and found only the two test automations under `jobs/` afterward.
3. **Settings dropped agent prompts.** Automations New automation, Ask the agent, Organization New
   automation, and the Resources menu's Create Automation, Schedule Task, Create Skill, and Create
   Custom Agent call Core's `sendToAgentChat`. It posts the prompt to the window and buffers it for
   eight seconds. Settings mounts no chat, so the prompt was lost with no message. `77628c4` adds a
   hook under `/settings` that switches to Personal workspace and opens a Native chat, which replays
   the prompt. If no chat claims the prompt, an alert shows it with Copy prompt. `f0c3cac` waits for
   the project list to load, reports Core's immediate rejections, shares one project switch between
   prompts sent together, and moves focus to the alert. On Zo at `f0c3cac`, with project Alpha
   active, New automation reached a Personal Native thread in 0.57 seconds with one context block.
   The Organization form carried its organization context. A prompt sent while the project list was
   held still arrived. The alert took focus and copied the prompt. The packaged retest on `f0c3cac0`
   passed, as the journey section records.

## Review rounds

The reviews used Claude models only. Opus and Fable reviewed `79067e0` and `4c07324`. Fable
reviewed `c096528` and `77628c4`. `f0c3cac` fixes the `77628c4` findings and had no separate
review. Its tests, Zo CI, a live browser check, and the packaged retest cover it.

- `79067e0`: Both found no double execution, no lost run, one runner registry in the built bundle,
  and no change on hosts without the in-process timer. They raised five lower findings: a test gap,
  a startup window, other apps' rows, notes that overstated the limits, and a duplicate error log.
  `c096528` fixes four. The startup window does not occur, because the readiness gate holds the
  actions and agent-chat paths until the plugin init that registers the runner settles.
- `4c07324`: A safety classifier stopped the Opus review partway. Before it stopped, Opus found the
  run paths, the unknown-tool rejection, the MCP refusal, inbox-only notifications, and the CI wiring
  clean. The lead session then read the code and found the argument-key bypass (defect 2). Fable
  found no bypass. It raised six residual risks. `c096528` fixes four: configuration-file reads,
  unsanitized memory names, an allowlist matched by merged tool name, and notes that overstated the
  chat-history refusals. The owner accepted the instruction-file risk
  ([#109](https://github.com/vivary-dev/Vivary-New/issues/109)). Self-retriggering event
  automations predate #51 ([#110](https://github.com/vivary-dev/Vivary-New/issues/110)).
- `c096528`: Fable re-reviewed the fix and found no bypass.
- `77628c4`: The reviews led to `f0c3cac`: waiting for the project list, reporting immediate
  rejections, one shared project switch, alert focus, and copy feedback.

## Remaining limits

- Runs cannot pause for an owner approval, so an automation that lists MCP tools fails. Tracked in
  [#108](https://github.com/vivary-dev/Vivary-New/issues/108).
- Runs can still write files that later chats read as instructions, such as `AGENTS.md`,
  `instructions/`, `skills/`, `LEARNINGS.md`, and `memory/`. The owner accepted this risk. Tracked
  in [#109](https://github.com/vivary-dev/Vivary-New/issues/109). On the unmerged branch for #109,
  such a file waits for the owner's review in Settings, and the unpublished `e50ae89c` package
  confirmed it ([#109 receipt](109-automation-file-review.md)).
- An event automation subscribed to `automation.run.finished` fires again after each of its own runs.
  Runs stay local, so the cost is model spend. Tracked in
  [#110](https://github.com/vivary-dev/Vivary-New/issues/110).
- Interactive chats keep the older CLI bridge form, so an argument value that starts with `--`, such
  as Markdown front matter, is read as a flag. Tracked in
  [#111](https://github.com/vivary-dev/Vivary-New/issues/111).
- The email tool reports a bcc that it never sends. Runs cannot use email. Tracked in
  [#112](https://github.com/vivary-dev/Vivary-New/issues/112).
- The Automations page offers webhook triggers, which the packaged app cannot dispatch. The owner
  decides how webhooks work. Tracked in [#113](https://github.com/vivary-dev/Vivary-New/issues/113).
- A normal quit during a run leaves the run `running` and the lease held. The next launch schedules
  nothing for up to ten minutes after the last renewal, about four minutes in this run. Tracked in
  [#114](https://github.com/vivary-dev/Vivary-New/issues/114). Since fixed in source: a normal quit
  records in-flight runs as interrupted with the interruption message, returns an interrupted
  webhook call to the queue, and releases the lease, and a hard kill keeps the lease expiry as the
  fallback. The unpublished `9e921ca0` package confirmed it ([#114 and #115 receipt](114-automation-quit-and-status.md)).
  A normal quit there still took about 15 seconds, because the desktop's kill ends the server.
- Details shows no LAST CHECKED value while the scheduler checks every minute, and a past run has no
  way to open its thread. A paused automation keeps a next run time that has passed. Tracked in
  [#115](https://github.com/vivary-dev/Vivary-New/issues/115). Since fixed in source: the maintained
  Core patch reports the scheduler's last check and removes Open thread, because Settings cannot open
  a run thread, and Settings already listed no next run for a paused automation. The unpublished
  `9e921ca0` package confirmed it. Its Details dialog can show an older LAST CHECKED until the
  Automations tab reloads.
- Asked what an automation run can do, a chat agent answered from general knowledge and listed
  sending and webhooks. The run prompt, the Run now dialog, and the `manage-automations`
  description state the local-only limits.
- Delete removes the run history with the automation. A run already in progress still writes its
  reply to its thread.
