---
title: Getting started
description: Install Vivary and run your first agent workspace.
---


Vivary turns a folder into an **agent-native workspace**: a typed knowledge graph,
an agent operating loop with visible state and memory, graph-aware review, and human
gates. This page takes you from nothing to a working workspace an agent can operate.

## 1. Install

You need **Python 3.11+**. Pick one:

```bash
# A) install the CLIs
pip install vivary-tropo vivary-ozone vivary-exo create-vivary

# B) run on demand with uv (no install)
uvx vivary-tropo --version

# C) scaffold via npm (the create-t3-app experience)
npm create @vivary my-workspace        # or: npx @vivary/create my-workspace
```

No editor is required. Vivary is plain Markdown + YAML; it works in Claude Code, Codex,
vim, or nothing at all. (Like Obsidian? See [OBSIDIAN.md](/obsidian/).)

## 2. Create a workspace

```bash
create-vivary init my-workspace --preset coding
cd my-workspace
```

Presets: **`coding`** (a software project), **`second-brain`** (a knowledge base),
**`writing`** (a manuscript/copy system). They share the same shell and differ only by
starter graph. Add `--obsidian` for an optional Obsidian vault config.

You now have:

```
AGENTS.md          the per-session contract (the loop, gates, the graph)
SOUL.md            the agent's personality/principles
STATE.md           the one visible state surface (Focus/Status/Next/...)
USER.md  MEMORY.md  private identity + durable memory (gitignored)
STRATO.md          the agent-OS model
tropo.toml         the typed-graph schema
modules/ changes/ decisions/ verification/ gates/   the starter typed graph
.claude/skills/  .agents/skills/   runtime skills (strato, loops) for Claude Code + Codex
```

## 3. Verify it's healthy

```bash
create-vivary doctor my-workspace
# doctor: ok (8 node(s), 24 edge(s), 0 broken)

tropo check          # strict: validates every doc + the graph (warnings fail)
ozone review         # relationship-level review of the graph
exo board            # work items by status
```

## 4. See the graph

```bash
tropo graph --json                 # the machine view
tropo view --out graph.html        # a self-contained visual graph — open in any browser
tropo blast human-gates            # what depends on the "human-gates" node
```

## 5. Operate the loop

Open the workspace in your agent (Claude Code reads `.claude/skills/`; Codex reads
`AGENTS.md` + `.agents/`). The contract (`AGENTS.md`) drives every turn:

> **Ask → retrieve → act → verify → learn → gate.**
> - *retrieve* with `tropo graph` / `tropo blast <id>` — the graph is the first source
>   of truth, notes second.
> - *verify* with `tropo check` + `ozone review` before a gate.
> - *gate* — name the blast radius (`ozone impact <id>`) for a risky change, and stop at
>   the human gates (memory writes, publishing, installs, git push/PR, destructive ops).

First time in a fresh workspace, ask the agent to **bootstrap** (the strato skill
interviews you and fills SOUL/USER/STATE) — see [SKILLS.md](/skills/).

## 6. Add your own work

The graph is just typed folders. Add a module, a change, a decision:

```bash
mkdir -p modules
cat > modules/billing.md <<'EOF'
---
project: my-workspace
status: active
module_area: payments
related_changes: [add-stripe]
EOF
tropo check        # tells you exactly what's missing or mistyped
```

`tropo check` is your guardrail — it's opinionated, so it'll tell you when the graph is
wrong. Run `tropo fix` to clear redundant frontmatter.

## Next

- [COMMANDS.md](/commands/) — full CLI reference
- [HOWTO.md](/howto/) — task recipes (review a change, multi-agent, CI, …)
- [SKILLS.md](/skills/) — the agent skills (bootstrap, heartbeat, self-improve, loops)
- [ARCHITECTURE.md](/architecture/) — the layer model and the why
- [FAQ.md](/faq/)
