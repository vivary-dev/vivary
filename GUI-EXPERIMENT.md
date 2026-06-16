# Vivary GUI — experiment plan

> Experimental work on branch `feat/gui` in this clone (`vivary-GUI`). The canonical
> prod repo is the separate `vivary` clone, kept on `dev`. This experiment may or may
> not reach prod; if it does, it merges back into `vivary-dev/vivary`. Nothing here is
> pushed without an explicit per-item gate.

## Context

Vivary is a standard + scaffolder for agent-native workspaces, built from zero-dependency
Python CLIs (`tropo`, `strato`, `ozone`, `exo`, `create-vivary`) over plain Markdown+YAML.
Today a workspace is driven entirely from a terminal/editor, and its long-term memory is
**flat files** — `MEMORY.md` (index) + `memory/*.md` (one fact per file) +
`bug-risk-playbook.md`, distilled by strato's heartbeat. There is no search and no fast
retrieval over that memory.

We want two things, which converge on **search**:

1. **A standalone local web app** (omnigent-style) to manage Vivary workspaces — switch
   between projects, run and monitor multiple agents, browse files/state, view the graph,
   and approve gates.
2. **Better long-term memory** — a searchable index over the plain-file memory so both the
   UI and agents can retrieve fast.

## Locked decisions

- **GUI is a standalone web app, separate from Obsidian.** Obsidian remains Jeff's own
  tool over the same files; it is *not* part of the product. Stack: **Python FastAPI**
  backend (a thin window onto the existing Vivary CLIs) + a **React/Vite/TS** frontend,
  served at localhost. Clean REST+WS boundary so it could be Tauri-wrapped later.
- **Long-term memory = a searchable file index, first-class (no longer deferred).** A
  rebuildable **SQLite FTS5** index over a workspace's markdown. **Plain files stay the
  source of truth** — the DB is a throwaway cache that can be deleted and rebuilt
  (preserves Vivary's no-lock-in law). Semantic/embedding recall can layer on later.
- **Memory-first sequencing.** Build the search/data layer + app shell before agent
  orchestration — it's the lowest-risk, highest-standalone-value piece, and its `/search`
  API becomes the spine that agent context-retrieval later plugs into.
- **Location:** all GUI code under a new top-level **`app/`** on `feat/gui`, never inside
  the published `packages/*` (keeps shipped modules minimal).
- **Backend = one service, two jobs:** (1) memory/search index + retrieval API; (2) agent
  orchestration. The web app consumes both over REST/WS.
- **Execution isolation = a convention in core, an implementation in the app.** Vivary
  core gains nothing heavy — it leans on strato's existing `installs`/`destructive` gates
  plus an optional one-field **execution policy** the agent reads. The actual sandboxing
  lives only in the optional app, behind a `SandboxProvider` seam. **Default `local` +
  git worktree; Docker/Daytona are opt-in per workspace and NOT built until a project
  needs them.** (Matches Jeff's repealed dev-container law: host execution + mandatory
  dependency vetting is the baseline; containers/cloud are optional, never mandated.)

## Architecture

```
app/
  backend/   FastAPI service
    vivary_gui/
      bridge/      the ONLY code that knows Vivary internals (import tropo/ozone/exo/
                   create-vivary in-process; subprocess only for tropo view / init)
      index/       FTS5 indexer + search service over workspace markdown (rebuildable)
      services/    workspace registry, fs (sandboxed), agents (later), gates (later),
                   sandbox/ (SandboxProvider: local+worktree default; docker/daytona later)
      routers/     workspaces, search, files, state, graph, sessions, ws
  frontend/  Vite + React + TS (scaffolded via `npm create vite`, NOT hand-authored)
    src/views/  WorkspaceSwitcher, Search, FileViewer, StateSurface, (later) Dashboard/Chat/Gates
```

**Rule:** `bridge/` quarantines all Vivary-internal access; if a CLI changes, only the
bridge moves. **Reuse the engines, don't reimplement** them.

## Execution & isolation (minimal-bloat design)

Two layers that must never merge:

1. **Core *instructs* (cheap, always-on).** No new runtime. Reuse strato's existing hard
   gates (`installs`, `destructive ops` already require one human approval each), plus an
   *optional* declared **execution policy** in the workspace's existing config:
   ```toml
   # tropo.toml (or a one-liner in STATE.md/AGENTS.md) — all optional, defaults below
   [execution]
   mode = "local"        # local | container | cloud
   isolation = "worktree"  # none | worktree | docker | daytona
   ```
   This is intent the agent/runner reads and honors — instruction, not implementation.
   Someone using Vivary bare sees nothing new beyond the gates they already have.

2. **The app *implements* (heavy, opt-in).** A `SandboxProvider` interface
   (`create → exec → stream → teardown`) in `app/backend/.../services/sandbox/`:
   - **`local` (default, BUILT):** subprocess constrained to a per-agent **git worktree**
     — the cheap content-isolation primitive; concurrent agents on one repo don't clobber.
   - **`docker` (opt-in, NOT built yet):** uses the *project's own* devcontainer/Dockerfile
     if present — Vivary ships no container runtime. Tied per-workspace, never global.
   - **`daytona`/`cloud` (opt-in, NOT built yet):** the team-scale driver behind the same
     interface; switch the default to it only when >1 concurrent agent/person, reproducible
     team envs, or untrusted-code containment justify the cost.

   All bloat stays quarantined in the optional app; the seam exists from day one so adding
   a provider later touches one folder.

## Phased slices (each ends runnable + verifiable)

- **Phase 0 — shell.** FastAPI `/api/health` + token-guarded routes (127.0.0.1 only);
  Vite/React frontend that pings it. *Verify:* health ok, frontend builds, diff is
  `app/`-only.
- **Slice 1 — searchable workspace (the memory-first core).** Backend: workspace registry
  (`~/.vivary-gui/registry.json`) + FTS5 indexer over `MEMORY.md`/`memory/*`/playbook/
  `STATE.md`/docs + `/search` (ranked hits + snippets) + reindex. Frontend: pick a
  workspace → search box → results with snippets → click to open the file. *Verify:*
  index a scaffolded workspace, query a known term, get the right file + snippet; delete
  + rebuild the DB and results are identical (files are truth).
- **Slice 2 — files + state + graph.** Sandboxed file tree/viewer; render the strato state
  surface (STATE/SOUL/MEMORY, exo board, ozone findings); embed `tropo view` HTML for the
  graph; blast/impact panels. *Verify:* browse + open files (PRIV flagged), state renders,
  graph node click → blast radius.
- **Slice 3 — single streamed agent (via the `local` SandboxProvider).** Run one agent
  (Claude Code `--output-format stream-json`, Codex `codex exec`) against the selected
  workspace through the `SandboxProvider` seam — `local` driver = subprocess in a per-agent
  git worktree. Live chat; cancel kills the process. Agents can call `/search` for context.
  *Verify:* one live session streams; cancel leaves no orphan; the worktree isolates writes.
- **Slice 4 — multi-agent + gates.** Concurrent sessions across workspaces; Dashboard grid;
  gates surface (`gates/*.md` + runtime approval prompts) mapped onto Vivary's hard gates;
  `exo conflicts`. *Verify:* 2+ concurrent sessions update live; an approval blocks until
  granted.
- **Slice 5+ — terminal, semantic recall, polish.** Optional PTY terminal (vet pywinpty
  for the local Python first); optional embedding/semantic search on top of FTS5; spend/turn
  caps; Tauri-readiness check.

## Reuse, don't reimplement

| Need | Reuse |
|---|---|
| Graph data / visual | `tropo graph --json` + `analyze`/`build_graph`; `tropo view --out` HTML |
| Blast radius / impact | `tropo blast`, `ozone impact` |
| Workspace health / "is this a workspace" | `create_vivary.doctor_workspace()`, `REQUIRED_WORKSPACE_FILES` |
| Review / gate findings | `ozone review` (`--strict` = gate) |
| Board / roles / conflicts | `exo board/roles/conflicts` |
| Memory + gate file shapes | strato templates + `tropo.toml` `gate` type |

The full-text index is genuinely new (Vivary has no search today); everything else is a
window onto existing engines.

## Dependencies to vet (confined to `app/`)

Per `CLAUDE.md` + repo `AGENTS.md`: check `deny-list-npm.json` and run `npm`/`pip audit`,
prefer pinned pre-compromise versions, **before any install**.
- Python: `fastapi`, `uvicorn[standard]`. `sqlite3`/**FTS5 is stdlib** — confirm the local
  CPython build includes the FTS5 extension. Later: `pywinpty` (compiled — confirm a wheel
  for the local Python), an embedding lib (semantic phase only).
- Node: scaffolded by `npm create vite` (React + Vite + TS); later `@xterm/xterm`.
- External runtimes (detect via `shutil.which`, surface "not found" cleanly, NOT
  pip/npm deps): Claude Code (`claude`), Codex (`codex`).

## Security (localhost FS + process spawning)

127.0.0.1 bind + per-launch token (`~/.vivary-gui/runtime.json`) + tight CORS. `fs` resolves
real paths under the workspace root, rejecting `..`/symlink escapes. PRIV files
(`USER.md`/`MEMORY.md`/`memory/*`) read on request only, flagged, **never auto-indexed
without consent** (indexing is itself a strato gate — confirm before indexing private
memory). Agent spawning uses an allowlist + args-as-list (never `shell=True`).

## Out of scope (for now)

Merging/pushing this branch (a hard gate); semantic/embedding recall (after FTS5 proves out);
typed-graph memory in tropo; the Tauri native shell (boundary kept clean, shell not built);
custom-YAML agents; cross-device sync. **Container (`docker`) and cloud (`daytona`) sandbox
providers are designed-for but NOT built** — only the `local` + git-worktree provider ships
until a project actually needs isolation beyond local; `local` + mandatory dependency vetting
is the default (per the repealed dev-container law).

## Verify (overall)

- Backend tests in `app/backend/.../tests/`: search returns expected hits; DB rebuild is
  idempotent; fs sandbox rejects escapes; bridge JSON matches real CLI output against a
  scaffolded `sandboxes/gui-demo`.
- No `packages/*` regression: `tropo` (46/46), `ozone` (7/7), `exo` (4/4),
  `create-vivary` (8/8 + parity 2/2) still green.
- Manual per-slice as listed above.
