# Vivary — fresh-chat handoff

_Updated 2026-06-14._

This is the starting point for a fresh chat. Read this first, then
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), then inspect live git state before
editing.

## Fresh Chat Opener

Use this prompt in a new window:

```text
We are in C:\Users\jeffk\dev\vivary (repo: github.com/vivary-dev/vivary). Read
HANDOFF.md, docs/README.md, and docs/ARCHITECTURE.md. Verify git status/branch/
remotes before making claims. Vivary 0.1.0 is SHIPPED — all four layers are
published to PyPI + npm and merged to `dev`. Continue from `dev` with a branch per
change. Tests must be planned before edits. Do not push, open PRs, merge, publish,
create orgs/repos, install dependencies, or delete files without explicit approval.
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

**Shipped (0.1.0).** Anyone can install it:

```bash
npm create @vivary my-workspace                          # the scaffolder UX
pip install vivary-tropo vivary-ozone vivary-exo create-vivary
uvx vivary-tropo check                                   # run without installing
```

PyPI: `vivary-tropo` · `vivary-ozone` · `vivary-exo` · `create-vivary`. npm:
`@vivary/create`. Tagged **`v0.1.0`**. Website: **https://vivary.vercel.app/**. Full
docs in [docs/](docs/) (start at [docs/README.md](docs/README.md)); the site is
generated from `docs/` (`cd site && npm run sync-docs`).

**Package versions — read this before touching a version number.** The suite is the
`v0.1.0` line; **the only package past 0.1.0 is `create-vivary`, now at 0.1.1 on both
registries.** `create-vivary` ships as two entry points to the *same* scaffolder — the
PyPI package `create-vivary` and the npm launcher `@vivary/create` — and they are
**kept in lockstep** (same version, same behavior).

| Package | PyPI | npm | At |
|---|---|---|---|
| `vivary-tropo` | `vivary-tropo` | — | 0.1.0 |
| `vivary-ozone` | `vivary-ozone` | — | 0.1.0 |
| `vivary-exo`   | `vivary-exo`   | — | 0.1.0 |
| `create-vivary` | `create-vivary` | `@vivary/create` | **0.1.1** |

The **0.1.1** bump affects **only `create-vivary`** (both its PyPI package and its npm
launcher): a bare target now defaults to the `init` subcommand, so `create-vivary
<name>` and `npm create @vivary <name>` both work like `… init <name>`. `tropo` /
`ozone` / `exo` are **untouched at 0.1.0**. Per-release history lives in
[CHANGELOG.md](CHANGELOG.md).

## Live Repo State

Repo path:

```powershell
C:\Users\jeffk\dev\vivary
```

GitHub:

```text
https://github.com/vivary-dev/vivary
default branch: dev
visibility: public
```

Current local branch: `dev` (no active feature branch between phases).

Everything is merged to `dev` via PRs **#3–#14** (each its own plan + gate): the four
layers (A–D), packaging (E1+E2), doc reframe (F1), org transfer to `vivary-dev` +
URL update, the agentic-loop wiring, Obsidian-optional, and the comprehensive docs.
Feature branches are deleted after merge; only `dev` + `main` remain (`main` is the
vestigial tropo+strato baseline). **Published:** `vivary-tropo` / `vivary-ozone` /
`vivary-exo` at 0.1.0 (PyPI); **`create-vivary` at 0.1.1 on both PyPI and npm
(`@vivary/create`), in lockstep** — bare target defaults to `init` (see the version
table above). **No `prod` branch or release tag yet** — `v0.1.0` is the
next step (see Remaining Work). Ten roadmap issues are open: **#15–#24**. Verify live
state (`git status --short --branch`, `gh pr list`, `gh issue list`) before acting.

## What Exists

All four layers are working, tested, **published** packages (`tropo` / `ozone` /
`exo` at 0.1.0; `create-vivary` at 0.1.1 on PyPI + npm; CLI commands stay
`tropo`/`ozone`/`exo`/`create-vivary`), proven in a clean venv.

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

.github/workflows/ci.yml  CI: runs FREE (public repo) — all 4 suites + parity +
                       tropo check + `ozone review --strict` gate + site build,
                       on every PR/push. Passing.
docs/                  Full guides: README (index), GETTING-STARTED, COMMANDS,
                       HOWTO, SKILLS, FAQ, ARCHITECTURE, OBSIDIAN.
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
   plan+alignment, explicit approval, then PR + merge. **CI runs free on the public
   repo** (the old "billing-locked" note was a Jeff-Kazzee account artifact) and gates
   on the suites + `ozone review`; verify locally too.
2. **Publishing.** _Done 2026-06-14:_ published to **both PyPI and npm**. PyPI
   `vivary-tropo` / `vivary-ozone` / `vivary-exo` / `create-vivary`; npm scoped
   `@vivary/create` (CLI commands stay `tropo`/`ozone`/`exo`/`create-vivary`).
   `tropo`/`ozone`/`exo` at 0.1.0. **`create-vivary` at 0.1.1 on both registries**
   (_2026-06-14:_ a bare target defaults to `init` on both the Python CLI and the npm
   launcher — PR #33 shipped the npm side; the PyPI side is the parity follow-up). PyPI
   `create-vivary` and npm `@vivary/create` are versioned in lockstep.
3. **npm 2FA.** npm enforces 2FA on publish; the granular tokens tried did *not*
   bypass it, so `@vivary/create` was published by Jeff running `npm publish` with his
   passkey. For automation, set up **OIDC trusted publishing** (issue #15/#22) — it
   only runs once Actions billing is unlocked.
4. **Config filename.** _Resolved 2026-06-14:_ keep per-module `tropo.toml`; no
   workspace-level `vivary.toml` unification. (Settled — do not re-litigate.)
5. **GitHub org.** _Done:_ repo transferred to **`vivary-dev/vivary`**; in-repo URLs
   updated. (`github.com/vivary` is a dead login; npm scope is `@vivary`.)
6. **Preset depth.** _Resolved 2026-06-14:_ presets differ by starter graph only and
   stay graph-only (no extra folder/workflow scaffolding) — honors the minimalism law.

**Branch roles (enforced via branch protection):** `dev` is the GitHub default +
integration branch — **no direct pushes**; every change is a feature branch cut from
`dev` → PR → merge, with the `ci` checks + `ozone review` gate green first (force-push
and deletion blocked). `main` is the vestigial baseline; `prod` is reserved for a
release cut.

## Remaining Work

The four layers are built, packaged, **published (0.1.0)**, and documented. What's
left is the release marker and the next wave of value. The full roadmap is the open
issues **#15–#24**; the near-term:

- **Released.** `v0.1.0` is tagged + pushed; the site is live at vivary.vercel.app
  (Vercel, root dir `site`). Old `vivary-landing-page` repo archived. A GitHub Release
  is still optional (a publishing gate).
- **`create-vivary 0.1.1` (both registries).** npm `@vivary/create@0.1.1` shipped the
  launcher `init`-default fix (PR #33); the PyPI `create-vivary` parity bump (same
  `init`-default in the Python CLI) keeps the two in lockstep — **republish to PyPI is
  the only remaining manual step** (2FA, owner-run). A separate metadata-only bump for
  `tropo`/`ozone`/`exo` would make their pages show the site URL (0.1.0 metadata is
  frozen) — still optional.
- **Launch.** Launch copy (Twitter thread + GitHub release) and the website brief were
  drafted but kept private (not committed to the public repo). Posting is a per-item
  gate.
- **Worth-using dogfood (#24).** Stand up a Vivary `writing` workspace for the
  website and rewrite its copy through the loop, using the *published* CLIs; capture
  `docs/WALKTHROUGH.md`.
- **Release automation (#15/#22).** A `.github/workflows/release.yml` that publishes
  npm + PyPI via **OIDC trusted publishing** on a version tag — tokenless, but needs
  Actions billing unlocked to run.
- **Other roadmap (#16–#23):** ship tropo starter packs in the wheel · exo `claim`
  write · ozone LLM packs + a prose pack · graphify semantic layer · a multi-agent
  preset · move the `loops` skill into strato.

(The original type-inference ladder was dropped in favour of making `tropo check`
opinionated — folder-as-type stays the single source of truth.)

## Known Risks

- **CI:** runs free on the public repo and is the enforced gate (suites + `ozone
  review`). The old "billing lock" was a personal-account artifact, now moot. (For
  *publishing* automation, OIDC trusted publishing via Actions is viable — issues
  #15/#22.)
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
gh repo view vivary-dev/vivary --json nameWithOwner,url,defaultBranchRef,isEmpty,visibility
```

## Hard Gates To Remember

- Do not push without approval.
- Do not open a PR without approval.
- Do not merge without written plan+alignment and approval.
- Do not publish npm/PyPI without approval.
- Do not create GitHub orgs/repos without approval.
- Do not delete/force-push/rewrite history without approval.
- Do not modify the four source repos.
