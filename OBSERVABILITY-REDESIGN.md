# Vivary GUI — Codex-centered observability + approval redesign

> **Purpose / start here.** This is a self-contained restart packet for a fresh session.
> It folds research (how ChatGPT, Claude.ai, Codex, and the agentic-coding ecosystem
> display tool calls / reasoning / approvals) into one plan: rebuild the Vivary GUI chat
> from a flat wall-of-text into a clean, structured surface — **collapsible tool pills, a
> streaming reasoning box, a privileged final answer, and a user-controlled approval
> system** — with **Codex as the cornerstone runtime**. Read AGENTS.md/CLAUDE.md first,
> then this. Nothing here is implemented yet; the items below are the work.

---

## 1. Context

**Product.** Vivary is a scaffold + standard for agent-native workspaces (zero-dep Python
CLIs: `tropo`/`ozone`/`exo`/`create-vivary`, all published on PyPI). The **Vivary GUI** is a
local web app to drive those workspaces: a persistent chat that runs coding agents, plus
contextual views (search · files · state · graph · gates · dashboard).

**Where the code lives.**
- Active dev: the monorepo clone `C:\Users\jeffk\dev\vivary-GUI`, branch **`feat/gui`**,
  GUI under **`app/`** (`app/backend` FastAPI + `app/frontend` React/Vite/TS).
- Published standalone: **`github.com/vivary-dev/vivary-gui`** (public; a decoupled snapshot
  that runs on the published `vivary-*` PyPI engines, not the monorepo). The canonical home
  going forward is the standalone repo; this redesign should land there too.

**What already works (committed on `feat/gui`).**
- Chat with **markdown rendering** + frontmatter stripping (`app/frontend/src/markdown.tsx`),
  **viewport-fit layout** (no page scroll, pinned composer, no forced scroll-to-bottom).
- **Turn-boundary gates**: agent raises a `gates/*.md`, the run pauses, you approve in the
  UI, it resumes (`manager.py` gate-diff + `gates_open` event + session-scoped gate
  endpoints + resume).
- Real backend: FTS5 search, file tree, state surface, graph/blast, gates, multi-session
  dashboard. Bridge **decoupled** to the published engines (`python -m tropo/ozone/exo`).
- Runtimes: **claude**, **codex**, **echo** (all detected/available on this machine).

**The problem (what this redesign fixes).** The chat dumps everything as a flat stream:
tool calls, command output, reasoning, and metadata all render inline as undifferentiated
text — a ~2,000-line scroll before the actual answer. (See the pasted Codex transcript that
motivated this.) For Codex specifically the cause is concrete: the GUI runs it in
plain-text mode (`codex exec --`) and `CodexRuntime.parse()` emits **one `text` event per
output line**. The cure is structured events + a structured UI.

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

> Sample a **real multi-tool run** early (`codex exec --json --skip-git-repo-check -C <repo>
> --sandbox read-only -- "list the files and read README"`) and capture the JSONL as a test
> fixture — it confirms which items emit `item.updated` deltas (needed for one-line reasoning
> streaming) vs only `item.completed`.

---

## 5. Implementation plan

### 5a. Backend (`app/backend/vivary_gui`)

**Event taxonomy** (`services/agents/base.py`) — extend `AgentEvent` types from
`user_msg|text|tool_use|tool_result|result|status|error|turn_end|gates_open` to add:
`reasoning` (with a `streaming` flag / delta), `tool` (unified, carrying `kind`,
`command`/`tool`, `status`, `exit_code`), `tool_output`, `file_change` (with `changes[]`),
`plan`/`todo`, and `approval_request` (see 5c). `AgentEvent.meta` is already generic — most
of this is parse + emit, plus typing.

**CodexRuntime** (`services/agents/base.py`) — replace today's
`["codex","exec","--",prompt]` (plain text) + line-as-text `parse()` with:
- `build_command`: `codex exec --json --skip-git-repo-check -C <cwd> --sandbox <mode>
  -- <prompt>`.
- `parse(line)`: JSON-decode each line; map lifecycle + item events → the new `AgentEvent`
  types per §4. Track `item.id` to correlate `started → updated → completed`. Capture
  `thread_id` for resume; map `turn.completed.usage` → the token/cost meter.
- `multi_turn` remains disabled until the resume/protocol spike proves the exact command
  shape and GUI state contract.

**Manager** (`services/agents/manager.py`) — the existing turn lifecycle (send / `_run_turn`
/ subscribe / cancel / resume, and the turn-boundary gate diff) mostly stands. Add the
**approval policy engine** (see 5c) and, for live approval, the bidirectional channel (5c).

### 5b. Frontend (`app/frontend/src`)

Replace the flat `Block` renderer in `views/ChatPanel.tsx` (today: `user|text|tool|status|
error`, with the always-expanded tool card) with composable components:
- **`ToolPill`** — collapsed, risk-colored (use `theme.ts` tokens: `C.accent` mint=read,
  `C.warn` amber=write/network, `C.err` red=execute/delete), status dot, diffstat; expand →
  command + `aggregated_output` + exit/duration.
- **`ReasoningBox`** — one live line (latest `reasoning` text), collapsed-but-pinnable,
  expand → full summarized trace; "Thought for N s" receipt on completion.
- **`FileChange`** — per-file diff list from `file_change.changes[]`; (stretch) per-hunk
  accept/reject gated **before** the write.
- **`PlanRail`** — `todo_list` items as a live checklist.
- Keep `<Markdown>` for `agent_message` as the privileged final answer.
- Add a **density control** (Compact/Balanced/Detailed) and **consolidate repeats**.
- Extend `api/client.ts` event types + the `apply()` reducer for the new event kinds.

### 5c. Approval system (the centerpiece)

**Live interception (keystone — resolve first, see §6).** `codex exec` is one-shot and
non-interactive; mid-run approval needs a bidirectional protocol surface, not bare `exec`.
Candidate surfaces are **`codex app-server`**, **`codex exec-server`**, **`codex
remote-control`**, and **`codex mcp-server`**. Decision: observability can ship on
`exec --json`; **live approval depends on the protocol investigation.** ACP (Agent Client
Protocol, `agentclientprotocol.com`) is the reference vocabulary (`ToolCall.{title,kind,status}`,
`PermissionOption.{optionId,name,kind}`) — target it.

**Policy engine** (backend, new module e.g. `services/approval.py`):
- **Mode**: `manual | auto | yolo` (default **auto**).
- **Risk tiers by kind**: read→auto, write→ask, execute/network/delete→ask. Deterministic
  classification (do NOT let the model self-label "safe").
- **Allowlist**: pattern-scoped rules `{pattern, scope: command|project|global, decision:
  allow|ask|deny}`, longest-prefix / word-boundary match, **deny beats allow**. On "Allow
  always" → extract a safe prefix pattern, persist with the chosen scope.
- **Protected paths**: `.git`, `.env`, config, dotfiles — never auto-approve.
- **Circuit-breaker**: cap auto-approvals per turn/session → fall back to ask.
- **Persistence**: `~/.vivary-gui/policy.json` (global) + per-workspace `.vivary/rules`
  (project, version-controllable) — mirror Codex's layered `prefix_rule()` model.

**Approval UI** (frontend): a risk-colored **ApprovalCard** with **Allow once / Allow always
(+ scope selector) / Deny (+ steering text)**; a **Settings** panel for the three-rung mode +
per-risk policy + allowlist management.

**Differentiators to build (beat Codex's own surfaces):** per-hunk diffs **gated before the
write**; **pattern-scoped trust** that doesn't re-prompt on variation; a **per-command risk
classifier** (Codex only does mode-level risk); keep our **turn-boundary gates** (Codex cloud
has no mid-run gate).

---

## 6. Keystone open questions (resolve before/early in build)

1. **Live-approval protocol** — spike `codex app-server`, `exec-server`, `remote-control`,
   and `mcp-server`: how does the GUI receive an approval request mid-run and send allow/deny?
   Does any surface expose ACP-like vocabulary? This decides the backend integration shape for
   the approval half. (Observability via `exec --json` does **not** depend on this.)
2. **Reasoning streaming granularity** — does `exec --json` emit `item.updated` deltas for
   `reasoning` (needed for the live one-line ticker), or only `item.completed`? Capture a real
   fixture and confirm.
3. **Resume semantics** under the chosen protocol (`codex exec resume <thread_id>` for exec,
   vs app-server or exec-server thread continuation).
4. **Policy persistence location** — `~/.vivary-gui/` vs per-workspace `.vivary/`.

---

## 7. Sequencing (both-together scope, dependency-ordered)

- **Phase A — Observability (low risk, ships the wall-of-text fix).** Switch CodexRuntime to
  `exec --json` + the item parser; extend the event taxonomy; build ToolPill / ReasoningBox /
  FileChange / PlanRail + density control; privilege the final answer. Verify against captured
  JSONL fixtures + a live Codex run.
- **Phase B — Approval (depends on §6.1).** Spike the app-server/proto protocol; build the
  policy engine + ApprovalCard + Settings; wire live interception + pattern-scoped persistence;
  add the per-command risk classifier and protected-paths/circuit-breaker guards.

Both are in scope ("both together"); Phase A is independent and de-risks the UI; Phase B
waits only on the protocol spike.

## 8. Verification

- **Backend unit**: parse captured Codex `--json` JSONL fixtures → assert the right
  `AgentEvent`s. Policy engine: risk classification, allowlist match (prefix/deny-beats-allow),
  protected paths, circuit-breaker.
- **Live**: run a real Codex session in the GUI — confirm pills/reasoning/diffs/plan render
  and the transcript is answer-first; trigger a gated command — confirm the ApprovalCard
  blocks, allow/deny works, and **"Allow always" persists and does NOT re-prompt** on a
  variant command.
- **Pipeline**: keep the echo runtime green; `pytest -q`, `tsc -b`, `eslint` clean.

## 9. Non-goals / out of scope (for this redesign)
- Claude Agent SDK re-platform (dropped — Codex is cornerstone).
- Re-deriving the standalone repo publish (already done: `vivary-dev/vivary-gui`).
- The two pre-existing `ChatPanel` session-bootstrap lint issues (separate cleanup).

## 10. Appendix — research sources
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
