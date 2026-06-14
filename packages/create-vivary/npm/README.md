# create-vivary

**The `create-t3-app` for agent-native workspaces.** Scaffold a complete Vivary
workspace — typed knowledge graph (tropo), agent OS (strato), and starter graph — in
one command.

```bash
npm create vivary my-workspace -- --preset coding
# or
npx create-vivary my-workspace --preset coding
```

Presets: `coding` · `second-brain` · `writing`.

## How it works

This package is a thin launcher: it runs the Python `create-vivary` scaffolder via
[uv](https://docs.astral.sh/uv/) (`uvx`) or [pipx](https://pipx.pypa.io/), so the
scaffolder stays one source of truth in Python while you get a Node-native entry
point. **Python 3.11+ and uv (or pipx) must be installed.**

Prefer Python directly? `uvx create-vivary my-workspace --preset coding` or
`pip install create-vivary`.

## License

MIT.
