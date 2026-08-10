# @vivary/create

**A scaffolder for normalized agent-native workspaces.** Create a Vivary workspace
with a typed knowledge graph (tropo), agent OS (strato), starter graph, visible state,
and human gates in one command. Generated modules use `modules/<id>/index.md` routers
so agents load context progressively.

Published and development version truth lives in the
[root release status](https://github.com/vivary-dev/vivary/blob/dev/README.md#release-status).

This development source remains in lockstep with the Python package. It forwards
the governed capability and Doctor reports without adding a JavaScript
implementation. `create-vivary adopt <path>` uses dry-run by default, and
`doctor --trend` tracks graph and routing drift in `.vivary/doctor-state.json`.

The unpublished source candidates are `@vivary/create 0.3.4` and
`create-vivary 0.3.4`; both require `vivary-tropo>=0.5.2`.

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

# Preview brownfield adoption without writing:
npx @vivary/create@latest adopt .

# Append a local debug receipt without polluting JSON stdout:
npx @vivary/create@latest doctor my-workspace --json --receipt .vivary/receipts.jsonl
```

Presets: `coding` · `second-brain` · `knowledge-work` · `writing`.

The npm launcher forwards argv unchanged to the Python CLI. Python is the sole owner
of command recognition and the bare `<name>` → `init <name>` normalization; you can
also pass `init` / `doctor` / `wizard` / `capabilities` / `adopt` explicitly (e.g.
`npm create @vivary@latest adopt .`).

For local debugging, pass `--receipt PATH` or set `VIVARY_RECEIPT_LOG=PATH` to append
a dependency-free JSONL run receipt. Receipts stay local and record only command
envelope data such as tool version, command, flag names, exit code, duration, Python,
and platform; they do not capture stdout, stderr, file contents, preset values,
target paths, or environment variables.

On a terminal that supports input, `init` runs a short wizard to pick a storage tier.
For scripted storage selection, pass `--no-wizard --storage embedded --yes` or use
`--auto`; in human mode, the wizard asks and its answers drive storage. Semantic
memory is separate: `--memory local` writes local-only policy, and `--memory cognee`
writes Cognee policy and verification docs without installing Cognee or indexing
content. Runtime Cognee recall lives in the optional `vivary-memory-cognee` Python
package and still requires explicit install and index approval.

In source builds and the next package release, `doctor --repair --json` previews a
guided repair plan without writing. After approval, `doctor --repair --yes`
regenerates missing ignored private placeholders, appends missing privacy ignore
lines, removes simple W210 redundant metadata, and reruns doctor. Non-workspace,
symlinked, junctioned, hardlinked, non-file, or non-UTF-8 repair targets are refused
or kept manual. Complex YAML W210 cases, broken refs, and exo conflicts stay manual
guidance.

## How it works

This package is a thin, shell-free transport: it forwards argv unchanged to the Python
`create-vivary` scaffolder via [uv](https://docs.astral.sh/uv/) (`uvx`) or
[pipx](https://pipx.pypa.io/), so the scaffolder stays one source of truth while you
get a Node-native entry point. **Python 3.11+ and uv (or pipx) must already be installed.**

Prefer Python directly? `uvx create-vivary my-workspace --preset coding` — a bare
target defaults to `init` there too (the PyPI `create-vivary` stays in lockstep with
this launcher) — or `pip install create-vivary`.

For coding workspaces, `--active-context cocoindex-code` scaffolds optional
CocoIndex-code guidance and ignored sidecar state. It does not auto-install, index, or
enable MCP; the generated docs give the approved `ccc init` / `ccc index` path, and the
skill points agents to the canonical copyable LLM guide.

## License

MIT.

---

Website & docs: <https://vivary.vercel.app/>
