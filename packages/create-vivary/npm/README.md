# @vivary/create

**The `create-t3-app` for agent-native workspaces.** Scaffold a complete Vivary
workspace — typed knowledge graph (tropo), agent OS (strato), and starter graph — in
one command.

```bash
npm create @vivary my-workspace -- --preset coding
# or
npx @vivary/create my-workspace --preset coding
```

Presets: `coding` · `second-brain` · `writing`.

A bare `npm create @vivary <name>` maps to the `init` subcommand; you can also pass
`init` / `doctor` explicitly (e.g. `npm create @vivary doctor my-workspace`).

## How it works

This package is a thin launcher: it runs the Python `create-vivary` scaffolder via
[uv](https://docs.astral.sh/uv/) (`uvx`) or [pipx](https://pipx.pypa.io/), so the
scaffolder stays one source of truth in Python while you get a Node-native entry
point. **Python 3.11+ and uv (or pipx) must be installed.**

Prefer Python directly? The Python CLI takes the explicit subcommand:
`uvx create-vivary init my-workspace --preset coding` or `pip install create-vivary`.

## License

MIT.

---

Website & docs: <https://vivary.vercel.app/>
