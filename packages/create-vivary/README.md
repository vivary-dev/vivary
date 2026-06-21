# create-vivary

Scaffold a complete Vivary agent workspace: tropo config, strato workspace files,
runtime skills, private-memory boundaries, progressive module indexes, and a starter
typed graph.

## Install & scaffold

```bash
pip install create-vivary                     # or run without installing: uvx create-vivary …
create-vivary my-workspace --preset coding    # interactive wizard on a TTY
create-vivary my-codebase --preset coding --active-context cocoindex-code
create-vivary doctor my-workspace

# Agent-mode (no prompts, machine-readable output):
create-vivary init . --preset coding --auto --size large --yes --json

# Reconfigure storage on an existing workspace:
create-vivary wizard my-workspace --auto --storage embedded --yes --json
```

`create-vivary <name>` is shorthand for `create-vivary init <name>`;
pass `init` / `doctor` / `wizard` explicitly whenever you prefer. The same UX is available on npm
via the `@vivary/create` launcher (`npm create @vivary my-workspace`), versioned in
lockstep.

## Local use

```bash
python packages/create-vivary/create_vivary.py init sandboxes/coding-demo --preset coding
python packages/create-vivary/create_vivary.py doctor sandboxes/coding-demo
python packages/tropo/tropo.py check --root sandboxes/coding-demo
```

Presets share the same agent OS shell, then seed a different starter graph. Each
starter module is generated as `modules/<id>/index.md` so agents route through a small
module index before opening deeper context:

| Preset | Module | First slice | Verification |
|---|---|---|---|
| `coding` | `codebase` | `local-ci-baseline` | `local-checks` |
| `second-brain` | `knowledge-base` | `capture-routine` | `retrieval-smoke` |
| `writing` | `manuscript-system` | `draft-review-loop` | `editorial-review` |

The command is local-only. With `--storage embedded` or `--auto` on a large workspace, it
self-installs `vivary-tropo[embedded]` (LanceDB) with a confirmation prompt, or silently
with `--yes`. Use `--dry-run` to simulate without writing anything. Use `--no-wizard` to
skip interactive prompts entirely.

For coding workspaces, `--active-context cocoindex-code` adds an optional
CocoIndex-code sidecar profile: active-context skills for Claude/Codex-style agents,
local policy docs, graph nodes, and `.cocoindex_code/` in `.gitignore`. It does not
auto-install CocoIndex-code, create an index, or enable MCP; the generated docs give
the approved `ccc init` / `ccc index` path.

`doctor` validates the generated shell, privacy ignores, module directory indexes, and
typed graph:

```bash
python packages/create-vivary/create_vivary.py doctor sandboxes/coding-demo --json
```

---

Website & docs: <https://vivary.vercel.app/>
