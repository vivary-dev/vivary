# Vivary

**The `create-t3-app` for agent workspaces.** A standard plus a scaffolder that
wires up a normalized, agent-native workspace from standalone modules — whether
the workspace is a second brain, a coding project, or a writing project.

A *vivary* is an archaic word for a vivarium: a self-contained world where living
things are kept, in stacked layers. That's the metaphor — your project lives
inside a small, well-formed world with a substrate, an atmosphere, and gates.

> Status: **local scaffold MVP.** `packages/tropo` is a working knowledge-graph
> CLI, `packages/strato` contains the agent OS contract/templates/skill, and
> `packages/create-vivary` scaffolds a complete agent workspace. `ozone` and `exo`
> are still stubs. See [HANDOFF.md](HANDOFF.md) to continue, and
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full model.

## Try it locally

```bash
python packages/create-vivary/create_vivary.py init sandboxes/coding-demo --preset coding
python packages/create-vivary/create_vivary.py doctor sandboxes/coding-demo
python packages/tropo/tropo.py check --root sandboxes/coding-demo
python packages/tropo/tropo.py graph --root sandboxes/coding-demo --json
```

The scaffolder writes a full workspace shell: `AGENTS.md`, `STATE.md`, `SOUL.md`,
private `USER.md`/`MEMORY.md` boundaries, strato runtime skills for Claude/Codex-style
agents, a `tropo.toml`, and a starter typed graph. `doctor` validates the shell,
privacy ignores, and graph health after creation.

## The irreducible baseline

Every agent workspace, regardless of stack or task, needs the same small core:

> **A self-improving loop running over a typed, navigable knowledge graph, with
> one visible state surface and human gates.**

Everything Vivary ships is a facet of that one sentence. The design law (inherited
from [throughline](https://github.com/Jeff-Kazzee/throughline)): *the framework
must cost almost nothing to load, or it steals the context the work needs.*

## Modules

Standalone packages, scoped `@vivary/*` (npm) / `vivary-*` (PyPI), composed by
`create vivary`:

| Package | Layer | Job | Source |
|---|---|---|---|
| **tropo** | troposphere — the living foundation | typed knowledge graph: what the workspace *knows* | loam ✓ |
| **strato** | stratosphere — the stable layer | agent OS: state surface, memory, the loop, gates, self-improvement | throughline + flywheel |
| **ozone** | the protective filter | review — code *and* editorial | new |
| **exo** | the outermost layer | multi-agent orchestration | new |

`create vivary` → pick a preset (**second brain · coding · writing**) → it lays
down `tropo` + `strato` and whichever optional layers fit.

The current local command surface is:

```bash
python packages/create-vivary/create_vivary.py init <dir> --preset coding
```

npm packaging is still gated future work.

## The value-add (why this isn't another harness)

1. The substrate is a **typed, validated knowledge graph**, not flat memory.
2. Every change shows its **blast radius** — before and after — beyond a text diff.
3. It's **medium-agnostic**: the same graph + review serves code and prose.
4. It **standardizes the agent workspace** — which nobody has done.

## License

MIT — see [LICENSE](LICENSE).
