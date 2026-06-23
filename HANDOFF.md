# Vivary — fresh-chat handoff

_Updated 2026-06-23._

This is the starting point for a fresh chat. Read this first, then
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), then inspect live git state before
editing.

## Fresh Chat Opener

Use this prompt in a new window:

```text
We are in C:\Users\jeffk\dev\vivary (repo: github.com/vivary-dev/vivary). Read
HANDOFF.md, docs/README.md, and docs/ARCHITECTURE.md. Verify git status/branch/
remotes before making claims. The current release line is create-vivary /
@vivary/create 0.2.3, vivary-tropo 0.2.2, vivary-exo 0.2.1, and vivary-ozone
0.1.0. The `dev` branch includes an Unreleased security-hardening batch; do not
claim it is published until the package cut happens. Continue from `dev` by cutting a
feature branch per change. Tests must be planned before edits. Do not push, open PRs,
merge, publish, create orgs/repos, install dependencies, or delete files without
explicit approval.
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

**Release target through 2026-06-23.** 0.2.0 shipped the tropo storage/search layer
and agent-mode scaffolder work. 0.2.3 is the clean npm/PyPI scaffolder line.
`vivary-tropo` 0.2.1 and `vivary-exo` 0.2.0 shipped embedded starter packs,
opt-in `coordination`, and `exo claim`. The 0.2.2 / 0.2.1 patch hardens UTF-8
BOM-prefixed config and frontmatter so Windows-created files remain valid claim targets.
The current `dev` line additionally contains an Unreleased security-hardening batch
for symlink/out-of-root scaffold writes, hard-link-safe `tropo view --out` and
`exo claim` rewrites, active privacy-ignore validation, and private heartbeat reports.

```bash
npm create @vivary my-workspace                          # the scaffolder UX
pip install vivary-tropo vivary-ozone vivary-exo create-vivary
uvx vivary-tropo check                                   # run without installing
```

PyPI: `vivary-tropo` · `vivary-ozone` · `vivary-exo` · `create-vivary`. npm:
`@vivary/create`. Website: **https://vivary.vercel.app/**. Full
docs in [docs/](docs/) (start at [docs/README.md](docs/README.md)); the site is
generated from `docs/` (`cd site && npm run sync-docs`).
Every behavior/package/public-copy update ends with
[docs/RELEASE-WORKFLOW.md](docs/RELEASE-WORKFLOW.md).

**Package versions — read this before touching a version number.**

| Package | PyPI | npm | Published | Branch |
|---|---|---|---|---|
| `vivary-tropo` | `vivary-tropo` | — | 0.2.2 | current |
| `vivary-ozone` | `vivary-ozone` | — | 0.1.0 | unchanged |
| `vivary-exo`   | `vivary-exo`   | — | 0.2.1 | current |
| `create-vivary` | `create-vivary` | `@vivary/create` | 0.2.3 | current |

The **0.2.0** bump affected `vivary-tropo` and `create-vivary` (both PyPI + npm for
create-vivary). It added: storage layer (`file`/`embedded`/`cloud`), `tropo query`,
`tropo migrate`, agent-mode init flags (`--auto` `--yes` `--json` `--dry-run`),
`create-vivary wizard`, and the interactive setup wizard. The **0.2.3** bump affects
`create-vivary` / `@vivary/create` only and pins the npm launcher to the matching PyPI
scaffolder. The **tropo 0.2.1 / exo 0.2.0** release added bundled pack
reliability and graph-native claims. The **tropo 0.2.2 / exo 0.2.1** patch hardens
Windows BOM config and frontmatter handling for `exo claim`. The next package cut must
carry the Unreleased security hardening from [CHANGELOG.md](CHANGELOG.md) before any
public release copy claims it is live.

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

Current integration branch: `dev`. Cut a feature branch before edits. `prod` is the
release branch. Verify live state (`git status --short
--branch`, `gh pr list`, `gh issue list`) before acting; older notes in this file may
lag active GitHub issues.

## What Exists

All four layers are working, tested packages (`tropo` 0.2.2, `exo` 0.2.1, `ozone`
0.1.0; `create-vivary` 0.2.3 on PyPI + npm; CLI commands stay
`tropo`/`ozone`/`exo`/`create-vivary`). The current tropo/exo patch was published
and verified from public PyPI plus fresh `pip` and `uvx` smokes on 2026-06-22.

```text
packages/tropo/        vivary-tropo 0.2.2 — knowledge-graph CLI (check/signal/types/
                       stats/graph/blast/view/plan/fix/init/query/migrate). check is
                       STRICT by default. Storage layer: file/embedded(LanceDB)/cloud.
                       Optional extras: [embedded] [cloud] [astra]. Built-in packs:
                       dev-project, repo-graph, coordination. BOM-prefixed config and
                       frontmatter are normalized before parsing. `view --out` is
                       hardened against symlink/out-of-root targets and hard-linked
                       outside files. Tests: 64/64.
packages/strato/       strato source/templates — agent OS: STRATO.md model + templates
                       + bootstrap/heartbeat/self-improve skill. Docs/templates only.
packages/ozone/        vivary-ozone 0.1.0 — review layer: `review` (structure pack) +
                       `impact <id>` (blast radius) + `packs`. Tests: 7/7.
packages/exo/          vivary-exo 0.2.1 — coordination layer: `conflicts` + `board` +
                       `claim` + `roles`. `claim` is the only writer and requires the
                       opt-in coordination pack; it rejects malformed BOM-prefixed
                       frontmatter, symlink/out-of-workspace work items, and hard-link
                       truncation. Tests: 14/14.
packages/create-vivary/ create-vivary 0.2.3 — scaffolder: init/wizard/doctor --preset
                       coding|second-brain|writing + agent flags (--auto/--yes/--json/
                       --dry-run/--storage/--provider/--size/--privacy). Bundles
                       strato/loops assets for installed use. npm wrapper in npm/.
                       Current dev hardening covers active privacy ignore validation,
                       private heartbeat reports, and symlink/out-of-root scaffold
                       writes. Tests: 44/44 + parity 3/3.

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
| `loam` | folder-as-type typed knowledge graph | `vivary-tropo` |
| `throughline` | tiny agent OS, visible state, gates | `strato` bundled templates |
| `flywheel` | bootstrap, heartbeat, self-improvement | `strato` bundled templates |

## Verification Commands

Run these before claiming a branch is healthy:

```powershell
python packages\tropo\tests\test_tropo.py              # 64/64
python packages\create-vivary\tests\test_create_vivary.py   # 44/44
python packages\create-vivary\tests\test_assets_parity.py   # 3/3
python packages\ozone\tests\test_ozone.py              # 7/7
python packages\exo\tests\test_exo.py                  # 14/14
git diff --check
```

Smoke a generated workspace:

```powershell
python packages\create-vivary\create_vivary.py init sandboxes\coding-demo --preset coding --force --no-wizard
python packages\create-vivary\create_vivary.py doctor sandboxes\coding-demo
python packages\tropo\tropo.py check --root sandboxes\coding-demo
python packages\tropo\tropo.py graph --root sandboxes\coding-demo --json

# Agent self-configure (new in 0.2.0):
python packages\create-vivary\create_vivary.py init sandboxes\agent-demo --auto --size large --yes --json
python packages\tropo\tropo.py migrate --from file --to embedded --root sandboxes\agent-demo --yes
python packages\tropo\tropo.py query "CI baseline" --root sandboxes\agent-demo --json
```

Expected smoke result for `coding-demo`:

```text
doctor: ok (9 node(s), 28 edge(s), 0 broken)
```

## Open Decisions

1. **PR/merge process.** _Settled:_ branch per change off `dev`, written
   plan+alignment, explicit approval, then PR + merge. **CI runs free on the public
   repo** (the old "billing-locked" note was a Jeff-Kazzee account artifact) and gates
   on the suites + `ozone review`; verify locally too.
2. **Publishing.** Published to **both PyPI and npm**. PyPI
   `vivary-tropo` / `vivary-ozone` / `vivary-exo` / `create-vivary`; npm scoped
   `@vivary/create` (CLI commands stay `tropo`/`ozone`/`exo`/`create-vivary`).
   Current versions are listed above; PyPI `create-vivary` and npm `@vivary/create`
   are versioned in lockstep.
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

The four layers are built and tested through the current versions listed above. The
near-term work is now post-usability-release hardening:

- **Security hardening release cut.** The Unreleased dev-line hardening is merged and
  documented, but package publication is still a human gate. Cut package versions,
  publish, then update the release truth from "merged to dev" to "published and
  verified."
- **Stats workflow repair.** Keep popularity snapshots out of direct `dev` pushes:
  automated stats should update a feature branch and open a PR.
- **Portability CI matrix.** Add Linux/macOS/Windows CI coverage for the core Python
  suites and wheel install smokes so platform-specific bugs are caught before publish.
- **npm publish automation (#42).** Fix npm automation without bypassing npm's
  security model.
- **Launch.** Launch copy (Twitter thread + GitHub release) and the website brief were
  drafted but kept private (not committed to the public repo). Posting is a per-item
  gate.
- **Worth-using dogfood (#24).** Stand up a Vivary `writing` workspace for the
  website and rewrite its copy through the loop, using the *published* CLIs; capture
  `docs/WALKTHROUGH.md`.
- **Release automation (#15/#22).** A `.github/workflows/release.yml` that publishes
  npm + PyPI via **OIDC trusted publishing** on a version tag — tokenless, but needs
  Actions billing unlocked to run.
- **Other roadmap (#16–#23):** ozone LLM packs + a prose pack · graphify semantic
  layer · a multi-agent preset · move the `loops` skill into strato.

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
