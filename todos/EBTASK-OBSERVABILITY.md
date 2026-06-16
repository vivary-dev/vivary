# EBTASK-OBSERVABILITY

Epic: Vivary GUI Observability + Approval Redesign  
Status: in_progress  
Branch baseline: `feat/gui` at `1c68440`
Coordination worktree: `C:\Users\jeffk\dev\vivary-GUI`  
Implementation worktree: `C:\Users\jeffk\dev\vivary-GUI-obs-loop`  
Implementation branch: `feat/gui-observability-loop`  
Last updated: 2026-06-16

## Objective

Replace flat Codex transcript rendering with typed observability events, reducer-driven
chat receipts, deterministic approval policy scaffolding, a fixture-backed test harness,
and a canonical live spec. Keep the stable wire shape:

```ts
type AgentEvent = {
  type: string
  text: string
  tool: string
  meta: Record<string, unknown>
}
```

## Hard Gates

- No push, PR, merge, publish, destructive operation, or dependency install without
  explicit human approval.
- No branch consolidation into `feat/gui`, `dev`, or `prod` before Jeff manually tests
  the app and approves the result.
- Stop before live Codex mid-run approval claims unless a protocol spike proves the
  request/response path.
- Do not modify `.claude/settings.local.json` or `MESO-CANVAS-PLAN.md`.

## Loop Contract

Each loop tick must:

1. Read `AGENTS.md`, `OBSERVABILITY-REDESIGN.md`, and this ledger.
2. Audit `git status --short --branch` and `git worktree list --porcelain`.
3. Select exactly one open story.
4. Record test plan before edits.
5. Edit only owned files.
6. Run story-level checks.
7. Update this ledger with evidence.
8. Fix failures within the same owned scope.
9. Stop on hard gates, ownership conflicts, missing dependencies, repeated no-progress,
   repeated verification failure, or `human_test_pending`.

Hard stops: max 16 ticks, 2 no-progress ticks, 2 repeated failures of the same check.

## Baseline From Live State

Current dirty implementation already includes:

- `CodexRuntime` using `codex exec --json --skip-git-repo-check -C <cwd> --sandbox read-only -- <prompt>`.
- Structured backend events: `reasoning`, `tool`, `file_change`, `plan`,
  `approval_request`, with `text` preserved for final answer compatibility.
- `FixtureRuntime`, hidden unless `VIVARY_GUI_ENABLE_FIXTURE_RUNTIME=1`.
- Deterministic approval policy module and session approval endpoint.
- Reducer-driven chat UI with reasoning, tool, file-change, plan, approval, and
  density components.
- Backend parser and policy tests.
- Frontend reducer and receipt tests.
- Playwright fixture E2E and GUI CI job.

Verified before this ledger was created:

| Check | Result |
| --- | --- |
| `app\backend\.venv\Scripts\python.exe -m pytest -q app\backend\vivary_gui\tests` | 25 passed, 1 warning |
| `npm run test` in `app/frontend` | 9 passed |
| `npm run lint` in `app/frontend` | passed |
| `npm run build` in `app/frontend` | passed |
| `npm audit` in `app/frontend` | 0 vulnerabilities |
| `npm run e2e` in `app/frontend` | 1 passed |
| `git diff --check` | passed |

Known baseline gap:

- Parser fixture is synthetic. Live Codex JSONL fixture evidence still needs to be
  captured or consciously marked blocked with command evidence.

## File Ownership Table

| Story | Owner | Worktree | Owned paths |
| --- | --- | --- | --- |
| EB-OBS-000 | main agent | coordination | `todos/EBTASK-OBSERVABILITY.md`, git checkpoint/worktree metadata |
| EB-OBS-010 | main agent | implementation | `app/backend/vivary_gui/services/agents/base.py`, `app/backend/vivary_gui/tests/test_codex_runtime.py`, `app/backend/vivary_gui/tests/fixtures/` |
| EB-OBS-020 | main agent | implementation | `OBSERVABILITY-REDESIGN.md`, `todos/EBTASK-OBSERVABILITY.md` |
| EB-OBS-030 | main agent | implementation | `app/backend/vivary_gui/services/approval.py`, `app/backend/vivary_gui/services/agents/manager.py`, `app/backend/vivary_gui/routers/sessions.py`, `app/backend/vivary_gui/config.py`, `app/backend/vivary_gui/tests/test_approval_policy.py` |
| EB-OBS-040 | main agent | implementation | `app/frontend/src/chat/`, `app/frontend/src/views/ChatPanel.tsx`, `app/frontend/src/api/client.ts`, lint-only compatibility fixes in `app/frontend/src/views/GraphPanel.tsx` and `app/frontend/src/views/StatePanel.tsx` |
| EB-OBS-050 | main agent | implementation | `.github/workflows/ci.yml`, `.gitignore`, `app/frontend/package.json`, `app/frontend/package-lock.json`, `app/frontend/vite.config.ts`, `app/frontend/playwright.config.ts`, `app/frontend/e2e/`, `app/frontend/scripts/`, `app/frontend/src/test/`, `app/backend/pyproject.toml`, `app/backend/vivary_gui/services/agents/_fixture_agent.py` |
| EB-OBS-060 | main agent | implementation | `OBSERVABILITY-REDESIGN.md`, `OBSERVABILITY-ATLAS.html` |
| EB-OBS-070 | main agent | implementation | Review notes in this ledger plus P0/P1 fixes in owned files above |

Other agents: claim a disjoint story/path range in this table before editing.

## Stories

### EB-OBS-000 Coordination checkpoint and worktree setup

Status: completed
Dependencies: none  
Acceptance criteria:

- Ledger exists before further source edits.
- Baseline dirty state and verification evidence are recorded.
- Local checkpoint commit excludes `.claude/settings.local.json` and
  `MESO-CANVAS-PLAN.md`.
- Sibling implementation worktree exists at
  `C:\Users\jeffk\dev\vivary-GUI-obs-loop`.

Test plan before edits:

- `git status --short --branch`
- `git worktree list --porcelain`
- `git diff --check`

Evidence:

- Created `todos/EBTASK-OBSERVABILITY.md` before implementation edits.
- Created local no-push checkpoint commit `1c68440` on `feat/gui`.
- Checkpoint deliberately excluded `.claude/settings.local.json`, `MESO-CANVAS-PLAN.md`,
  Meso files, and unrelated `GraphPanel` / `StatePanel` edits from the coordination tree.
- Created implementation worktree `C:\Users\jeffk\dev\vivary-GUI-obs-loop` on branch
  `feat/gui-observability-loop` at `1c68440`.
- Worktree audit after setup:
  - `C:\Users\jeffk\dev\vivary-GUI` on `feat/gui`
  - `C:\Users\jeffk\dev\vivary-GUI-meso` on `feat/meso-canvas`
  - `C:\Users\jeffk\dev\vivary-GUI-obs-loop` on `feat/gui-observability-loop`
  - no overlapping dirty observability paths in the implementation worktree.

### EB-OBS-010 Codex exec JSON parser and live fixture evidence

Status: completed
Dependencies: EB-OBS-000  
Acceptance criteria:

- `CodexRuntime.build_command()` emits `exec --json --skip-git-repo-check -C <cwd>
  --sandbox read-only -- <prompt>`.
- Parser maps lifecycle and item events to the stable `AgentEvent` wire shape.
- `agent_message` maps to `text`.
- Unknown JSON is ignored or downgraded without becoming final answer text.
- Synthetic fixture remains deterministic.
- Live fixture evidence is captured if safe and available, otherwise blocked with exact
  command evidence.

Test plan before edits:

- `app\backend\.venv\Scripts\python.exe -m pytest -q app\backend\vivary_gui\tests\test_codex_runtime.py`
- `app\backend\.venv\Scripts\python.exe -m pytest -q app\backend\vivary_gui\tests`

Evidence:

- Captured real read-only Codex JSONL fixture:
  `app/backend/vivary_gui/tests/fixtures/codex_jsonl_live_readonly.jsonl`.
- First capture attempt timed out after 180s because Codex waited for stdin; process tree
  was identified and terminated (`node` 37256, `codex` 7592, `node_repl` 39316).
- Successful capture used an empty PowerShell pipeline to close stdin. Command exited 0,
  wrote 12,310 bytes, and emitted `thread.started`, `turn.started`, command execution
  item events, agent messages, and `turn.completed` usage.
- Live fixture did not emit `reasoning` items, so reasoning delta granularity remains
  inconclusive for real Codex runs. Synthetic fixture still covers `item.updated`
  reasoning behavior.
- Fixed parser command classification for Windows Codex shell wrappers such as
  `powershell.exe -Command 'Get-Content README.md'`, so read-only wrapped commands render
  as read receipts instead of danger/execute receipts.
- Added live fixture parser test for Windows read commands, final answer text, usage, and
  absence of file changes.
- Verification:
  - `PYTHONPATH=C:\Users\jeffk\dev\vivary-GUI-obs-loop\app\backend`
    `C:\Users\jeffk\dev\vivary-GUI\app\backend\.venv\Scripts\python.exe -m pytest -q app\backend\vivary_gui\tests\test_codex_runtime.py`
    -> 6 passed.
  - Same Python/PYTHONPATH with `-m pytest -q app\backend\vivary_gui\tests`
    -> 26 passed, 1 warning.
  - `git diff --check` -> passed.

### EB-OBS-020 Codex approval protocol spike

Status: completed
Dependencies: EB-OBS-000  
Acceptance criteria:

- `OBSERVABILITY-REDESIGN.md` records local CLI evidence for `codex-cli 0.139.0`.
- Spec records `exec`, `app-server`, `exec-server`, `remote-control`, and
  `mcp-server` capabilities from `--help`.
- Decision is explicit: Phase A ships on `exec --json`; true live mid-run Codex
  approval remains gated until a protocol request/response path is proven.

Test plan before edits:

- `codex --version`
- `codex exec --help`
- `codex app-server --help`
- `codex exec-server --help`
- `codex remote-control --help`
- `codex mcp-server --help`
- `git diff --check`

Evidence:

- Verified local CLI version: `codex-cli 0.139.0`.
- `codex exec --help` confirms non-interactive execution, `--json`, sandbox modes,
  `-C/--cd`, `--skip-git-repo-check`, `resume`, and stdin append behavior.
- `codex app-server --help` confirms experimental app-server with daemon/proxy,
  TypeScript/schema generation, stdio, Unix socket, and websocket transports.
- `codex exec-server --help` confirms experimental standalone exec-server over websocket
  or stdio, with remote registration options.
- `codex remote-control --help` confirms start/stop of app-server daemon with remote
  control enabled and optional JSON output.
- `codex mcp-server --help` confirms stdio MCP server mode.
- Updated `OBSERVABILITY-REDESIGN.md` to remove the stale `--ask-for-approval` exec
  assumption and record the decision: Phase A uses `exec --json`; real mid-run approval
  remains gated on a proven protocol request/response path.

### EB-OBS-030 Deterministic approval policy and backend API

Status: completed
Dependencies: EB-OBS-000  
Acceptance criteria:

- Policy default mode is `auto`.
- Reads allow by default.
- Writes, network, execute, and delete ask by default.
- Protected paths always ask.
- Deny rules beat allow rules.
- Circuit breaker falls back to ask.
- `allow_always` and `reject_always` persist rules to `~/.vivary-gui/policy.json`.
- Session approval endpoint returns deterministic metadata and emits updated
  `approval_request` events.

Test plan before edits:

- `app\backend\.venv\Scripts\python.exe -m pytest -q app\backend\vivary_gui\tests\test_approval_policy.py`
- `app\backend\.venv\Scripts\python.exe -m pytest -q app\backend\vivary_gui\tests`

Evidence:

- Hardened approval classification to inspect the inner command of PowerShell wrappers.
- Protected path detection now treats any dotfile/dot-directory segment as protected,
  including `.env.local`, `.github/*`, and nested dotfiles.
- Rule matching now normalizes whitespace and ignores empty patterns.
- Policy save creates the policy parent directory when needed.
- `allow_always` / `reject_always` manager decisions persist only non-empty rule patterns.
- Added manager-level approval test proving persisted rule metadata and emitted
  `approval_request` status updates.
- Verification:
  - Approval tests: 10 passed.
  - Backend GUI tests: 30 passed, 1 warning.
  - `git diff --check`: passed.

### EB-OBS-040 Reducer-driven chat UI receipts and density control

Status: completed
Dependencies: EB-OBS-000  
Acceptance criteria:

- Legacy `text` answer rendering remains Markdown-preserving.
- Structured events render as collapsed receipts by default.
- Reasoning preserves trace and supports expansion/pinning.
- Tool output is hidden until expanded in balanced/compact density.
- File-change and plan receipts render.
- Approval card exposes Allow once, Allow always, and Deny.
- Compact density consolidates repeated completed read receipts.

Test plan before edits:

- `npm run test`
- `npm run lint`
- `npm run build`

Evidence:

- Added reducer coverage proving `approval_request` status updates preserve the original
  approval action kind, risk, and command context.
- Added receipt coverage proving ApprovalCard sends scoped `allow_always` decisions and
  deny steering text.
- Added test cleanup between React receipt tests to avoid stale approval cards leaking
  across DOM assertions.
- Applied the existing cross-worktree lint hygiene fix in `GraphPanel.tsx` and
  `StatePanel.tsx` by removing synchronous state resets from effects. The hunks match
  the dirty coordination and Meso worktrees exactly, so this is compatibility cleanup
  rather than divergent feature work.
- Verification:
  - `npm run test` -> 2 files passed, 11 tests passed.
  - `npm run lint` -> passed.
  - `npm run build` -> passed.
  - `git diff --check` -> passed.

### EB-OBS-050 Test harness and GUI CI job

Status: completed
Dependencies: EB-OBS-000  
Acceptance criteria:

- Backend parser/policy tests are in GUI CI.
- Frontend unit tests are in GUI CI.
- Frontend lint/build are in GUI CI.
- Playwright fixture E2E is in GUI CI.
- Fixture runtime is available only under `VIVARY_GUI_ENABLE_FIXTURE_RUNTIME=1`.
- Ignored E2E output folders are in `.gitignore`.

Test plan before edits:

- `npm run e2e`
- `npm audit`
- `git diff --check`
- Review `.github/workflows/ci.yml`

Evidence:

- Worktree audit found Meso dirty/untracked files overlapping several harness paths
  (`.gitignore`, frontend package files, Playwright config, E2E scripts, and test
  setup). This story was kept verification-only; no tracked harness source was edited.
- Reviewed `.github/workflows/ci.yml`: GUI job installs backend dev extras, runs
  backend tests, frontend tests, lint, build, installs Chromium, and runs fixture E2E.
- Reviewed fixture runtime gating: `FixtureRuntime` is appended only when
  `VIVARY_GUI_ENABLE_FIXTURE_RUNTIME=1`, and the Playwright web server sets that env
  only for E2E.
- Added an ignored local junction `app/backend/.venv` pointing to the coordination
  venv so the worktree-local E2E backend launcher uses the verified backend
  environment without a dependency install.
- Verification:
  - `npm run e2e` -> 1 passed. Playwright emitted a nonfatal Vite WebSocket proxy
    `ECONNABORTED` during shutdown after the test passed.
  - `npm audit` -> 0 vulnerabilities.
  - `git diff --check` -> passed.

### EB-OBS-060 Canonical live spec update

Status: pending  
Dependencies: EB-OBS-010, EB-OBS-020, EB-OBS-030, EB-OBS-040, EB-OBS-050  
Acceptance criteria:

- `OBSERVABILITY-REDESIGN.md` no longer says “Nothing here is implemented yet.”
- Spec reflects implemented source truth and verification truth.
- Known limitations are explicit.
- Protocol spike decision evidence is included.
- Human testing gate is documented.

Test plan before edits:

- `git diff --check`
- Manual stale-claim review against live files.

Evidence:

- Pending.

### EB-OBS-070 Thermonuclear review, P0/P1 fixes, and human test handoff

Status: pending  
Dependencies: EB-OBS-060  
Acceptance criteria:

- Review covers parser correctness, approval policy bypass risks, protected paths,
  fixture runtime gating, WebSocket/token security, UI answer-first behavior, CI
  portability, dependency/audit state, and stale docs.
- P0/P1 findings are fixed or explicitly blocked with evidence.
- P2 findings are recorded.
- Full verification matrix is rerun.
- Final state is `human_test_pending`.
- Handoff includes branch, worktree, dirty state, checks, blockers, URL, and manual
  test script.

Test plan before edits:

- Full verification matrix.

Evidence:

- Pending.

## Last Verified Matrix

See baseline table above. Future ticks must append newer evidence here instead of
deleting old evidence.

- 2026-06-16 EB-OBS-010:
  - Parser tests: 6 passed.
  - Backend GUI tests: 26 passed, 1 warning.
  - `git diff --check`: passed.
- 2026-06-16 EB-OBS-020:
  - `codex --version`: `codex-cli 0.139.0`.
  - `codex exec/app-server/exec-server/remote-control/mcp-server --help`: passed.
  - `git diff --check`: passed.
- 2026-06-16 EB-OBS-030:
  - Approval policy tests: 10 passed.
  - Backend GUI tests: 30 passed, 1 warning.
  - `git diff --check`: passed.
- 2026-06-16 EB-OBS-040:
  - Frontend tests: 2 files passed, 11 tests passed.
  - Frontend lint: passed.
  - Frontend build: passed.
  - `git diff --check`: passed.
- 2026-06-16 EB-OBS-050:
  - Playwright fixture E2E: 1 passed.
  - `npm audit`: 0 vulnerabilities.
  - `git diff --check`: passed.

## Handoff / Status For Other Agents

- Current phase: EB-OBS-050 complete; next open story is EB-OBS-060 canonical live spec update.
- Coordination setup is complete; observability implementation is owned by
  `C:\Users\jeffk\dev\vivary-GUI-obs-loop`.
- Do not edit observability paths from the coordination tree.
- `.claude/settings.local.json` and `MESO-CANVAS-PLAN.md` are explicitly out of scope.
- The Meso worktree and Meso files are out of scope for this epic.

## Blockers

- None yet.
