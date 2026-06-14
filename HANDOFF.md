# Vivary — fresh-chat handoff

_Updated 2026-06-14._

This is the starting point for a fresh chat. Read this first, then
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), then inspect live git state before
editing.

## Fresh Chat Opener

Use this prompt in a new window:

```text
We are in C:\Users\jeffk\dev\vivary. Read HANDOFF.md and docs/ARCHITECTURE.md.
Verify git status/branch/remotes before making claims. All four layers are built
and merged to `dev`; continue from `dev` with a branch per change. Tests must be
planned before edits. Do not push, open PRs, merge, publish, create orgs/repos,
install dependencies, or delete files without explicit approval.
```

## Current Truth

Vivary is a **standard + scaffolder for agent-native workspaces**: the
`create-t3-app` of agent workspaces.

The baseline thesis:

> A self-improving loop running over a typed, navigable knowledge graph, with one
> visible state surface and human gates.

Layer model:

```text
exo      multi-agent orchestration                 optional
ozone    review/gates: code + editorial            optional
strato   agent OS: state, memory, loop, gates       baseline
tropo    typed knowledge graph: what is true        baseline
```

Design law: **minimalism**. Always-on context must be tiny. Expensive-to-load
framework files are wrong.

## Live Repo State

Repo path:

```powershell
C:\Users\jeffk\dev\vivary
```

GitHub:

```text
https://github.com/Jeff-Kazzee/vivary
default branch: dev
visibility: public
```

Current local branch: `dev` (no active feature branch between phases).

All four-layer + packaging work is merged to `dev` via PRs **#3–#8**:
A (create-vivary baseline) · B (opinionated `tropo check`) · C (ozone) · D (exo) ·
E1+E2 (packaging: all packages installable + npm wrapper). Feature branches were
deleted after merge; only `dev` + `main` remain. `main` is the vestigial
tropo+strato baseline (untouched). No `prod` branch yet; `prod` is reserved for the
post-publish v1 cut. **Nothing is published to PyPI/npm yet.** Verify live state
(`git status --short --branch`, `gh pr list`) before acting.

## What Exists

All four layers are working, tested packages. Every package is pip-installable
(dist names `vivary-tropo` / `vivary-ozone` / `vivary-exo` / `create-vivary`; CLI
commands unchanged) and was proven in a clean venv.

```text
packages/tropo/        vivary-tropo   — knowledge-graph CLI (check/signal/types/stats/
                       graph/blast/view/plan/fix/init). check is STRICT by default
                       (--lenient / [base] strict to relax). Tests: 46/46.
packages/strato/       (vivary-strato source) — agent OS: STRATO.md model + templates
                       + bootstrap/heartbeat/self-improve skill. Docs/templates only.
packages/ozone/        vivary-ozone   — review layer: `review` (structure pack) +
                       `impact <id>` (blast radius) + `packs`. Tests: 7/7.
packages/exo/          vivary-exo     — coordination layer: `conflicts` + `board` +
                       `roles`. Read-only, graph-native. Tests: 4/4.
packages/create-vivary/ create-vivary — scaffolder: init --preset coding|second-brain|
                       writing, doctor. Bundles strato/loops assets for installed use
                       (tools/sync_assets.py + parity test). npm wrapper in npm/.
                       Tests: 8/8 + parity 2/2.

.github/workflows/ci.yml  CI contract (billing-locked; verify locally).
```

## Decisions Already Made

- **Vivary is the product**, not just a code name. It is a standard plus a
  scaffolder for agent-native workspaces.
- **Baseline is tropo + strato.** Ozone and exo are optional layers.
- **strato is one package**, not separate throughline/flywheel packages. The model is
  one loop at two speeds: per-turn and heartbeat.
- **tropo owns the typed graph**, but not embeddings. Graphify can consume tropo's
  clean graph later. Do not put semantic/embedding machinery into tropo.
- **create-vivary is the product spine right now.** The current highest-leverage
  work is making a new workspace useful from a cold start.
- **Presets share the same agent OS shell** and seed different starter graphs:

| Preset | Module | First slice | Verification |
|---|---|---|---|
| `coding` | `codebase` | `local-ci-baseline` | `local-checks` |
| `second-brain` | `knowledge-base` | `capture-routine` | `retrieval-smoke` |
| `writing` | `manuscript-system` | `draft-review-loop` | `editorial-review` |

- **doctor is part of the scaffold contract.** It validates required workspace
  files, privacy ignores, and tropo graph health.
- **No nested git repos.** Vivary packages are plain subdirectories.
- **Branch policy:** active development on `dev`, feature branches off `dev`, PR
  and checks before merge, `prod` only after MVP is solid.
- **Publishing and outward actions are gated** per item: push, PR, merge, npm/PyPI,
  GitHub org/repo actions, installs, hooks, destructive ops.

## Source Repo Boundary

The four source repos are read-only. Copy ideas/content into Vivary; do not modify
the source repos from this workspace.

| Repo | Role | Vivary layer |
|---|---|---|
| `braincheck` | frontmatter typechecker ancestor | retired ancestor of tropo |
| `loam` | folder-as-type typed knowledge graph | `@vivary/tropo` |
| `throughline` | tiny agent OS, visible state, gates | `@vivary/strato` |
| `flywheel` | bootstrap, heartbeat, self-improvement | `@vivary/strato` |

## Verification Commands

Run these before claiming a branch is healthy:

```powershell
python packages\tropo\tests\test_tropo.py              # 46/46
python packages\create-vivary\tests\test_create_vivary.py   # 8/8
python packages\create-vivary\tests\test_assets_parity.py   # 2/2
python packages\ozone\tests\test_ozone.py              # 7/7
python packages\exo\tests\test_exo.py                  # 4/4
git diff --check
```

Smoke a generated workspace:

```powershell
python packages\create-vivary\create_vivary.py init sandboxes\coding-demo --preset coding --force
python packages\create-vivary\create_vivary.py doctor sandboxes\coding-demo
python packages\tropo\tropo.py check --root sandboxes\coding-demo
python packages\tropo\tropo.py graph --root sandboxes\coding-demo --json
```

Expected current smoke result for `coding-demo`:

```text
doctor: ok
8 nodes
24 edges
0 broken
```

## Open Decisions

1. **PR/merge process.** _Settled:_ branch per change off `dev`, written
   plan+alignment, explicit approval, then PR + merge. CI is billing-locked → local
   green is the real gate. (Phases A–E followed this; PRs #3–#8.)
2. **Publishing scope.** _Decided:_ publish to **both PyPI and npm + a GitHub org**.
   Names verified available: `vivary`, `create-vivary`, `@vivary` (npm); `vivary`,
   `vivary-tropo/-strato/-ozone/-exo`, `create-vivary` (PyPI; bare `tropo/ozone/exo`
   are taken). Still open: scoped (`@vivary/*`) vs unscoped names; publish all four
   `vivary-*` or just the user-facing `create-vivary` + `vivary-tropo` first.
3. **Publish prerequisites (yours).** PyPI + npm tokens configured locally; the
   GitHub org created via web; the `ecc-tools` bot app uninstalled (it re-opens spam
   PRs on every push).
4. **Config filename.** _Resolved 2026-06-14:_ keep per-module `tropo.toml`; no
   workspace-level `vivary.toml` unification. (Settled — do not re-litigate.)
5. **GitHub org/namespace.** Repo lives under `Jeff-Kazzee/vivary`. `github.com/vivary`
   is a dead login → recommended handle **`vivary-dev`** (pending Jeff's choice). Org
   creation is a hard gate and is web-only (the API can't create a user org).
6. **Preset depth.** _Resolved 2026-06-14:_ presets differ by starter graph only and
   stay graph-only (no extra folder/workflow scaffolding) — honors the minimalism law.

**Branch roles (2026-06-14):** `dev` is the GitHub default and the integration
branch; feature branches cut from `dev`. `main` is the vestigial tropo+strato
baseline (left untouched). `prod` is reserved for the eventual MVP-solid cut.

## Remaining Work

The four-layer build + packaging is **done**. What's left is publishing and the v1
cut. (Note: the original type-inference ladder was dropped in favour of making
`tropo check` opinionated — folder-as-type stays the single source of truth.)

### E3 — Prerequisites (Jeff)

- Uninstall the `ecc-tools` bot (github.com/settings/installations).
- Create the GitHub org (web; handle `vivary-dev`?).
- Configure PyPI + npm tokens locally.

### E4 — Publish (each a per-item hard gate)

`twine upload` `vivary-tropo` / `vivary-ozone` / `vivary-exo` / `create-vivary` to
PyPI (start `0.1.0`); `npm publish` `create-vivary`. Build with `python -m build`,
check with `twine check`; everything already passes locally and installs in a clean
venv.

### F2 — prod cut + v1

Move the `loops` skill into strato (with the create-vivary `_source_paths` +
`sync_assets` follow-through); cut `prod` from `dev`; tag `v1.0.0`. After publish.

## Known Risks

- **GitHub Actions billing lock:** workflows may be present but not run. Local
  verification is required.
- **Windows temp dirs:** default Python temp locations can fail in this sandbox. Tests
  intentionally use repo-local `sandboxes/` temp roots.
- **Git HTTPS on this machine:** normal Git credential/TLS paths may fail. Previous
  pushes used `gh auth token` with an in-memory Basic auth header and OpenSSL backend.
- **Handoff drift:** old notes may say `strato` or graph layer are stubs. Current truth
  is in this file plus live git state.
- **Scope creep:** avoid building a heavy harness. The product is useful because the
  always-on load is small.

## Commands For GitHub State

```powershell
git status --short --branch
git log --oneline --decorate -n 8
git remote -v
gh pr list --state all --limit 10
gh repo view Jeff-Kazzee/vivary --json nameWithOwner,url,defaultBranchRef,isEmpty,visibility
```

## Hard Gates To Remember

- Do not push without approval.
- Do not open a PR without approval.
- Do not merge without written plan+alignment and approval.
- Do not publish npm/PyPI without approval.
- Do not create GitHub orgs/repos without approval.
- Do not delete/force-push/rewrite history without approval.
- Do not modify the four source repos.
