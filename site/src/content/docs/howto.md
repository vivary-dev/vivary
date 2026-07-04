---
title: "How-to recipes"
description: "Task recipes: add a type, see blast radius, review, CI, multi-agent."
---

Short, copy-paste recipes for common tasks. New to Vivary? Do the [getting started
guide](/getting-started/) first, then use these when you hit a specific job.

Each recipe assumes the CLIs are installed (`pip install vivary-tropo
vivary-ozone vivary-exo create-vivary==0.2.8`) or run via `uvx`. Run commands from
inside a workspace unless `--root` is given.

## Scaffold a new workspace

```bash
create-vivary init my-workspace --preset writing      # coding | second-brain | knowledge-work | writing
create-vivary doctor my-workspace                      # validate it
```

## Bring an existing repo's docs under tropo

```bash
cd my-repo
tropo init --packs repo-graph          # scaffold a tropo.toml (use a starter pack)
tropo check --lenient                  # see what's there without failing
tropo fix --dry-run                    # preview redundant-frontmatter removal
```

Iterate `tropo.toml` until `tropo check` is clean, then drop `--lenient` to make it a
gate.

## Add a typed document

The folder is the type. Drop a file in the right folder; `tropo check` tells you exactly
what metadata is required.

```bash
cat > decisions/0002-pick-postgres.md <<'EOF'
---
status: accepted
date: 2026-06-14
related_modules: [billing]
---
# Use Postgres for billing

Rationale...
EOF
tropo check decisions/0002-pick-postgres.md
```

A field that just repeats what tropo derives (id, title, dates) is **noise** — `tropo
fix` removes it.

## Add or change a type

Edit `tropo.toml`:

```toml
[types.runbook]
folder   = "runbooks"
required = { owner = "string" }
optional = { related_modules = "ref-list" }
```

Nested `tropo.toml` files **tighten** rules for a subtree (they can add requirements,
never loosen inherited ones).

## See what a change would touch (blast radius)

```bash
tropo blast billing                 # everything that (transitively) refs "billing"
tropo blast billing --depth 1       # direct dependents only
ozone impact billing                # same, with the review layer's framing
```

Run this **before** editing a load-bearing node — it's the impact a text diff can't show.

## Review the graph before a gate

```bash
ozone review                # advisory: unverified changes, broken edges, orphans
ozone review --pack context-budget   # advisory: context bloat and routing surfaces
ozone review --pack all     # run every deterministic review pack
ozone review --strict       # gate: exit 1 if any warning (use in CI / pre-merge)
```

`tropo check` validates each document; `ozone review` checks the *relationships* between
them. Use both before you merge.

Use `--pack context-budget` before a release or after adding repo-level docs/contracts.
It flags missing `modules/*/index.md` routers, legacy `modules/*.md` files that
coexist with directory indexes, oversized public routing surfaces, exact duplicated
routing blocks, and wording that tells agents to bulk-load whole repos or docs trees.
It does not read private `USER.md`, `MEMORY.md`, `memory/**`, or heartbeat reports.

## Simulate a change

```bash
cat > plan.toml <<'EOF'
remove = ["old-module"]
retype = { draft-note = "decision" }
EOF
tropo plan plan.toml        # shows nodes/edges added, removed, newly-broken
```

## Visualize the graph

```bash
tropo view --out graph.html             # the whole graph, self-contained HTML
tropo view blast billing --out impact.html   # one blast radius
```

Open the HTML in any browser — no editor, no server, no plugin. (Obsidian fans: see
[OBSIDIAN.md](/obsidian/).)

## Coordinate multiple agents

Opt into the coordination field in `tropo.toml`:

```toml
packs = ["repo-graph", "coordination"]
```

Claim a work item before editing, then inspect the board and conflict surface:

```bash
exo claim local-ci-baseline --agent connie
exo board
exo conflicts
tropo check
```

`exo claim` writes only to work items under `changes/`. It refuses to run unless
`assignee` is declared by the effective tropo config, rejects symlinked or
out-of-workspace work item files, and rewrites the workspace file without mutating
hard-linked targets outside it. Single-agent workspaces stay free of coordination
fields they do not use. `exo roles` still lists the bounded contracts to hand workers.

## Set up LanceDB storage (embedded backend)

Install the embedded extra and migrate your existing workspace:

```bash
pip install vivary-tropo[embedded]
tropo migrate --from file --to embedded --root my-workspace --dry-run   # preview
tropo migrate --from file --to embedded --root my-workspace --yes        # run
```

Or configure storage at init time:

```bash
create-vivary init my-workspace --preset coding --storage embedded --yes
```

## Query the knowledge graph

```bash
tropo query "CI baseline" --root .                   # text search, top-10 results
tropo query "auth" --root . --k 3 --json             # top-3, machine-readable
tropo find "what should I read for auth?" --root . --budget 1200 --json
```

`tropo query` and `tropo find` search analyzed typed graph nodes directly: id/title,
frontmatter, path, body, and outbound edge context. They do not require LanceDB.
Embedded storage is a separate opt-in backend for migrated node rows and future local
retrieval work.

## Agent self-configure a workspace

Agents can scaffold and configure a workspace without any human interaction:

```bash
# Fully non-interactive: auto picks embedded storage, installs LanceDB, outputs JSON
create-vivary init . --preset coding --auto --size large --yes --json

# Discover optional pieces for a preset
create-vivary capabilities --preset knowledge-work --json

# Dry run first (inspect without writing or installing anything)
create-vivary init my-workspace --auto --dry-run --json

# Reconfigure storage on an existing workspace
create-vivary wizard my-workspace --auto --storage embedded --yes --json

# Add semantic-memory policy without indexing or installing providers
create-vivary init my-workspace --preset knowledge-work --memory local --yes
create-vivary init my-notes --preset second-brain --memory cognee --no-wizard --dry-run --json
```

The `--auto` flag picks storage from explicit `--storage`, `--size`, and `--privacy`
hints (or defaults to `embedded` for medium/large). `--yes` auto-confirms installs.
`--json` gives machine-readable output. Combine all three for zero-prompt agent use.
Semantic memory stays separate from storage: `--memory local` writes local policy,
and `--memory cognee` writes Cognee policy plus verification docs without installing
Cognee, indexing content, enabling network access, or using an API key.

If you explicitly install the optional Cognee adapter, dry-run before provider writes:

```bash
vivary-cognee doctor --root . --json
vivary-cognee index --root . --dry-run --json
vivary-cognee index --root . --yes --json
vivary-cognee recall "which notes explain the auth decision?" --root . --json
```

The adapter sends privacy-filtered typed Tropo node packets and ignores recall hits
that do not map back to known Vivary node ids.

## Use Vivary in CI

CI is just the gate, run on the exit code:

```yaml
- run: pip install vivary-tropo vivary-ozone
- run: tropo check                 # strict by default — warnings fail
- run: ozone review --strict       # relationship gate
# Optional, once adopted:
- run: ozone review --pack all --strict
```

## Run Vivary as a CI gate

A full copy-paste GitHub Actions job: checkout, install the CLIs, then run doctor and
the two graph gates against the exit code.

```yaml
name: vivary
on: [push, pull_request]

jobs:
  vivary-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: pip install vivary-tropo vivary-ozone create-vivary
      - run: create-vivary doctor . --json
      - run: tropo check --root .
      - run: ozone review --strict --root .
```

`create-vivary doctor . --json` validates the scaffold (required files, privacy
ignores, module indexes, graph health, backend/memory status) and exits non-zero on
any error. `tropo check` validates each typed document; `ozone review --strict`
checks relationships between them (broken edges, orphans, unverified changes) and
fails the build on any warning. Add `--trend` to the doctor step once you want drift
tracking; it writes `.vivary/doctor-state.json`, so commit that file (or cache it
between runs) if you want deltas across CI runs rather than a "first recorded run"
every time.

## First run in an agent (bootstrap)

Open the workspace in Claude Code or Codex and say **"bootstrap the workspace"** — the
strato skill interviews you and fills `SOUL.md` / `USER.md` / `STATE.md`. See
[SKILLS.md](/skills/).

## Publish your own Vivary-based tool (gated)

Publishing (PyPI/npm), creating orgs/repos, pushing, and opening PRs are **human gates** —
one explicit approval per item. The workspace contract enforces this; don't batch them.
