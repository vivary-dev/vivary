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
| EB-WC-020 | Runtime-mode files TBD after frontend overlap clears |
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

Status: pending  
Dependencies: frontend overlap cleared or coordinated.

Notes:
- The current Codex runtime uses `--sandbox read-only`, so failed file writes are
  expected behavior.
- The next contract should expose `read-only` versus `workspace-write` as an
  explicit user-visible runtime mode and route write/execute actions through the
  deterministic approval policy before claiming the agent can write.

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
