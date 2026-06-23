# Getting started with Vivary

This page takes you from nothing to a working **agent-native workspace**: a project
folder set up so an AI agent can navigate it, check its own work, and remember things
between sessions. You don't need to be an expert. If a term is unfamiliar, the
[concepts page](/concepts/) defines everything in plain language.

What you'll end up with: a folder full of plain Markdown files (memory, state, skills,
and gates) that any AI agent can operate.

## 1. Install

You need **Python 3.11 or newer**. Pick whichever line fits how you like to work:

```bash
# A) install the command-line tools
pip install vivary-tropo vivary-ozone vivary-exo create-vivary==0.2.5

# B) run on demand with uv, nothing installed permanently
uvx vivary-tropo --version

# C) scaffold with one npm command, pinned to the latest npm tag
#    Requires Python 3.11+ and uv or pipx; no Python package install first.
npm create @vivary@latest my-workspace # or: npx @vivary/create@latest my-workspace
```

No special editor is required. Vivary is plain Markdown and YAML, so it works in Claude
Code, Codex, vim, or nothing at all. (Prefer Obsidian? See [the optional
setup](/obsidian/).)

## 2. Create a workspace

```bash
create-vivary init my-workspace --preset coding
cd my-workspace
```

A **preset** just picks the starter content. Choose the one closest to your work:

- **`coding`** — a software project.
- **`second-brain`** — a personal knowledge base.
- **`writing`** — a manuscript or copy system.

They all share the same structure and differ only in the starter notes.

On a terminal that supports input, `init` runs a short wizard to ask about storage (how large your workspace will be, local vs cloud). For scripted storage selection, pass `--no-wizard --storage embedded --yes` or use `--auto`; in human mode, the wizard asks and its answers drive storage. Add
`--obsidian` if you want an optional Obsidian vault config too. For coding
workspaces, add `--active-context cocoindex-code` if you want the agent to ask when
CocoIndex-code semantic search would help:

```bash
create-vivary init my-codebase --preset coding --active-context cocoindex-code
```

That option writes guidance and graph nodes only. It does not auto-install
CocoIndex-code, build an index, enable MCP, or send source text anywhere. After the
user approves active context, follow [Active context](/active-context/) for the
verified `ccc init` / `ccc doctor` / `ccc index` path.

You now have a complete workspace:

```
AGENTS.md          the contract the agent follows each turn (the loop and the gates)
SOUL.md            the agent's personality and principles
STATE.md           the one place that answers "where are we?" (Focus / Status / Next)
USER.md  MEMORY.md  your private identity + durable memory (ignored by Git)
memory/  heartbeat-reports/  private memory and heartbeat output (ignored by Git)
STRATO.md          how the agent operating system works
tropo.toml         the rules for the typed graph
modules/index.md   the router that tells agents which module index to open
modules/<id>/index.md  lightweight module routers; deep context lives behind links
changes/ decisions/ verification/ gates/   the starter knowledge graph
.claude/skills/  .agents/skills/   ready-made skills for Claude Code + Codex
```

With `--active-context cocoindex-code`, the workspace also includes
`docs/active-context.md` and an `active-context` skill.

## 3. Check that it's healthy

`doctor` confirms the workspace was created correctly, including that private context
and heartbeat output are actively ignored by Git. The other three commands are your
everyday checks:

```bash
create-vivary doctor my-workspace
# doctor: ok (9 node(s), 28 edge(s), 0 broken)

tropo check          # validates every note and the graph (strict: warnings fail too)
ozone review         # reviews the relationships across the whole graph
exo board            # lists work items by status
```

If `tropo check` complains, that's the point: it tells you exactly what's missing or
mistyped so your agent's memory can't quietly go stale.

## 4. See the graph

```bash
tropo graph --json                 # the machine-readable view
tropo view --out graph.html        # a self-contained visual graph; open it in any browser
tropo blast human-gates            # everything that depends on the "human-gates" note
```

That last one is **blast radius**: what a change to a note would touch. It's the kind
of impact a plain text diff can't show you.

## 5. Operate the loop

Open the workspace in your agent (Claude Code reads `.claude/skills/`; Codex reads
`AGENTS.md` and `.agents/`). The contract in `AGENTS.md` drives every turn:

> **Ask → retrieve → act → verify → learn → gate.**
> - *retrieve* with `tropo graph` / `tropo blast <id>`: the graph is the first source
>   of truth, notes second. Use `modules/index.md` to pick one module index instead of
>   loading the whole tree.
> - *verify* with `tropo check` and `ozone review` before a gate.
> - *gate*: name the blast radius (`ozone impact <id>`) for a risky change, and stop at
>   the human gates (memory writes, publishing, installs, git push/PR, destructive ops).

The first time you open a fresh workspace, ask the agent to **bootstrap**. The strato
skill interviews you and fills in SOUL / USER / STATE. See [agent skills](/skills/).

When multiple agents share one workspace, opt into coordination fields:

```toml
packs = ["repo-graph", "coordination"]
```

Then claim work before editing:

```bash
exo claim local-ci-baseline --agent connie
exo board
exo conflicts
tropo check
```

## 6. Add your own work

The graph is just typed folders. Add a module, a change, a decision by creating a file:

```bash
mkdir -p modules
mkdir -p modules/billing
cat > modules/billing/index.md <<'EOF'
---
project: my-workspace
status: active
module_area: payments
related_changes: [add-stripe]
EOF
tropo check        # tells you exactly what's missing or mistyped
```

`tropo check` is your guardrail. It's opinionated on purpose, so it'll tell you when the
graph is wrong. Run `tropo fix` to clear redundant frontmatter.

## Next

- [Concepts](/concepts/) — what everything means, in plain language.
- [Command reference](/commands/) — every CLI, flag, exit code, and data storage options.
- [How-to recipes](/howto/) — review a change, multi-agent, CI, LanceDB search, and more.
- [Agent skills](/skills/) — bootstrap, heartbeat, self-improve, loops.
- [Active context](/active-context/) — optional CocoIndex-code sidecar for code search.
- [Architecture](/architecture/) — the layer model and the reasoning behind it.
- [FAQ](/faq/)
