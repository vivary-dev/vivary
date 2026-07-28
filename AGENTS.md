# AGENTS.md — Vivary runtime contract

The contract for **any** agent working in this repo (Claude Code, Codex CLI, …).
Lean by law — depth lives in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Read it
once; don't reload it every turn.

## Mission

Vivary is a **standard + scaffolder for agent-native workspaces**. Its baseline is
*a self-improving loop over a typed knowledge graph, with one visible state surface
and human gates.* Modules: **tropo** (knowledge), **strato** (agent OS), **ozone**
(review), **exo** (orchestration).

## Design law (non-negotiable)

**Minimalism.** Every always-on file competes with the user's task for context. A
layer or file that is expensive to load is *wrong*. Fewer files, fewer words, more
room for the work. This file obeys its own law — keep it that way.

**DRY + progressive disclosure.** One fact gets one owner. Root contracts and
`index.md` files route; deeper files carry detail. Do not duplicate durable truth
across README/docs/templates/skills when a link will do, and do not bulk-load a tree
when `tropo graph`, `modules/index.md`, or a module's `index.md` can choose the next
file.

## The operating loop (per turn)

`Ask → retrieve → act → verify → learn → gate.` State known / inferred / unknown
and confirm before guessing. Do one verified slice at a time.

## Loops — a tool to recommend, not a default

Default to a single focused pass. When a task is repeatable, long-running, or
unattended, *consider recommending* a loop (a program that prompts the agent and
decides whether to continue) rather than reaching for one by default. Judging fit
and setting one up safely lives in the **loops skill**
(`.claude/skills/loops/`).

If you do run a loop: it must self-verify each tick and have hard stops (max
iterations, no-progress detection, budget ceiling), and it still **stops at the
hard gates (below)** — autonomy inside the work, alignment at the edges.

## 🚦 Hard gates — STOP and get the human

These are not optional and are not batchable. One explicit human approval per item.

1. **Plan + alignment before merge** (see below) — no branch merges without it.
2. **Publishing / outward actions** — npm or PyPI publish, GitHub org/repo
   creation, `push`, opening a PR. Each, explicitly, per item.
3. **Destructive ops** — delete, force-push, history rewrite.
4. **The four source repos are read-only** — loam, braincheck, throughline,
   flywheel. Copy from them; never modify them.

## Plan + alignment before merge

**Human and agent must be aligned — in writing — before anything merges.** Before
merging a branch or landing a substantial change, produce a written plan and get
explicit human approval. The plan states:

1. **Intent** — what changes and why; which layer/module and how it serves the
   baseline thesis.
2. **Blast radius** — everything it touches: files, packages, the knowledge graph,
   downstream layers. (Use tropo's `graph`/`blast` and `ozone impact`.)
3. **Verification** — how we'll know it's right: tests, checks, a sandbox run.
4. **Out of scope** — what this deliberately does *not* do.
5. **Alignment** — "I think I know / I am inferring / I do not know — confirm or
   correct." The human confirms or corrects.

No merge until the human has approved the plan **and** the delivered change matches
it. If the work diverged from the approved plan, re-align before merging — don't
merge and explain after.

*How* you produce the plan is runtime-specific; your runtime overlay names the
mechanism (for Claude Code, see CLAUDE.md → "ultraplan").

## Constraints

- **Branch rules (enforced).** `dev` is the protected integration branch — **no direct
  pushes**. Every change lands via a feature branch cut from `dev` → PR → merge, with
  the `ci` checks + the `ozone review` gate green first. `dev` blocks force-push and
  deletion. `main` is the vestigial baseline; `prod` is reserved for a future release cut.
- **No nested git repos.** Vivary is one repo; packages are plain subdirectories.
- **Supply chain.** Before any install, check `~/dev/agents/.shared/deny-list-npm.json`
  and run `npm`/`pnpm audit`. Vet new dependencies; prefer pinned pre-compromise
  versions.
- **Platform.** Windows / PowerShell (`$null`, never `nul`; bash also available).
  `tropo` needs Python 3.11+ (stdlib `tomllib`).
- **CI runs free** on the public `vivary-dev/vivary` repo (Actions is free for public
  repos): `.github/workflows/ci.yml` runs every package suite + parity + `tropo check` +
  the `ozone review --strict` review gate + a cross-platform (Ubuntu/Windows)
  orientation proof + a site build on every PR/push. Verify locally too; the local
  suite is fast.
- **Docs stay in sync.** Update the affected docs in the *same* change as any
  behavior / command / flag / structure change — never leave them stale (stale docs
  are a bug). Source of truth is `docs/`; the website under `site/` is generated from
  it (`cd site && npm run sync-docs`, also auto-run on build). Touch the package
  READMEs when relevant. Private handoffs and agent-to-Jeff continuity notes stay in
  ignored local storage or the Second Brain, never in the public repo. Every merge's
  verification includes it.
- **Every update ends with release truth.** For any behavior, packaging, version, or
  public-copy change, run [docs/RELEASE-WORKFLOW.md](docs/RELEASE-WORKFLOW.md):
  update changelog/docs/site/package copy, sync generated site docs, verify install
  surfaces after publish, and keep launch/social posts in ignored local storage or the
  Second Brain, not the public repo.

## Verify

```bash
python packages/tropo/tests/test_tropo.py                  # 169/169
python packages/ozone/tests/test_ozone.py                  # 21/21
python packages/exo/tests/test_exo.py                      # 17/17
python packages/create-vivary/tests/test_create_vivary.py  # 143 run, 1 skipped
python -m pytest packages/core/tests/ -q                   # 626 Windows; 624 + 2 skips Linux
python -m pytest packages/strato/tests/ -q                 # 48/48
python packages/tropo/tropo.py check --root packages/tropo/examples/vault   # clean
```

Current release truth lives in [README.md](README.md) and [CHANGELOG.md](CHANGELOG.md):
`create-vivary` / `@vivary/create` 0.3.1, `vivary-memory-cognee` 0.1.0,
`vivary-tropo` 0.4.1, `vivary-exo` 0.2.2, and `vivary-ozone` 0.2.0 are the
published versions; unpublished source is `vivary-core` 0.2.2, `vivary-tropo` 0.5.0,
`vivary-strato` 0.1.1, and the `vivary` meta-package 0.1.1. Versions are
independent; there is no single "Vivary 0.4.1" release. This line adds `tropo map`,
brownfield `create-vivary adopt`, `doctor --trend` drift tracking, and strato
integrity gates in CI. Full guides live in [docs/](docs/).
