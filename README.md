# Vivary

[![npm/mo](https://img.shields.io/npm/dm/%40vivary%2Fcreate?style=flat-square&color=1f9d72&label=npm%2Fmo)](https://www.npmjs.com/package/@vivary/create)
[![PyPI/mo](https://img.shields.io/pypi/dm/create-vivary?style=flat-square&color=1f9d72&label=PyPI%2Fmo)](https://pypi.org/project/create-vivary/)
[![GitHub stars](https://img.shields.io/github/stars/vivary-dev/vivary?style=flat-square&color=1f9d72)](https://github.com/vivary-dev/vivary/stargazers)
[![MIT](https://img.shields.io/badge/license-MIT-1f9d72?style=flat-square)](LICENSE)

**Typed memory and gates for AI-agent projects.** A standard plus a scaffolder that
wires up a normalized, agent-native workspace from standalone modules — typed project
memory, visible state, reusable skills, private boundaries, and verification gates —
whether the workspace is a second brain, a coding project, or a writing project. Think
`create-t3-app`, but for an AI agent's workspace instead of a web app.

A *vivary* is an archaic word for a vivarium: a self-contained world where living
things are kept, in stacked layers. That's the metaphor — your project lives
inside a small, well-formed world with a substrate, an atmosphere, and gates.

> Status: **shipped and installable.** `vivary-tropo` is at **0.2.0**,
> `create-vivary` is at **0.2.2**, and `vivary-ozone` / `vivary-exo` are at 0.1.0 — all on
> [PyPI](https://pypi.org/project/create-vivary/). `@vivary/create` (npm, in lockstep
> with `create-vivary`) is at **0.2.2** on [npm](https://www.npmjs.com/package/@vivary/create).
> Use 0.2.2 instead of 0.2.1; 0.2.1 was superseded by a clean release-provenance hotfix.
> `tropo` (typed knowledge graph + search + storage), `strato` (agent OS), `ozone`
> (graph-aware review), and `exo` (coordination) are composed by `create-vivary`. Live site:
> **[vivary.vercel.app](https://vivary.vercel.app/)**. See [HANDOFF.md](HANDOFF.md)
> to continue, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full model.

## Quickstart

Scaffold a workspace in one command (nothing to install first):

```bash
npm create @vivary my-workspace        # pick: second brain · coding · writing
```

Or install the CLIs from PyPI (run on demand with `uvx`, no install needed):

```bash
pip install vivary-tropo vivary-ozone vivary-exo create-vivary
create-vivary init my-workspace --preset coding     # interactive wizard on a TTY
create-vivary init my-codebase --preset coding --active-context cocoindex-code
create-vivary doctor my-workspace
uvx vivary-tropo check --root my-workspace

# Agent-mode — fully non-interactive, outputs JSON:
create-vivary init . --preset coding --auto --size large --yes --json
```

The scaffolder writes a full workspace shell: `AGENTS.md`, `STATE.md`, `SOUL.md`,
private `USER.md`/`MEMORY.md` boundaries, strato runtime skills for Claude/Codex-style
agents, a `tropo.toml`, a starter typed graph, and (optionally) a `.vivary/storage.toml`
for LanceDB or cloud storage. Generated modules are directories with `index.md` routers
(`modules/<id>/index.md`) so agents load the smallest useful context first. `doctor`
validates the shell, privacy ignores, graph health, storage backend, and module index
coverage after creation. `tropo query` and `tropo migrate` power graph search and
backend switching.

For coding workspaces that need richer source retrieval, `--active-context
cocoindex-code` adds optional CocoIndex-code guidance and graph nodes. It does not
auto-install, index, enable MCP, or send source text anywhere; the generated skill asks
before those gates, then gives the approved `ccc init` / `ccc index` / `ccc search`
path. See [docs/ACTIVE-CONTEXT.md](docs/ACTIVE-CONTEXT.md).

<details><summary>Run from source (no install)</summary>

```bash
python packages/create-vivary/create_vivary.py init sandboxes/coding-demo --preset coding
python packages/create-vivary/create_vivary.py doctor sandboxes/coding-demo
python packages/tropo/tropo.py check --root sandboxes/coding-demo
python packages/tropo/tropo.py graph --root sandboxes/coding-demo --json
```

</details>

## The irreducible baseline

Every agent workspace, regardless of stack or task, needs the same small core:

> **A self-improving loop running over a typed, navigable knowledge graph, with
> one visible state surface and human gates.**

Everything Vivary ships is a facet of that one sentence. The design law (inherited
from [throughline](https://github.com/Jeff-Kazzee/throughline)): *the framework
must cost almost nothing to load, or it steals the context the work needs.*

That means Vivary is deliberately DRY: one fact gets one owner, while `AGENTS.md`,
`STATE.md`, and module `index.md` files route to deeper context instead of duplicating
it. Full context management is valuable only when it keeps the active context small.

**No lock-in.** A workspace is plain Markdown + YAML and a few CLIs — it works in any
editor, or none, and on any agent runtime (Claude Code reads `.claude/skills/`, Codex
reads `AGENTS.md` + `.agents/`). Obsidian, an IDE, a particular agent — all optional.
The visual knowledge graph renders editor-free with `tropo view`; Obsidian fans get an
opt-in setup (`create-vivary init … --obsidian`) — see [docs/OBSIDIAN.md](docs/OBSIDIAN.md).

## Modules

Standalone packages, scoped `@vivary/*` (npm) / `vivary-*` (PyPI), composed by
`create vivary`:

| Package | Layer | Job | Source |
|---|---|---|---|
| **tropo** | troposphere — the living foundation | typed knowledge graph: what the workspace *knows* | loam ✓ |
| **strato** | stratosphere — the stable layer | agent OS: state surface, memory, the loop, gates, self-improvement | throughline + flywheel |
| **ozone** | the protective filter | review — graph-aware, code *and* editorial | new ✓ |
| **exo** | the outermost layer | coordination — conflict detection + role contracts | new ✓ |

`create vivary` → pick a preset (**second brain · coding · writing**) → it lays
down `tropo` + `strato` and whichever optional layers fit. See
[Quickstart](#quickstart) above to install.

## Documentation

**Website: [vivary.vercel.app](https://vivary.vercel.app/)** — or browse the source in
[docs/](docs/):

- [Getting started](docs/GETTING-STARTED.md) — install → workspace → loop
- [Command reference](docs/COMMANDS.md) — every CLI, flag, and exit code
- [How-to recipes](docs/HOWTO.md) · [Agent skills](docs/SKILLS.md) · [FAQ](docs/FAQ.md)
- [Architecture](docs/ARCHITECTURE.md) · [Obsidian (optional)](docs/OBSIDIAN.md)

## The value-add (why this isn't another harness)

1. The substrate is a **typed, validated knowledge graph**, not flat memory.
2. Every change shows its **blast radius** — before and after — beyond a text diff.
3. It's **medium-agnostic**: the same graph + review serves code and prose.
4. It **standardizes the agent workspace** — which nobody has done.
5. **Agents can self-configure from scratch** — `--auto --yes --json` gives a zero-prompt, machine-readable setup path for storage, installs, and scaffolding.

## License

MIT — see [LICENSE](LICENSE).
