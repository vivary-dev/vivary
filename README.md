# Vivary

**The `create-t3-app` for agent workspaces.** A standard plus a scaffolder that
wires up a normalized, agent-native workspace from standalone modules — whether
the workspace is a second brain, a coding project, or a writing project.

A *vivary* is an archaic word for a vivarium: a self-contained world where living
things are kept, in stacked layers. That's the metaphor — your project lives
inside a small, well-formed world with a substrate, an atmosphere, and gates.

> Status: **skeleton.** `packages/tropo` is a working knowledge-graph CLI (ported
> from [loam](https://github.com/Jeff-Kazzee/loam), 22 tests passing). The other
> layers are stubs. See [HANDOFF.md](HANDOFF.md) to continue, and
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full model.

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

## The value-add (why this isn't another harness)

1. The substrate is a **typed, validated knowledge graph**, not flat memory.
2. Every change shows its **blast radius** — before and after — beyond a text diff.
3. It's **medium-agnostic**: the same graph + review serves code and prose.
4. It **standardizes the agent workspace** — which nobody has done.

## License

MIT — see [LICENSE](LICENSE).
