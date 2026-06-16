# Vivary GUI — Codex-centered observability + approval redesign

> **Purpose / start here.** This is the canonical live spec for the Vivary GUI
> Observability + Approval Redesign. It preserves the research and design vocabulary,
> but now records what is implemented, how it is verified, and which claims remain gated.
> The implemented surface rebuilds Codex output from flat transcript text into typed
> receipts — **collapsible tool pills, reasoning receipts, file-change receipts, a plan
> rail, a privileged final answer, and a tested approval-card path** — with **Codex as the
> cornerstone runtime**. Read AGENTS.md first, then this.

---

## 0. Live status (2026-06-16)

**Implementation branch/worktree.**
- Coordination branch: `feat/gui` at local checkpoint `1c68440`.
- Active implementation branch: `feat/gui-observability-loop`.
- Active implementation worktree: `C:\Users\jeffk\dev\vivary-GUI-obs-loop`.
- Coordination ledger: `todos/EBTASK-OBSERVABILITY.md`.

**Implemented and locally verified.**
- Codex runs through `codex exec --json --skip-git-repo-check -C <cwd> --sandbox read-only -- <prompt>`.
- Backend emits typed events while preserving the stable wire shape:

  ```ts
  type AgentEvent = {
    type: string
    text: string
    tool: string
    meta: Record<string, unknown>
  }
  ```

- Structured event types are implemented for `reasoning`, `tool`, `file_change`,
  `plan`, and `approval_request`. `agent_message` still maps to `text`.
- Parser tests include a synthetic JSONL fixture plus a captured live read-only Codex
  fixture at `app/backend/vivary_gui/tests/fixtures/codex_jsonl_live_readonly.jsonl`.
- Deterministic approval policy and session approval endpoint are implemented and
  tested. Policy persistence is global by default at `~/.vivary-gui/policy.json`.
- Chat UI is reducer-driven with Markdown final answers, collapsed tool receipts,
  reasoning receipts, file-change receipts, plan rail, density controls, compact read
  consolidation, and approval-card decision flow.
- Fixture runtime is gated behind `VIVARY_GUI_ENABLE_FIXTURE_RUNTIME=1`.
- GUI CI job covers backend tests, frontend unit tests, lint, build, Playwright fixture
  E2E, and Chromium installation.

**Gated / not claimed.**
- Real mid-run Codex approval is **not** wired yet. `codex exec --json` is
  non-interactive; live approval requires a proven app-server, exec-server,
  remote-control, or MCP request/response path.
- Codex resume remains disabled in the GUI until protocol evidence proves the correct
  state and command contract.
- The live Codex fixture did not emit `reasoning` items, so real Codex reasoning
  delta granularity remains inconclusive. Synthetic tests cover the parser shape.
- Project policy persistence is intentionally not implemented. Project-scoped rules are
  inert until a tested story adds project context; the active approval UI exposes
  command/global scopes only.
- Human app testing is the final gate before PR, push, merge, or branch consolidation.

## 1. Context

**Product.** Vivary is a scaffold + standard for agent-native workspaces (zero-dep Python
CLIs: `tropo`/`ozone`/`exo`/`create-vivary`, all published on PyPI). The **Vivary GUI** is a
local web app to drive those workspaces: a persistent chat that runs coding agents, plus
contextual views (search · files · state · graph · gates · dashboard).

**Where the code lives.**
- Active dev: the monorepo clone `C:\Users\jeffk\dev\vivary-GUI`, branch **`feat/gui`**,
  GUI under **`app/`** (`app/backend` FastAPI + `app/frontend` React/Vite/TS).
- This redesign is isolated in sibling worktree `C:\Users\jeffk\dev\vivary-GUI-obs-loop`,
  branch **`feat/gui-observability-loop`**, cut from the local checkpoint `1c68440`.
- Published standalone: **`github.com/vivary-dev/vivary-gui`** (public; a decoupled snapshot
  that runs on the published `vivary-*` PyPI engines, not the monorepo). The canonical home
  going forward is the standalone repo; this monorepo implementation must be human-tested
  before any PR/push/merge or standalone-port decision.

**What already works in the current implementation branch.**
- Chat with **markdown rendering** + frontmatter stripping (`app/frontend/src/markdown.tsx`),
  **viewport-fit layout** (no page scroll, pinned composer, no forced scroll-to-bottom).
- Codex structured observability through `exec --json`, with `agent_message` preserved as
  final-answer `text`.
- Reducer-driven receipts for tools, reasoning, file changes, plan items, approval requests,
  and density controls.
- Deterministic backend approval policy plus tested approval decision endpoint.
- Fixture runtime and Playwright fixture E2E, gated behind `VIVARY_GUI_ENABLE_FIXTURE_RUNTIME=1`.
- **Turn-boundary gates**: agent raises a `gates/*.md`, the run pauses, you approve in the
  UI, it resumes (`manager.py` gate-diff + `gates_open` event + session-scoped gate
  endpoints + resume).
- Real backend: FTS5 search, file tree, state surface, graph/blast, gates, multi-session
  dashboard. Bridge **decoupled** to the published engines (`python -m tropo/ozone/exo`).
- Runtimes: **claude**, **codex**, **echo** (all detected/available on this machine).

**The problem this redesign fixes.** The old chat dumped everything as a flat stream:
tool calls, command output, reasoning, and metadata rendered inline as undifferentiated
text before the answer. For Codex specifically the cause was concrete: the GUI ran plain
text `codex exec --` and parsed **one `text` event per output line**. The implemented cure
is source-level structured JSONL parsing plus a structured UI.

---

## 2. Decision (locked): Codex is the cornerstone

Build the structured-observability + live-approval redesign around **Codex**, not Claude.
Claude and echo remain secondary runtimes. Rationale (verified this session):

- **`codex exec --json` emits structured JSONL events** — every command, reasoning step,
  file change, and final message is a discrete typed item, not a text blob. This is the
  cure for the wall-of-text, at the source.
- **Native sandbox model** — `--sandbox {read-only|workspace-write|danger-full-access}` is
  present on `codex exec`. The older plan assumed an `--ask-for-approval` exec flag, but
  `codex-cli 0.139.0` does not expose that flag on `exec`; live approval must use a
  protocol surface, not bare non-interactive exec.
- **Programmatic surfaces** — `codex app-server`, `codex exec-server`, `codex remote-control`,
  `codex mcp-server`, and `codex exec resume` all exist locally and are the approval/resume
  spike candidates.
- The Claude-Agent-SDK re-platform is **off the table**.

### Local Codex protocol evidence (2026-06-16)

Verified on this machine with `codex-cli 0.139.0`:

| Command | Evidence | Decision impact |
|---|---|---|
| `codex exec --help` | Non-interactive runner; supports `--json`, `--sandbox read-only/workspace-write/danger-full-access`, `-C/--cd`, `--skip-git-repo-check`, `resume`, and `--output-schema`. If stdin is piped and a prompt is provided, stdin is appended. | Phase A uses `exec --json`; fixture captures must close stdin explicitly. |
| `codex app-server --help` | Experimental app-server with `daemon`, `proxy`, `generate-ts`, `generate-json-schema`, `stdio://`, Unix socket, and websocket transports with auth options. | Candidate for GUI live approval and generated protocol bindings. |
| `codex exec-server --help` | Experimental standalone exec-server over websocket or stdio, with optional remote registration. | Candidate for non-interactive execution with an out-of-band service boundary. |
| `codex remote-control --help` | Starts/stops the app-server daemon with remote control enabled and can emit JSON. | Candidate control plane, not yet proven for approval request/response. |
| `codex mcp-server --help` | Starts Codex as a stdio MCP server. | Candidate integration surface, but approval semantics still need proof. |

Decision: `exec --json` is accepted for observability. Real mid-run Codex approval is not
claimed until one protocol path proves how the GUI receives an approval request and sends
allow/deny back.

---

## 3. Design vocabulary (research-backed)

The best harnesses converged on the same patterns. Targets, each with a one-line "why":

### Tool calls → collapsed, risk-colored pills
- **One line per call**: icon + verb + target + status + diffstat; collapsed by default,
  click to expand command/output. (ChatGPT, Claude.ai, Cursor, Cline, Claude Code, Zed.)
- **Status lifecycle** on the pill (`pending → running → done/failed`) drives spinner/✓/✗.
- **Kind-based icon + color** (read/edit/delete/execute/search/fetch) so users pre-attentively
  scan what the agent is doing.
- **Density control** (Cursor Compact/Balanced/Detailed; Claude Code `/focus`) — the strongest
  anti-wall-of-text lever. **Consolidate repeats** ("Read ×3").
- **Route file edits to a review surface**, not the inline stream (Zed's biggest win).

### Reasoning → one streaming line, collapsed-but-pinnable
- **A single summarized line that updates live while thinking, then auto-collapses to
  "Thought for N s"**, expandable to the full (summarized, not raw) trace. (ChatGPT's
  gold-standard pattern.)
- Two hard rules from the complaints: **don't auto-collapse while the user is still reading**
  (Cursor) and **don't expand-by-default and bury the answer** (Zed). → collapsed by default,
  **user can pin open**.
- Show **summarized**, not raw (raw thinking is 5–20× the answer). Surface the
  `low/medium/high` reasoning-effort control in the UI.

### Hierarchy → the final answer is the only full-fidelity element
- Everything else is a **collapsed receipt or a side panel**; **color is spent only on the
  live/active step**. Heavyweight output → a side surface, not the transcript (ChatGPT
  Canvas, Claude artifact split-pane, Codex cloud Plan/Sources/Artifacts/Summary rails).

### Approval → the centerpiece + our differentiator
- **Allowlist-first, never denylist-first** (denylists are bypassable via Base64/subshells).
- **Risk-tiered defaults**: reads **auto**, writes **ask**, execute/network/delete **always
  ask** unless allowlisted. Risk shown by **color + icon + label** (red=execute/delete,
  amber=write/network, neutral=read).
- **Three-rung ladder, default the middle**: Manual → **Auto (read auto / write+execute ask)**
  → YOLO.
- **Real buttons**: **Allow once · Allow always · Deny** — and **deny doubles as a steering
  message** ("No, and do X instead"). (= Codex's CLI prompt = ACP `PermissionOption.kind`:
  `allow_once/allow_always/reject_once/reject_always`.)
- **"Always" = a pattern-scoped, persisted rule** (command-prefix / project / global), **not
  an exact string**. Codex's #1 documented pain is re-prompting on slight variation; we fix it.
- **Protected paths never auto-approve** (`.git`, `.env`, config) + **session circuit-breakers**
  (cap runaway auto-approvals, fall back to ask).

---

## 4. Codex event model (build the parser to this)

`codex exec --json` is JSONL. Two tiers: **lifecycle** events and **item** events
(`item.started` / `item.updated` / `item.completed`, each with `item.id` + `item.type`).

```
{"type":"thread.started","thread_id":"019…"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_1","type":"command_execution",
   "command":"bash -lc ls","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution",
   "command":"bash -lc ls","aggregated_output":"docs\nsrc\n","exit_code":0,"status":"completed"}}
{"type":"item.completed","item":{"id":"item_4","type":"file_change",
   "changes":[{"path":"docs/exec.md","kind":"update"},{"path":"docs/new.md","kind":"add"}],"status":"completed"}}
{"type":"turn.completed","usage":{"input_tokens":…,"cached_input_tokens":…,"output_tokens":…,"reasoning_output_tokens":…}}
```

| `item.type` | Key fields | Renders as |
|---|---|---|
| `agent_message` | `text` | the **clean final answer** (markdown, full weight) |
| `reasoning` | `text` (stream via `item.updated`) | **streaming reasoning box** |
| `command_execution` | `command`, `aggregated_output`, `exit_code`, `status` | **collapsible risk-colored pill** |
| `file_change` | `changes[].path`, `changes[].kind` (add/update/delete), `status` | **diff list / per-file pill** |
| `mcp_tool_call` | `server`, `tool`, `arguments`, `result`, `status` | tool-call card |
| `web_search` | `query` | search pill |
| `todo_list` | `items[].text`, `items[].completed` | **live plan rail** |
| `error` | `message` | inline warning |

Lifecycle: `thread.started{thread_id}` (resume id), `turn.started`, `turn.completed{usage}`,
`turn.failed{error}`, `error{message}`.

Live fixture note: EB-OBS-010 captured a real read-only Codex JSONL fixture by piping empty
stdin so Codex did not wait for input append. The fixture emitted lifecycle, command
execution, final-message, and usage events, but no `reasoning` items. Synthetic fixtures still
cover reasoning `item.updated` behavior; real reasoning streaming granularity remains
inconclusive.

---

## 5. Live implementation map

### 5a. Backend (`app/backend/vivary_gui`)

**Event taxonomy** (`services/agents/base.py`) is implemented with the stable wire shape:
`type`, `text`, `tool`, and `meta`. New structured events include `reasoning`, `tool`,
`file_change`, `plan`, and `approval_request`; legacy `text` remains the final-answer path.

**CodexRuntime** (`services/agents/base.py`) now builds:
`codex exec --json --skip-git-repo-check -C <cwd> --sandbox read-only -- <prompt>`.
The parser JSON-decodes each line, maps lifecycle and item events into `AgentEvent`s, keeps
`agent_message` as `text`, records usage on `turn.completed`, and downgrades unknown or bad
JSON without leaking it into final answer text. `multi_turn` stays disabled until resume and
protocol behavior are proven.

**Manager** (`services/agents/manager.py`) keeps the existing turn lifecycle and turn-boundary
gate handling, and now owns deterministic approval decisions for fixture/tested approval
requests. The live Codex bidirectional approval channel is intentionally not claimed.

### 5b. Frontend (`app/frontend/src`)

The flat block renderer in `views/ChatPanel.tsx` has been replaced with a reducer-driven chat
model under `app/frontend/src/chat/` and composable receipts:
- **`ToolPill`** — collapsed, risk-colored (use `theme.ts` tokens: `C.accent` mint=read,
  `C.warn` amber=write/network, `C.err` red=execute/delete), status dot, diffstat; expand →
  command + `aggregated_output` + exit/duration.
- **`ReasoningBox`** — one live line (latest `reasoning` text), collapsed-but-pinnable,
  expand → full summarized trace; "Thought for N s" receipt on completion.
- **`FileChange`** — per-file diff list from `file_change.changes[]`; (stretch) per-hunk
  accept/reject gated **before** the write.
- **`PlanRail`** — `todo_list` items as a live checklist.
- Keep `<Markdown>` for `agent_message` as the privileged final answer.
- **Density control** (Compact/Balanced/Detailed) is implemented; compact mode consolidates
  repeated completed read receipts.
- `api/client.ts` exposes the stable event type and the approval decision API.

### 5c. Approval system (the centerpiece)

**Live interception (still gated, see §6).** `codex exec` is one-shot and non-interactive;
mid-run Codex approval needs a bidirectional protocol surface, not bare `exec`.
Candidate surfaces are **`codex app-server`**, **`codex exec-server`**, **`codex
remote-control`**, and **`codex mcp-server`**. Decision: observability can ship on
`exec --json`; **live approval depends on the protocol investigation.** ACP (Agent Client
Protocol, `agentclientprotocol.com`) is the reference vocabulary (`ToolCall.{title,kind,status}`,
`PermissionOption.{optionId,name,kind}`) — target it.

**Policy engine** (`services/approval.py`) is implemented and tested:
- **Mode**: `manual | auto | yolo` (default **auto**).
- **Risk tiers by kind**: read→auto, write→ask, execute/network/delete→ask. Deterministic
  classification (do NOT let the model self-label "safe").
- **Allowlist**: pattern-scoped rules `{pattern, scope: command|project|global, decision:
  allow|ask|deny}`, longest-prefix / word-boundary match, **deny beats allow**. On "Allow
  always" → extract a safe prefix pattern, persist with the chosen scope.
- **Protected paths**: `.git`, `.env`, config, dotfiles — never auto-approve.
- **Circuit-breaker**: cap auto-approvals per turn/session → fall back to ask.
- **Persistence**: `~/.vivary-gui/policy.json` global policy only. Project policy is a
  future tested story, not part of this implementation.

**Approval UI** (frontend): a risk-colored **ApprovalCard** with **Allow once / Allow always
(command/global scope selector) / Deny (steering text)** is implemented and tested. Project
scope remains accepted by the API shape but does not persist global policy rules until a
tested project-policy story exists. A full policy settings panel is not implemented in this
slice.

**Differentiators retained in the roadmap:** per-hunk diffs gated before write,
pattern-scoped trust that avoids re-prompting on variants, deterministic per-command risk
classification, and existing Vivary turn-boundary gates. Only the deterministic policy,
decision endpoint, and approval-card flow are implemented now.

---

## 6. Keystone decisions and remaining open questions

1. **Live-approval protocol** — still open. Help output proves `app-server`,
   `exec-server`, `remote-control`, and `mcp-server` exist locally, but no request/response
   approval path has been proven. Observability ships on `exec --json`; live Codex approval
   waits for protocol evidence.
2. **Reasoning streaming granularity** — partially open. Synthetic fixtures prove parser
   handling for `item.updated` reasoning, but the captured live Codex fixture emitted no
   reasoning items.
3. **Resume semantics** — open. `codex exec resume` exists, but GUI resume remains disabled
   until the runtime/protocol state contract is proven.
4. **Policy persistence location** — decided for this slice: global policy only at
   `~/.vivary-gui/policy.json`. Project policy is explicitly future work.

---

## 7. Sequencing status

- **Phase A — Observability: implemented.** CodexRuntime uses `exec --json`; backend parses
  typed events; frontend renders ToolPill / ReasoningBox / FileChange / PlanRail / density
  controls; final answers remain Markdown.
- **Phase B — Approval scaffold: partially implemented.** Deterministic policy, global
  persistence, backend approval decision API, approval event updates, and ApprovalCard are
  implemented and tested with fixtures.
- **Phase B — Real Codex live approval: gated.** No claim is made until one Codex protocol
  surface proves a mid-run approval request/response path.

The stop state for this branch is `human_test_pending`, not merge-ready.

## 8. Verification

Latest story-level verification on 2026-06-16:

| Check | Result |
|---|---|
| Backend parser tests | 6 passed |
| Backend GUI tests | 30 passed, 1 warning |
| Approval policy tests | 10 passed |
| Frontend unit tests | 2 files passed, 11 tests passed |
| Frontend lint | passed |
| Frontend build | passed |
| Playwright fixture E2E | 1 passed |
| `npm audit` | 0 vulnerabilities |
| `git diff --check` | passed |

The final thermonuclear review must rerun the full matrix before handoff:
backend GUI tests, frontend tests, lint, build, audit, Playwright E2E, diff hygiene, and the
original Vivary suites when touched scope justifies them.

## 9. Non-goals / out of scope (for this redesign)
- Claude Agent SDK re-platform (dropped — Codex is cornerstone).
- Push, PR, merge, publish, or branch consolidation.
- Real mid-run Codex approval wiring without protocol request/response evidence.
- Project-scoped policy persistence.
- Full approval policy settings UI.
- Re-deriving the standalone repo publish.

## 10. Human final test gate

Before any PR, push, merge, or consolidation, Jeff must manually test the app from the
implementation branch. The handoff must include:

- Branch/worktree path and dirty state.
- Verification matrix results and known P2 risks.
- Local launch command and URL.
- Manual test script covering add/open workspace, fixture runtime, collapsed tool receipts,
  expanded tool output, reasoning receipt, file-change receipt, density control, approval-card
  decision flow, and a real Codex read-only prompt if available.

The branch may stop at `human_test_pending`; it must not merge itself.

## 11. Appendix — research sources
- ChatGPT reasoning/tools UX: help.openai.com/en/articles/9237897 (search/citations),
  /11487775 (Apps approval cards + risk tiers), openai.com/index/gpt-5-1 (adaptive thinking),
  digestibleux.com/p/how-ai-models-show-their-reasoning (one-line-then-collapse).
- Claude.ai: platform.claude.com/docs/en/build-with-claude/extended-thinking (summarized/
  streaming), support.claude.com/en/articles/9487310 (artifacts split-pane).
- Codex: developers.openai.com/codex/{noninteractive (event taxonomy), agent-approvals-security,
  rules (prefix_rule), ide, cloud}; takopi.dev/reference/runners/codex/exec-json-cheatsheet.
- Patterns/approval: agentclientprotocol.com/protocol/{tool-calls,overview};
  roocodeinc.github.io/Roo-Code/features/auto-approving-actions; code.claude.com/docs/en/
  permissions; cursor.com/docs/agent/tools/terminal; zed.dev/docs/ai/tool-permissions.
