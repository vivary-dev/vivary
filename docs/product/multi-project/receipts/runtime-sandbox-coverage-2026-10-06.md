# Runtime sandbox coverage, October 6

This release receipt supports [issue #10](https://github.com/vivary-dev/vivary/issues/10)
and final [#23 acceptance](https://github.com/vivary-dev/vivary/issues/23).
It records source configuration and coordinator-run Linux probes separately.
It establishes neither whole-product OS containment nor release acceptance.

## Inspection identity

Source inspected: `1c3f114e14b12ad8b34b60e52548f2c341874489` on
`fix/provider-session-continuity`. The site and Workbench dependency lock
follow-ups and synthetic cleanup-test identity repair leave runtime launcher
policies unchanged.
The dated probes below retain their stated scope; no new probe was run for these
follow-ups.
Recheck against the final candidate; this is not an exact-head approval.
The inspected Workbench pins `@agent-native/core` **0.176.5** with the
[maintained patch](../../../../packages/workbench/patches/README.md), and Toolkit
**0.19.3**. Desktop pins Electron **44.3.0**. The independent Linux source
inspection reported installed Codex **0.160.0** and Claude Code **2.1.289**.
Core's Claude participant constant **2.1.208** is not the executing CLI version.
The actual Node probe below reported **v24.21.0**. No Windows runtime version or
new provider execution is verified by this receipt.

Below, `Core/` denotes `@agent-native/core@0.176.5/dist/`; checkout paths are
repository-relative. Private evidence names identify retained records without
publishing host paths, credentials or transcripts.

## Source-backed coverage and uncovered access

Issue #10's Claude reader uses a terminable Node worker with an empty environment
and bounded heap/deadline. A harmless canary using the same environment/resource
settings observed zero environment entries, a successful read outside the project,
an inert Node child exiting zero and a successful loopback connection
(`reader-worker-boundary.json`). These settings **do not form an OS sandbox**:
the worker retains host filesystem, subprocess and network rights.

The official SDK receives a read-only SessionStore without query/start/resume.
Actual retained-log inspection observed no provider execution/network; API
selection and that observation do not establish OS access denial. The canary is
not an SDK malicious attempt or proof of hook containment. The
[reader receipt](10-claude-log-reader.md) records accepted read behavior; the dated
launcher observations below remain unchanged.

| Surface | Actual configuration and source owner | Coverage limit / verification state |
| --- | --- | --- |
| Codex stored-thread reader | Native read-only metadata and summary RPCs; Workbench owns process launch, bounded wire parsing and shutdown. See the [reader receipt](10-codex-stored-thread-reader.md). | Actual retained-thread inspection on the issue #10 candidate spawned startup helpers and attempted outbound connections. The provider log checksum stayed unchanged. Read-only RPCs and process cleanup do not sandbox the app-server, hooks or MCP; no hook containment is claimed. This observation used no new model turn. Native Windows behavior remains pending. |
| Codex Code tools and their subprocesses | `Core/cli/codex-app-server-executor.js`, `permissionSettings` and `validateThread`: Normal requests `workspace-write`, project writable root, network off and `on-request` approval; Read-only requests `read-only`, network off and `never`; YOLO requests `danger-full-access`. Returned thread/project/policy metadata is checked before a turn. [Worker](../../../../packages/workbench/server/code-execution-worker.ts) selects native configuration. | These are requested CLI policies, not a project read allowlist or proof of enforced OS restrictions. Normal can request owner-approved escalation; YOLO has full host access. A new effective-policy filesystem/network/subprocess probe is **UNRUN**, including Windows. Protocol fixtures prove request handling only. |
| Codex hooks, plugins and MCP | Native app-server execution bypasses Core's merged MCP configuration (`Core/cli/code-agent-executor.js`); the CLI retains its own settings and configured MCP servers. | No evidence here proves that CLI hooks, plugin hooks or MCP server processes inherit command-tool restrictions. Treat their host filesystem, network and subprocess access as **unverified** separately in Normal and Read-only. A direct sandbox command with hooks disabled cannot prove hook containment. |
| Claude Code participant | `Core/cli/claude-code-participant.js`, `buildClaudeCodeParticipantArgs`: driver uses `acceptEdits` and `Read,Glob,Grep,Edit,Write`; watchdog uses `plan` and `Read,Glob,Grep`. No Bash tool. Both pass `--strict-mcp-config` without supplied MCP servers and `--setting-sources ""`. | The launcher enables **no explicit OS sandbox**. File-tool permissions and suppressed setting sources do not contain the CLI host process. Managed, built-in or plugin hooks are not proven disabled or contained. Claude tools/hooks/subprocess denial checks and packaged Windows checks are **UNRUN**; no Claude call was made for this receipt. |
| Native Full chat and optional production evaluator | [Plugin](../../../../packages/workbench/server/plugins/agent-chat.ts) and `Core/server/agent-chat-plugin.js`: production code execution defaults **off**. Explicit sandboxed production execution selects the `run` QuickJS evaluator (`Core/coding-tools/run-code.js`), without direct Node modules, filesystem, environment, network or imports. A request-scoped action surface downgrades trusted production execution to sandboxed. | QuickJS is distinct from the dev Node adapter below. Direct evaluator and benign host-bridge observations are recorded below. Approved bridge functions execute on the host with their own authorization. Actual Full chat composition, production action authorization and host subprocess probes remain **UNRUN**. Neither evaluator choice nor code execution being off contains the Native host or its actions. |
| Native dev/default Node execution API | `Core/coding-tools/sandbox/local-child-process-adapter.js`: a temporary Node child receives filtered environment and, when supported, permission flags allowing filesystem access to its temp directory without child-process, worker or addon grants. Unsupported flags fall back to environment filtering. | The Linux adapter probe below observed selected denials and allowed loopback. This is **Node API permission coverage**, not an OS container. Worker/addon attempts, unsupported-flag fallback and external networking were not tested. It is not proof for default Full chat or QuickJS. |
| Native actions, hooks and outbound MCP | [Project surface](../../../../packages/workbench/server/native-chat-project.ts) authorizes project actions through `prepareRequest`, `extraContext` and `resolveActionSurface`; registered actions and evaluator bridges execute host-side. [Native MCP configuration](../../../../packages/workbench/server/native-mcp.ts) disables inbound serving/connect/embed routes. Outbound MCP initialization remains in `Core/server/agent-chat-plugin.js`; `Core/mcp-client/manager.js` launches stdio servers with a small environment allowlist plus configured values. | Application scope checks are not OS containment of host hooks, actions or subprocesses. Stdio MCP is not launched through the code evaluator sandbox; remote MCP executes at its server. New host-hook and outbound MCP filesystem/network/subprocess checks are **UNRUN**. Inbound route disabling does not establish outbound isolation. |
| Electron, original engine and project preview | [Desktop host](../../../../packages/desktop/main.mjs) sets renderer sandbox, context isolation and no Node integration. [Preview ingress](../../../../packages/workbench/server/preview-ingress.mjs) separates browser origins/CSP. [Original Python operations](../../../../packages/workbench/server/original-runtime.ts) and [reviewed preview commands](../../../../packages/workbench/server/project-preview.ts) execute on the host; Python's `-I` is interpreter isolation. | Renderer/browser isolation and Python `-I` do not sandbox host file/network access. Workbench actions, Python operations, preview servers, coding CLIs, hooks and MCP remain separate host surfaces. Process groups, Windows jobs and tree termination manage lifetime, not access. New OS access probes for these host processes are **UNRUN**. OpenCode remains a separate integration and is not certified here. |

The [worker environment receipt](98-coding-worker-environment.md) retains separate
filtering proof. Its Windows `d5c960ce` run used Codex YOLO: the worker had no
credential-shaped environment names, while the server's ten such names remained
readable and Codex's own configured MCP worked. Filtering, redaction, scoped log
reads and successful Stop do not establish OS containment of same-user host data.
Historical Windows file-tool/MCP/cleanup journeys remain qualified to the
[named candidates](../desktop-acceptance-status.md#remote-codex-verification-2026-09-16).
They are not a hooks/MCP access-denial matrix for the current candidate.

## Verified Linux observation: dev Node adapter only

The coordinator ran retained `sandbox-probes/native-probe.mjs` and
`native-result.json` on 2026-10-06 at **14:48:00.375 UTC**, using the installed
Core adapter directly without a model. The probe used a disposable outside
sentinel, harmless writes, an attempted Node child that would exit immediately,
and a coordinator-owned loopback HTTP canary. The adapter supplied its own temp
working directory. It exited **0**, with empty stderr and no timeout.

| Harmless operation | Observed result |
| --- | --- |
| Permission query for outside filesystem read | `false` |
| Read outside sentinel via `node:fs` | Denied, `ERR_ACCESS_DENIED` |
| Write outside fixture via `node:fs` | Denied, `ERR_ACCESS_DENIED` |
| Write a relative file inside adapter temp directory | Allowed |
| Spawn the harmless Node child via `spawnSync` | Denied, `ERR_ACCESS_DENIED` |
| Fetch the live loopback canary | Allowed; expected canary response returned |

Allowed temp write and a successful live loopback response are positive controls.
These results cover only those operations on Linux Node v24.21.0. They do not
prove internet denial, permission inheritance in a running child, hooks/MCP
coverage, or resistance to malicious code. Node explicitly disclaims that last
guarantee in its [v24.21.0 permission documentation](https://nodejs.org/download/release/v24.21.0/docs/api/permissions.html#permissions).
The continuation writer inspected this retained source/result; it did not rerun
the probe or perform a new provider journey.

## Verified Linux observation: direct Codex profiles

Retained `sandbox-probes/codex-results.json` records the coordinator's no-model
probe at **14:52:02.683708 UTC** on 2026-10-06, using Codex **0.160.0**. Direct
`codex --no-daemon sandbox -P vivary-boundary` commands supplied explicit inline
profiles: broad filesystem reads (`:root=read`), with either no write grant or
one disposable project write grant, and network disabled. CLI/plugin hooks were
disabled only for these diagnostic commands; production settings were unchanged.
The same harmless script ran in the command and an ordinary Python child.

| Operation, observed in both parent and child | Unsandboxed control | Explicit read-only profile | Explicit workspace-write profile |
| --- | --- | --- | --- |
| Read sibling sentinel | Allowed, canary matched | Allowed, canary matched | Allowed, canary matched |
| Write inside disposable project | Allowed | Denied, errno 30 (`EROFS`) | Allowed |
| Write sibling fixture | Allowed | Denied, errno 30 (`EROFS`) | Denied, errno 30 (`EROFS`) |
| Connect to live loopback canary | Allowed, canary matched | Denied, errno 1 (`EPERM`) | Denied, errno 1 (`EPERM`) |

All three command results and their child results exited **0**, with empty
stderr. The successful unsandboxed control distinguishes denial from a missing
file or listener. These explicit diagnostic profiles demonstrate selected Linux
command/child restrictions and expected broad reads. They do **not** verify the
actual Vivary app-server's effective policy, escalation, special filesystem paths,
hooks, plugins, MCP or Windows. Initial invalid subcommand/profile setup attempts
ran no fixture operations; their errors are not counted as sandbox denials.

## Verified Linux observation: direct QuickJS and host bridge

Retained `sandbox-probes/quickjs-result.json` records the coordinator's direct
`executeSandboxCode({ evaluator: "run" })` probe at **14:55:51.137 UTC** on
2026-10-06, using installed Core **0.176.5**. It made no model call. The globals
`process`, `require` and `fetch` each had type `undefined`; importing
`node:fs` failed with `could not load module 'node:fs'`. A registered benign
read-only `boundary-canary` bridge action **did read the outside sentinel**, and
reported a canary match. The helper exited **0**, with empty stderr, no timeout
and that bridge listed in `bridgeToolsUsed`.

These observations distinguish evaluator access from approved host execution.
They do not validate authorization of every production action or contain the
host, its subprocesses or MCP. Default Full chat execution remains off; actual
production composition and Windows evaluator checks remain **UNRUN**.

## Hook lifecycle observation: correlation only

The coordinator's retained `sandbox-probes/RESULTS.md` reports fresh approved
Entire lifecycle metadata outside the writer's two declared writable roots,
correlated with SessionStart/TurnStart and initialized-shadow-session diagnostics.
No syscall trace attributes the write to a particular hook PID. This is an
observed lifecycle side effect, **not a controlled hook escape test**, proof of
arbitrary access or verification of hook containment. No hook/trust configuration
was changed for this observation. Plugin hooks, configured MCP, direct Claude
execution and Windows remain untested.

## Portable remaining proof and release gaps

For each **UNRUN** surface, record the exact candidate, CLI/runtime version,
platform, permission mode and effective configuration. Use disposable
inside/outside sentinels, boolean/error-only results, an allowed positive control
and a live coordinator-owned loopback canary; connection refusal alone does not
prove network denial. Probe reads, writes and network separately, then repeat in
an ordinary child where that surface permits one. A denied spawn establishes
only the spawn denial.

Retain the direct QuickJS/benign bridge distinction when checking actual Full chat
composition and production action authorization. Exercise CLI hooks through a
documented lifecycle invocation and MCP through a disposable local server, keeping
each process's access results
separate from the command tool. If no supported no-model hook invocation is
available, keep it **UNRUN** pending a separately authorized journey. Repeat
applicable checks on the exact Windows package; Linux observations do not prove
Windows containment. No new policy, login, hook configuration or model allowance
is authorized by these proof descriptions.

The coordinator's retained `session10-ui-results.json` records fixture browser
checks at **15:33:06.905 UTC** on 2026-10-06, against the reviewed uncommitted #10
slice based on `8b1d1e4`. Synthetic persisted Native sessions passed desktop
1440×1000 and narrow 390×844 layouts, keyboard Enter/Escape and focus restoration,
loading/error/Retry and missing/empty-log states, and conversation switches
without retaining the previous run's ID. Authenticated details, read-time
redaction and foreign-owner refusal also passed. These checks made **no provider
calls**; they do not verify actual provider-native logs or provider continuity.

#10 still needs real provider start/follow-up/Stop/full-host-restart/resume,
provider-native log placement and safe availability, and actual project-switch UI
checks. Windows/Electron and phone-hardware checks remain omitted from this fixture
journey. Final #23 acceptance remains tied to the exact packaged artifact.
