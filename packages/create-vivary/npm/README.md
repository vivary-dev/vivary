# @vivary/create

**The `create-t3-app` for agent-native workspaces.** Scaffold a complete Vivary
workspace — typed knowledge graph (tropo), agent OS (strato), and starter graph — in
one command. Generated modules use `modules/<id>/index.md` routers so agents load
context progressively.

**Current release:** 0.2.8. Use 0.2.8 for new installs; no migration is expected
from 0.2.1, 0.2.2, 0.2.3, 0.2.5, 0.2.6, or 0.2.7.

**Release focus:** 0.2.8 publishes the optional Cognee adapter surface: capability
metadata now points to `vivary-memory-cognee`, generated workspace docs explain the
approval gates, and the default scaffolder still does not install Cognee or index
content.

**Security hardening:** The 0.2.5 line validates active `.gitignore` rules for `USER.md`,
`MEMORY.md`, `memory/*`, and `heartbeat-reports/*`; scaffolds private heartbeat report
storage; and refuses symlinked or out-of-workspace scaffold, storage, and cleanup
paths.

```bash
npm create @vivary@latest my-workspace -- --preset coding
npm create @vivary@latest my-workbench -- --preset knowledge-work --memory local
npm create @vivary@latest my-codebase -- --preset coding --active-context cocoindex-code
# or
npx @vivary/create@latest my-workspace --preset coding

# Agent-mode (no prompts, machine-readable output):
npx @vivary/create@latest init . --preset coding --auto --size large --yes --json

# Reconfigure storage on an existing workspace:
npx @vivary/create@latest wizard my-workspace --auto --storage embedded --yes --json

# Show optional preset capabilities:
npx @vivary/create@latest capabilities --preset knowledge-work --json
```

Presets: `coding` · `second-brain` · `knowledge-work` · `writing`.

A bare `npm create @vivary@latest <name>` maps to the `init` subcommand; you can also
pass `init` / `doctor` / `wizard` / `capabilities` explicitly (e.g. `npm create @vivary@latest doctor my-workspace`).

On a terminal that supports input, `init` runs a short wizard to pick a storage tier.
For scripted storage selection, pass `--no-wizard --storage embedded --yes` or use
`--auto`; in human mode, the wizard asks and its answers drive storage. Semantic
memory is separate: `--memory local` writes local-only policy, and `--memory cognee`
writes Cognee policy and verification docs without installing Cognee or indexing
content. Runtime Cognee recall lives in the optional `vivary-memory-cognee` Python
package and still requires explicit install and index approval.

## How it works

This package is a thin launcher: it runs the Python `create-vivary` scaffolder via
[uv](https://docs.astral.sh/uv/) (`uvx`) or [pipx](https://pipx.pypa.io/), so the
scaffolder stays one source of truth in Python while you get a Node-native entry
point. **Python 3.11+ and uv (or pipx) must already be installed.**

Prefer Python directly? `uvx create-vivary@0.2.8 my-workspace --preset coding` — a bare
target defaults to `init` there too (the PyPI `create-vivary` is versioned in lockstep
with this launcher) — or `pip install create-vivary==0.2.8`.

For coding workspaces, `--active-context cocoindex-code` scaffolds optional
CocoIndex-code guidance and ignored sidecar state. It does not auto-install, index, or
enable MCP; the generated docs give the approved `ccc init` / `ccc index` path, and the
skill points agents to the canonical copyable LLM guide.

## License

MIT.

---

Website & docs: <https://vivary.vercel.app/>
