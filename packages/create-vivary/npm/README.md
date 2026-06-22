# @vivary/create

**The `create-t3-app` for agent-native workspaces.** Scaffold a complete Vivary
workspace — typed knowledge graph (tropo), agent OS (strato), and starter graph — in
one command. Generated modules use `modules/<id>/index.md` routers so agents load
context progressively.

**Current release:** 0.2.2. Use 0.2.2 instead of 0.2.1 for new installs; no
migration is expected from 0.2.1.

```bash
npm create @vivary my-workspace -- --preset coding
npm create @vivary my-codebase -- --preset coding --active-context cocoindex-code
# or
npx @vivary/create my-workspace --preset coding

# Agent-mode (no prompts, machine-readable output):
npx @vivary/create init . --preset coding --auto --size large --yes --json

# Reconfigure storage on an existing workspace:
npx @vivary/create wizard my-workspace --auto --storage embedded --yes --json
```

Presets: `coding` · `second-brain` · `writing`.

A bare `npm create @vivary <name>` maps to the `init` subcommand; you can also pass
`init` / `doctor` / `wizard` explicitly (e.g. `npm create @vivary doctor my-workspace`).

On a terminal that supports input, `init` runs a short wizard to pick a storage tier.
For scripted storage selection, pass `--no-wizard --storage embedded --yes` or use
`--auto`; in human mode, the wizard asks and its answers drive storage.

## How it works

This package is a thin launcher: it runs the Python `create-vivary` scaffolder via
[uv](https://docs.astral.sh/uv/) (`uvx`) or [pipx](https://pipx.pypa.io/), so the
scaffolder stays one source of truth in Python while you get a Node-native entry
point. **Python 3.11+ and uv (or pipx) must already be installed.**

Prefer Python directly? `uvx create-vivary my-workspace --preset coding` — a bare
target defaults to `init` there too (the PyPI `create-vivary` is versioned in lockstep
with this launcher) — or `pip install create-vivary`.

For coding workspaces, `--active-context cocoindex-code` scaffolds optional
CocoIndex-code guidance and ignored sidecar state. It does not auto-install, index, or
enable MCP; the generated docs give the approved `ccc init` / `ccc index` path.

## License

MIT.

---

Website & docs: <https://vivary.vercel.app/>
