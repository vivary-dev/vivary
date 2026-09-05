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
| Agent chat and model loop | Agent chat runtime and shared run manager own model turns, streaming, tools, and transcript projection | Supply the selected project context and open the native chat surface. Keep AI work in that runtime | `documented only`: `agent-surfaces.mdx`, `using-your-agent.mdx` |
| Coding harness sessions | `AgentHarness`, `startAgentHarnessRun`, SQL harness sessions, translated events, approval, stop, and opaque resume state | Bind actor, project, root, policy revision, and adapter. Prove a real BrowserPod start, file change, cancellation, and resume | `verified by host tests` for deterministic lifecycle. Real runtime pending. `harness-agents.mdx` |
| Code and Desktop runs | Code run store, executor, transcript, run controls, `CodeAgentsHost`, and Desktop remote dispatch | Select either Code or Harness ownership. Add a BrowserPod host bridge only after compatibility proof | `mapped from installed exports` and `documented only`: `code-agents-ui.mdx`. Shared UI package availability remains unverified |
| Delegated tasks | Agent Teams `spawnTask`, task state, follow-ups, persisted events, abort propagation, and depth limits | Map Vivary ticket IDs to native task IDs. Add plan revision, claim, lease, budget, and acceptance rules without copying task state | `documented only`: `agent-teams.mdx` |
| Visual plans and review | Plan skills, hosted connector, local-file mode, comments, feedback, snapshots, history, and events | Choose hosted or local authority. Bind the exact plan revision to tickets and execution authority. Add dependency and board rules | `documented only`: `plan-plugin.mdx`, `template-plan*.mdx` |
| Agent resources | Scoped instructions, skills, context, custom agents, memory, jobs, and MCP configuration | Use resources for agent configuration. Do not represent arbitrary project files as SQL resources | `documented only`: `agent-resources.mdx` |
| Project files | No Agent-Native SQL resource owns arbitrary project files. The selected project-root service and runner must perform scoped file operations | Add canonical-root authorization, revision checks, draft recovery, external-edit detection, and conflict-safe save | Project-file behavior is not verified by the native host proof |
| Deterministic operations | `defineAction`, caller authorization, row access, exact-call approval, and action audit | Put project operations behind actions. Add intent-before-effect receipts and revision binding where after-effect audit is insufficient | `documented only`: `actions*.mdx`, `actions-access-control.mdx` |
| Usage and cost | Harness `usage` events and native run or task usage fields report available observations | Bind measured usage to the Vivary ticket and project. Label missing telemetry and enforce admission only where the selected path supports it | `mapped from installed exports` and `documented only`: `harness-agents.mdx` |
| Connections and secrets | Workspace connection catalog, scoped credentials, onboarding, and secret resolution | Reuse the selected connection. Add BrowserPod account, origin, storage-key, and project binding without storing credentials in source | `documented only`: `workspace-connections.mdx`, `onboarding.mdx`, `security.mdx` |
| Handoffs and remote work | Portal and Desktop own pairing, queued commands, results, mirrored run events, and documented transfer paths | Verify the supported public entry point, dirty-file coverage, publication behavior, BrowserPod fit, and portable export fields | `documented only`: `portal.mdx`, `code-agents-ui.mdx` |
| App-to-app delegation | A2A owns discovery, signed calls, streaming, task status, cancellation, and sibling-app invocation | Route to existing specialist apps with project scope. Do not clone Mail, Brain, Assets, Analytics, or other app implementations | `documented only`: `a2a-protocol.mdx`, `multi-app-workspace.mdx` |
| Intake and messaging | Messaging and Dispatch provide provider connections, routing points, and integration processing | Add signature policy, sender grants, deduplication, project routing, and draft-only behavior before authority exists | `documented only`: `messaging.mdx`, `dispatch.mdx` |
| Scheduled work | Automations and recurring jobs provide schedule and event entry points | Add a deterministic no-model prefilter, runner availability, retry policy, and notification rules. Verify the selected scheduler driver | `documented only`: `automations.mdx`, `recurring-jobs.mdx` |

## Composition rules

1. Reference the native record ID instead of creating a second run, session,
   task, transcript, message queue, connection, or scheduler record.
2. Add a product record only for a verified missing concept, such as a ticket
   dependency, exact plan revision, project binding, lease, or acceptance receipt.
3. Treat every documented primitive as unavailable until its installed export,
   configuration, identity boundary, and required optional package are checked.
4. BrowserPod remains preferred; the owner also authorized Habitat fallback.
   Use the packet-specific environment receipt. A local Node, Desktop, Habitat,
   or WSL result does not prove BrowserPod support.

Source basis: `Jeff-Kazzee/littleagent` `docs/product/NATIVE_RUNTIME_PROOF.md`,
plus the version-matched files under `node_modules/@agent-native/core/docs/content/`.
