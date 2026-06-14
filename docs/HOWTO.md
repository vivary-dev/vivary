# Vivary — how-to recipes

Task-oriented recipes. Assumes the CLIs are installed (`pip install vivary-tropo
vivary-ozone vivary-exo create-vivary`) or run via `uvx`. Run commands from inside a
workspace unless `--root` is given.

## Scaffold a new workspace

```bash
create-vivary init my-workspace --preset writing      # coding | second-brain | writing
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
ozone review --strict       # gate: exit 1 if any warning (use in CI / pre-merge)
```

`tropo check` validates each document; `ozone review` checks the *relationships* between
them. Use both before you merge.

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
[OBSIDIAN.md](OBSIDIAN.md).)

## Coordinate multiple agents

Mark in-flight work `status: active` on its change doc, then:

```bash
exo board           # who's working on what
exo conflicts       # active changes that touch the same node (collision risk)
exo roles           # the bounded contracts to hand workers
```

## Use Vivary in CI

CI is just the gate, run on the exit code:

```yaml
- run: pip install vivary-tropo vivary-ozone
- run: tropo check                 # strict by default — warnings fail
- run: ozone review --strict       # relationship gate
```

## First run in an agent (bootstrap)

Open the workspace in Claude Code or Codex and say **"bootstrap the workspace"** — the
strato skill interviews you and fills `SOUL.md` / `USER.md` / `STATE.md`. See
[SKILLS.md](SKILLS.md).

## Publish your own Vivary-based tool (gated)

Publishing (PyPI/npm), creating orgs/repos, pushing, and opening PRs are **human gates** —
one explicit approval per item. The workspace contract enforces this; don't batch them.
