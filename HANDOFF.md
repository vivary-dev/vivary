# Vivary — fresh-chat handoff

_Updated 2026-06-14._

This is the starting point for a fresh chat. Read this first, then
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), then inspect live git state before
editing.

## Fresh Chat Opener

Use this prompt in a new window:

```text
We are in C:\Users\jeffk\dev\vivary. Read HANDOFF.md and docs/ARCHITECTURE.md.
Verify git status/branch/remotes before making claims. Continue building Vivary
from the current feature branch unless I say otherwise. Tests must be planned
before edits. Do not push, open PRs, merge, publish, create orgs/repos, install
dependencies, or delete files without explicit approval.
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

Current local branch:

```text
feat/create-vivary-workspace-scaffold
```

Current pushed feature branch tip before this handoff edit:

```text
eda3d85 ci: add workflow and scaffold doctor
```

Remote branch state at the time this handoff was written:

```text
origin/feat/create-vivary-workspace-scaffold -> eda3d85
origin/dev -> a5d4283
```

If this handoff has been committed locally but not pushed, `git status --short --branch`
will show the feature branch ahead of origin. Verify live state before pushing.

No PR has been opened. Nothing has been merged into `dev` from this feature
branch yet. No `prod` branch has been created; `prod` is reserved for finished
product/MVP-solid.

## What Exists

```text
packages/tropo/
  Working zero-dependency Python knowledge-graph CLI.
  Commands include check, signal, fix, init, graph, blast, view, plan.
  Tests: 42/42 passing locally.

packages/strato/
  Working agent OS model, templates, and strato skill.
  Fuses throughline + flywheel into one package.

packages/create-vivary/
  Working local scaffold CLI.
  Commands:
    init <dir> --preset coding|second-brain|writing
    doctor <dir> [--json]
  Tests: 8/8 passing locally.

packages/ozone/
  Stub. Intended review layer: code + editorial, graph-aware.

packages/exo/
  Stub. Intended multi-agent orchestration layer.

.github/workflows/ci.yml
  CI contract exists. It runs create-vivary tests, tropo tests, and git diff --check.
  GitHub Actions may still be billing-locked on this account; verify locally.
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

Run these before claiming the feature branch is healthy:

```powershell
python packages\create-vivary\tests\test_create_vivary.py
python packages\tropo\tests\test_tropo.py
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

1. **PR timing.** Open a PR from `feat/create-vivary-workspace-scaffold` to `dev`
   after Jeff approves. CI may not run due to billing lock, so local verification is
   the real gate.
2. **Merge timing.** Do not merge without written plan+alignment and explicit Jeff
   approval. If the PR diverges from the plan, re-align before merging.
3. **Package naming/publishing.** Local package is `packages/create-vivary`, but npm
   name availability has not been verified and nothing is published.
4. **Config filename.** _Resolved 2026-06-14:_ keep per-module `tropo.toml`; no
   workspace-level `vivary.toml` unification. (Settled — do not re-litigate.)
5. **GitHub org/namespace.** Current repo lives under `Jeff-Kazzee/vivary`. A future
   org handle is still undecided. Do not create one without approval.
6. **Preset depth.** _Resolved 2026-06-14:_ presets differ by starter graph only and
   stay graph-only (no extra folder/workflow scaffolding) — honors the minimalism law.

**Branch roles (2026-06-14):** `dev` is the GitHub default and the integration
branch; feature branches cut from `dev`. `main` is the vestigial tropo+strato
baseline (left untouched). `prod` is reserved for the eventual MVP-solid cut.

## Recommended Next Build Sequence

Do not spend the next session only polishing docs. Build forward in small verified
slices.

### Slice 1 — Dogfood All Presets

Goal: prove every preset produces a useful workspace, not just a passing test.

Tasks:

- Generate `sandboxes/coding-demo`, `sandboxes/second-brain-demo`, and
  `sandboxes/writing-demo`.
- Run `create-vivary doctor`, `tropo check`, `tropo graph --json`, and `tropo view`
  for each.
- Inspect the starter graphs and tighten names/edges if they feel generic or noisy.
- Add tests if any repeated expectation emerges.

Verification:

```powershell
python packages\create-vivary\tests\test_create_vivary.py
python packages\tropo\tests\test_tropo.py
git diff --check
```

### Slice 2 — PR Readiness

Goal: prepare the scaffold branch for review/merge into `dev`.

Tasks:

- Produce the required merge plan: intent, blast radius, verification, out of scope,
  alignment.
- If Jeff approves, open the PR.
- Treat remote CI as informational if billing-locked; rely on local checks.

Gate: opening the PR requires explicit approval.

### Slice 3 — Tropo Type-Inference Ladder

Goal: make tropo less folder-only while preserving minimalism.

Resolution ladder to implement:

```text
explicit frontmatter type
-> optional filename convention
-> folder-as-type default
```

Rules:

- Folder remains the zero-noise default.
- Redundant `type:` that simply repeats the folder-derived type should be warning
  noise, not required metadata.
- Keep the engine zero-dependency.

### Slice 4 — Ozone First Review Pack

Goal: turn the graph/blast radius into a review surface.

Start with one narrow pack:

- code-review pack over `modules/`, `changes/`, `verification/`, `gates/`
- findings-first output
- uses `tropo graph`/`blast`
- no LLM dependency in core

### Slice 5 — Packaging Strategy

Goal: decide how users will install/run Vivary.

Do not publish yet. First decide:

- Python package only first?
- npm wrapper for `create-vivary`?
- scoped packages under a future org?
- how `tropo` and `create-vivary` share versioning?

Publishing is a hard gate.

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
gh repo view Jeff-Kazzee/vivary --json nameWithOwner,url,defaultBranchRef,isEmpty,visibility
gh api repos/Jeff-Kazzee/vivary/branches/feat/create-vivary-workspace-scaffold
```

## Hard Gates To Remember

- Do not push without approval.
- Do not open a PR without approval.
- Do not merge without written plan+alignment and approval.
- Do not publish npm/PyPI without approval.
- Do not create GitHub orgs/repos without approval.
- Do not delete/force-push/rewrite history without approval.
- Do not modify the four source repos.
