# EBTASK Workspace Control Layer

Epic: Vivary GUI Workspace Control Layer
Status: in_progress
Branch: `feat/gui-observability-loop`
Worktree: `C:\Users\jeffk\dev\vivary-GUI-obs-loop`
Created: 2026-06-16

## Objective

Make the GUI control a real Vivary-shaped workspace instead of a loose demo
folder. The backend must be able to create a full `create-vivary` scaffold,
register it, run the normal workspace health probe, and index it.

The control layer has three separate responsibilities:
- **Bootstrap**: create/doctor/index a real Vivary workspace and expose the full
  Vivary CLI toolchain to every agent sandbox.
- **Operate**: let the agent interact with the sandbox through explicit read-only
  or workspace-write modes, with visible receipts and approval policy hooks.
- **Extend**: let the model author project-local tools inside the sandbox without
  installing global dependencies or mutating the host outside approved paths.

## Hard Gates

- No push, PR, merge, publish, destructive operation, dependency install, or
  force scaffold.
- Do not touch dirty sibling frontend/API paths while the Meso worktree owns
  them.
- Keep real agent write capability behind a separate, explicit runtime-mode
  story. Current Codex execution is read-only by design.

## File Ownership

| Story | Owned files |
| --- | --- |
| EB-WC-010 | `app/backend/vivary_gui/bridge/loader.py`, `app/backend/vivary_gui/routers/workspaces.py`, `app/backend/vivary_gui/tests/test_workspaces.py` |
| EB-WC-020 | `app/backend/vivary_gui/services/agents/base.py`, `app/backend/vivary_gui/services/agents/manager.py`, `app/backend/vivary_gui/routers/sessions.py`, `app/backend/vivary_gui/tests/test_codex_runtime.py`, `app/backend/vivary_gui/tests/test_agents.py` |
| EB-WC-030 | `app/backend/vivary_gui/services/agents/manager.py`, `app/backend/vivary_gui/tests/test_agents.py`, `todos/EBTASK-WORKSPACE-CONTROL.md` |
| EB-WC-040 | Proposed: tool manifest/discovery service, tests, docs; exact files TBD before edit |
| EB-WC-050 | Proposed: sandbox status/diff API, tests, docs; exact files TBD before edit |
| Coordination | `todos/EBTASK-WORKSPACE-CONTROL.md` |

## Stories

### EB-WC-010 Backend Vivary Workspace Scaffold API

Status: completed
Dependencies: `create_vivary.scaffold_workspace` and `doctor_workspace`

Acceptance criteria:
- `POST /api/workspaces/scaffold` creates a full Vivary workspace using
  `create-vivary` primitives.
- The endpoint refuses overwrite/force behavior by default.
- The endpoint registers the workspace, includes doctor health, and builds the
  search index.
- Invalid presets and scaffold conflicts return clean 400 responses.

Tests planned before edits:
- Add backend API tests that call the scaffold endpoint into a temp path.
- Assert generated workspace contains `tropo.toml`, `AGENTS.md`, and `STATE.md`.
- Assert returned health is ok and index count is nonzero.
- Assert a second scaffold call for the same path is rejected without overwrite.
- Run `app\backend\.venv\Scripts\python.exe -m pytest -q app\backend\vivary_gui\tests`.
- Run `git diff --check`.

Evidence:
- Implemented `loader.scaffold()` as a no-force bridge over
  `create_vivary.scaffold_workspace()`.
- Added `POST /api/workspaces/scaffold` to create, register, doctor, and index a
  Vivary workspace.
- Added backend tests for successful scaffold, overwrite refusal, and invalid
  preset rejection.
- 2026-06-16: `app\backend\.venv\Scripts\python.exe -m pytest -q app\backend\vivary_gui\tests`
  passed in the implementation worktree: `36 passed, 1 warning` (existing
  Starlette/httpx deprecation warning).
- 2026-06-16: `git diff --check` passed.

### EB-WC-020 Runtime Write Capability Contract

Status: completed
Dependencies: frontend overlap cleared or coordinated for UI controls.

Acceptance criteria:
- Session creation accepts an optional `tool_mode`.
- Default mode remains `read-only`.
- `workspace-write` maps to Codex `--sandbox workspace-write`.
- Unknown modes are rejected before a process is spawned.
- Session summaries expose the chosen mode so frontend state can render it later.

Tests planned before edits:
- Add Codex command tests for default `read-only`, explicit `workspace-write`,
  and invalid mode rejection.
- Add manager tests proving default and explicit session `tool_mode` storage.
- Add sessions API tests proving `POST /api/sessions` accepts and rejects
  `tool_mode` values correctly.
- Run `app\backend\.venv\Scripts\python.exe -m pytest -q app\backend\vivary_gui\tests`.
- Run `git diff --check`.

Notes:
- The current Codex runtime uses `--sandbox read-only`, so failed file writes are
  expected behavior.
- The next contract should expose `read-only` versus `workspace-write` as an
  explicit user-visible runtime mode and route write/execute actions through the
  deterministic approval policy before claiming the agent can write.

Evidence:
- Added validated `tool_mode` session creation with default `read-only`.
- Added `workspace-write` propagation from session manager to runtime command
  construction.
- Codex maps `workspace-write` to `codex exec --sandbox workspace-write`;
  other runtimes accept the mode contract but ignore it for now.
- Session summaries expose `tool_mode` for frontend rendering.
- Unknown modes are rejected before a session is registered.
- `POST /api/sessions` accepts explicit `tool_mode` and rejects unknown modes.
- 2026-06-16: `app\backend\.venv\Scripts\python.exe -m pytest -q app\backend\vivary_gui\tests`
  passed in the implementation worktree: `42 passed, 1 warning` (existing
  Starlette/httpx deprecation warning).
- 2026-06-16: `git diff --check` passed.

### EB-WC-030 Agent Sandbox Vivary Toolchain Environment

Status: completed
Dependencies: EB-WC-010, EB-WC-020

Acceptance criteria:
- Every spawned agent process receives an environment that exposes the backend
  Python environment and installed Vivary CLI modules to commands it runs inside
  the sandbox.
- The environment preserves the existing process `PATH` while prepending the
  current Python executable directory, so `python -m tropo`, `python -m ozone`,
  `python -m exo`, and `python -m create_vivary` resolve through the GUI's
  verified backend toolchain.
- The environment includes explicit sandbox metadata:
  `VIVARY_GUI_SESSION_ID`, `VIVARY_GUI_WORKSPACE_ID`,
  `VIVARY_GUI_SANDBOX_CWD`, `VIVARY_GUI_SANDBOX_ISOLATION`, and
  `VIVARY_GUI_TOOL_MODE`.
- This story does not run dependency installs. Missing toolchain pieces should
  become diagnosable evidence, not an automatic install.

Tests planned before edits:
- Add a manager test proving the agent environment prepends the active Python
  toolchain directory and preserves the old `PATH`.
- Add a manager test proving sandbox/session/tool-mode metadata is present.
- Add a backend test proving the environment's Python can import the Vivary CLI
  modules required by the GUI: `tropo`, `ozone`, `exo`, and `create_vivary`.
- Run `app\backend\.venv\Scripts\python.exe -m pytest -q app\backend\vivary_gui\tests`.
- Run `git diff --check`.

Evidence:
- Added `_agent_env()` in the session manager and pass it to spawned agent
  turns.
- The agent environment prepends the active backend Python executable directory
  while preserving the previous `PATH`.
- The agent environment includes session id, workspace id, sandbox cwd,
  isolation mode, and tool mode.
- Verified the environment's Python can import `tropo`, `ozone`, `exo`, and
  `create_vivary`.
- 2026-06-16: `app\backend\.venv\Scripts\python.exe -m pytest -q app\backend\vivary_gui\tests`
  passed in the implementation worktree: `45 passed, 1 warning` (existing
  Starlette/httpx deprecation warning).
- 2026-06-16: `git diff --check` passed.

### EB-WC-040 Model-Authored Project Tools

Status: pending
Dependencies: EB-WC-030, approval UI/frontend ownership clear.

Proposed contract:
- Project-local tools live under `.vivary/tools/<tool-id>/`.
- Each tool has a manifest `.vivary/tools/<tool-id>/tool.json`:
  `{ id, title, description, entrypoint, args_schema?, risk, created_by,
  created_at, version }`.
- Tool source files must stay inside that tool directory. No global installs,
  PATH writes, shell profile writes, or host-level mutation.
- Tools run only inside the session sandbox with the EB-WC-030 environment.
- Generated tools are discovered, hashed, and shown as receipts before first run.
- First run of a generated or modified tool requires approval. "Allow always"
  should bind to the tool hash plus project scope, not only the tool id.
- Tool output emits normal `tool` events with `meta.kind = "local_tool"` and
  includes command, cwd, exit code, stdout/stderr summary, and manifest hash.

Tests to plan before implementation:
- Manifest parser tests for valid/invalid tools and path traversal rejection.
- Discovery tests proving only `.vivary/tools/**/tool.json` is loaded.
- Execution tests proving tools run inside sandbox cwd with EB-WC-030 env.
- Policy tests proving modified tool hashes invalidate previous allow-always.

### EB-WC-050 Sandbox Interaction API

Status: pending
Dependencies: EB-WC-020, frontend ownership clear.

Proposed contract:
- Add a session sandbox status API:
  `GET /api/sessions/{sid}/sandbox` returns cwd, isolation mode, tool mode,
  dirty state, and available toolchain summary.
- Add a session sandbox diff API:
  `GET /api/sessions/{sid}/sandbox/diff` returns a normalized file-change list
  for git worktrees and a best-effort changed-file scan for non-git sandboxes.
- Add a controlled command endpoint only after approval UX is wired. Until then,
  command execution remains through the agent runtime, not arbitrary frontend
  shell buttons.
- Sandbox writes stay limited to `workspace-write` mode and must be visible as
  file-change receipts.

Tests to plan before implementation:
- Sandbox status tests for git worktree and in-place fallback.
- Diff tests for add/update/delete in git and non-git workspaces.
- Auth tests proving sandbox APIs keep the existing token guard.

## Handoff For Other Agents

- This ledger is used because `todos/EBTASK-OBSERVABILITY.md` is dirty in the
  coordination worktree.
- Do not edit frontend/API files for this epic while `C:\Users\jeffk\dev\vivary-GUI-meso`
  has dirty changes in `app/frontend/src/App.tsx`,
  `app/frontend/src/api/client.ts`, and related frontend test paths.

## Last Verified

- 2026-06-16: `git status --short --branch` in the implementation worktree was
  clean before EB-WC-010 started.
- 2026-06-16: sibling worktree audit found no dirty overlap for EB-WC-010 owned
  backend files. Frontend/API work remains deferred because the Meso worktree has
  overlapping dirty frontend paths.
