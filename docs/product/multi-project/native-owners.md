# Agent-Native ownership map

Status: source-backed composition inventory for the current program.

This map uses `@agent-native/core` 0.176.5 documentation and the preserved
Littleagent native-runtime proof. It separates an existing native owner from the
Vivary workbench behavior that still needs composition or proof.

Negative findings in `evidence.md` apply only to the inspected Vivary Python
packages. They do not establish that Agent-Native Core or its neighboring apps
lack a session store, task lifecycle, transcript, scheduler entry point, plan
workflow, connection catalog, or handoff mechanism.

Evidence labels have narrow meanings:

- `verified by host tests` means the preserved Littleagent host exercised the primitive
  through deterministic tests against Core's SQL store.
- `mapped from installed exports` means the preserved proof inspected the public export.
- `documented only` means version-matched package documentation describes the behavior.
  It does not prove Workbench configuration, BrowserPod compatibility, or a live run.

| Concern | Native owner and primitive | Composed Workbench responsibility or gap | Evidence |
| --- | --- | --- | --- |
| Agent chat and model loop | Agent chat runtime and shared run manager own model turns, streaming, tools, and transcript projection | Compose Code and Native conversations in the canonical workspace. Keep AI work in the selected Native runtime | Shell composition and the Native saved-head repair are integrated. Real Native-provider turns remain under issue #50. Core contract: `agent-surfaces.mdx`, `using-your-agent.mdx` |
| Coding harness sessions | `AgentHarness`, `startAgentHarnessRun`, SQL harness sessions, translated events, approval, stop, and opaque resume state | Bind actor, project, root, policy revision, and adapter. Prove a real start, file change, cancellation, and resume in the packet's authorized execution environment | `verified by host tests` for deterministic lifecycle. Real runtime pending. `harness-agents.mdx` |
| Code and Desktop runs | Code run store, executor, transcript, run controls, `CodeAgentsHost`, and Desktop remote dispatch | The local GUI uses public `executeCodeAgentRun`, Native transcripts, `AssistantChat`, and the Code adapter. Vivary binds the selected folder and runtime, preserves the native session ID, and relays native action decisions and public activity. Codex turns have no fixed two-minute deadline; startup and shutdown remain bounded | Claude file-tool runs and follow-ups passed in private browser and packaged Windows checks. PR #59 adds verified Codex subscription turns, file tools, MCP, session continuity, native decisions, child activity, long commands, and Stop in the Windows prototype. See the [acceptance register](desktop-acceptance-status.md) for candidate-specific evidence. macOS execution remains unaccepted. `code-agents-ui.mdx` |
| Delegated tasks | Agent Teams `spawnTask`, task state, follow-ups, persisted events, abort propagation, and depth limits | Map Vivary ticket IDs to native task IDs. Add plan revision, claim, lease, budget, and acceptance rules without copying task state | `documented only`: `agent-teams.mdx` |
| Visual plans and review | Plan skills, hosted connector, local-file mode, comments, feedback, snapshots, history, and events | Choose hosted or local authority. Bind the exact plan revision to tickets and execution authority. Add dependency and board rules | `documented only`: `plan-plugin.mdx`, `template-plan*.mdx` |
| Agent resources | Scoped instructions, skills, context, custom agents, memory, jobs, and MCP configuration | Use resources for agent configuration. Do not represent arbitrary project files as SQL resources. The memory, chat-history, and SQL stores are keyed by owner with no project column, so issue #21 withholds `resources`, `save-memory`, `delete-memory`, `chat-history`, `db-schema`, `db-query`, `db-exec`, and `db-patch` from project chats through `resolveActionSurface`. Native drops the framework prompt lines that name those tools, but its resources context note remains in the prompt, so the Full chat project block says the tools are unavailable. Personal and legacy chats keep them. Project facts live in project files | `documented only`: `agent-resources.mdx` |
| Project files | No Agent-Native SQL resource owns arbitrary project files. The selected project-root service and runner must perform scoped file operations | Scoped Workbench actions own tree reads, file reads, revision-checked save/rename, and recoverable drafts | Issue #12 and the integrated shell passed hosted reading, explicit editing, rename, and conflict checks. The private Windows candidates passed focused file and draft journeys. Search and complete release acceptance remain open |
| Deterministic operations | `defineAction`, caller authorization, row access, exact-call approval, and action audit | Use actions for project operations. The managed new-folder flow uses the original creator's exact plan/apply boundary | PR #47 verified CLI/bridge/Native plan parity and reviewed creation/retry. PR #81 adds reviewed existing-folder privacy and recovery. Issue #19 adds `vivary-project-read`, the first Native agent tool. It resolves its project from the chat's pinned scope and returns the same result as the Details panel. Issue #20 adds public review and impact to it and adds `vivary-project-evaluate`, the second Native agent tool. That tool binds a server-derived agent actor with contributor authority, runs decide and four control operations, refuses a server-owned field by name, and saves nothing. The Evaluate panel's owner action returns the same result for the same input in agent mode. Broader desktop acceptance remains open. Core contract: `actions*.mdx`, `actions-access-control.mdx` |
| Project preview | `defineAction`, owner authentication, project-root grants, and existing process-tree stop | `vivary-project-preview` owns reviewed local commands. The isolated frame attaches preview context to the existing Code composer. The coding runtime owns browser inspection and repair | [Issue #31 receipt](receipts/11e-live-project-preview.md) records the real Codex/Astra capture, console/request inspection, repair, restart, and UI Stop. Image viewing failed in the Zo sandbox. No separate browser catalog or conversation store |
| Usage and cost | Harness `usage` events and native run or task usage fields report available observations | Bind measured usage to the Vivary ticket and project. Label missing telemetry and enforce admission only where the selected path supports it | `mapped from installed exports` and `documented only`: `harness-agents.mdx` |
| Connections and secrets | Workspace connection catalog, scoped credentials, onboarding, and secret resolution | Reuse the selected connection. Bind the chosen execution service's account, origin, storage scope, and project without storing credentials in source | `documented only`: `workspace-connections.mdx`, `onboarding.mdx`, `security.mdx` |
| Handoffs and remote work | Portal and Desktop own pairing, queued commands, results, mirrored run events, and documented transfer paths | Verify the supported public entry point, dirty-file coverage, publication behavior, execution environment compatibility, and portable export fields | `documented only`: `portal.mdx`, `code-agents-ui.mdx` |
| App-to-app delegation | A2A owns discovery, signed calls, streaming, task status, cancellation, and sibling-app invocation | Route to existing specialist apps with project scope. Do not clone Mail, Brain, Assets, Analytics, or other app implementations | `documented only`: `a2a-protocol.mdx`, `multi-app-workspace.mdx` |
| Intake and messaging | Messaging and Dispatch provide provider connections, routing points, and integration processing | Add signature policy, sender grants, deduplication, project routing, and draft-only behavior before authority exists | `documented only`: `messaging.mdx`, `dispatch.mdx` |
| Automation approvals | Background runner, `automation_runs`, Native tool approval store, execution journal and thread fold, plus the existing webhook task row | Retain one history/thread/turn through waiting and owner decisions. Revalidate exact ask, definition and current restricted connector before a fresh Native chunk. Settings inspects the thread without interactive continuation | Issue #108 source implementation and deterministic regression fixtures are in the maintained Core patch. Runtime, independent review and built UI acceptance remain pending. [Patch contract](../../../packages/workbench/patches/README.md#durable-automation-approvals) |
| Scheduled work | Automations and recurring jobs provide schedule and event entry points | Add a deterministic no-model prefilter, runner availability, retry policy, and notification rules. Verify the selected scheduler driver | `documented only`: `automations.mdx`, `recurring-jobs.mdx` |

## Composition rules

1. Reference the native record ID instead of creating a second run, session,
   task, transcript, message queue, connection, or scheduler record.
2. Add a product record only for a verified missing concept, such as a ticket
   dependency, exact plan revision, project binding, lease, or acceptance receipt.
3. Treat every documented primitive as unavailable until its installed export,
   configuration, identity boundary, and required optional package are checked.
4. Zo is the current source, build, automated-test, and hosted-application environment.
   Use Windows for checks that require the packaged EXE. Earlier Habitat receipts
   remain historical evidence; BrowserPod remains inactive. Follow [repository
   practices](../../../AGENTS.md) and record the actual environment for each proof.

Codex native subagent activity is already displayed in compact child cards. This
does not establish the future Agent Teams ticket orchestration described above.
Coding runtimes own their existing authentication, tools, skills, and configured
connections; Vivary discovers and exposes them rather than creating duplicates.

Source basis: `Jeff-Kazzee/littleagent` `docs/product/NATIVE_RUNTIME_PROOF.md`,
plus the version-matched files under `node_modules/@agent-native/core/docs/content/`.


## Waiting approvals and queued work

A Run now receipt means a request was saved, not that execution was admitted.
If an earlier run is waiting for approval, the worker refuses the new request
without model or tool work. Approve or Decline still updates the original run and
its automation status. Terminal metadata belongs to the most recent admitted
Native execution, using admission time and history identity to resolve ties.
Its durable history attachment must succeed before Native starts or executes a
model or tool. A persistence failure records a failed request without admitting
an execution. A legacy attached history keeps its original start-time ordering
when the first upgraded continuation fills its missing admission timestamp.

A webhook waiting for approval retains its existing task and blocks later calls
on that external thread. After the owner decision durably settles the task and
resource, Native immediately dispatches its next FIFO task. Dispatch failure is
recoverable through the existing terminal bookkeeping owner and task retry path.
Stop during the configured tool's approval predicate retains the Native Stop
cause. Refusal before approval persistence cannot become a storage failure.
A thrown approval-wait storage failure retains its typed terminal history error.
The webhook worker returns failed and keeps its payload pending through the
existing failure transition. Terminal reconciliation validates that retained
binding before settling task and resource without redispatching the action.
A consumed original action is never replayed. New source still requires the
controller's affected tests, ordinary concurrent transport exit check and review.

A process loss between saving approval history and task custody is recovered by
matching the exact retained task and execution binding before claim or settlement.
Recovery does no model or tool work. An unfinished approval retains the original
pending Native chunk even after fresh continuation attachment. After settlement,
ordinary pruning applies again. Legacy manage-jobs deletion refuses unfinished
waiting and resuming history using the job's resolved creator and organization.
Existing creator and organization-admin permissions still apply. A retained
history-ID inspection or Decline can survive a missing definition, so preserving
the definition protects normal discovery rather than creating that API access.

An authorized org admin can delete an ordinary job after its creator leaves the
organization. Deletion uses the stored execution/history scope rather than current
execution eligibility. It still refuses waiting or resuming history and unknown
or conflicting scope before changing the definition. Restoring membership for an
owner-decline cleanup does not imply that a revoked owner can approve or decline.

Settings history includes authorized retained approvals alongside its recent
bounded rows. This keeps an older waiting or recoverable run discoverable after
later refused Run now requests. Ordinary history and scheduler limits stay bounded.
A webhook encountering another execution's wait before it starts returns retry
and restores its task attempts. It does not become that wait's task owner.

Approval ask creation and durable waiting use one resource custody transaction.
Deletion uses the same exact resource owner, ID and path and checks persisted
history before token, secret or definition removal. Deletion cannot take a waiting
or resuming definition. If deletion wins first, the running automation cannot bind
an ask to a missing or same-name replacement. The original admitted history is
retained to record its refusal. Existing admin cleanup after a creator departs
remains allowed when no unresolved custody exists. Runtime and UI gates for these
new bytes remain pending.

Local SQLite transaction ownership queues ordinary execute calls and subsequent transactions behind the current transaction. Its callback must use the supplied tx.execute. Ownership is released after commit or rollback, including thrown callbacks. Organization history discovery queries exact org_id and caller email and treats missing membership as unavailable. Personal NULL-org history does not require membership in an unrelated active organization. The new SQLite controls are maintained runtime targets and have not run in this source allocation.

Webhook deletion initializes the existing webhook-token and app-secret schema owners before taking resource custody. It does not pre-delete token or secret data. Actual deletion stays on the transaction executor, together with history custody and resource mutation. Fresh-process controls seed the webhook in one process and delete or refuse it in another. Public closeDbExec uses the queued SQLite close owner before clearing the singleton. Close is memoized to avoid a second handle close. An old closed executor rejects later operations, while a new singleton can initialize normally. These new runtime controls remain unrun in the source sandbox.
