# create-vivary

Scaffold a complete Vivary agent workspace: tropo config, strato workspace files,
runtime skills, private-memory boundaries, progressive module indexes, and a starter
typed graph.

## Install & scaffold

```bash
pip install create-vivary                     # or run without installing: uvx create-vivary …
create-vivary my-workspace --preset coding    # bare target defaults to `init`
create-vivary my-codebase --preset coding --active-context cocoindex-code
create-vivary doctor my-workspace
```

`create-vivary <name>` is shorthand for `create-vivary init <name>` (since 0.1.1);
pass `init` / `doctor` explicitly whenever you prefer. The same UX is available on npm
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

The command is local-only and zero-dependency. It does not install packages, initialize
git, push, publish, or enable hooks.

For coding workspaces, `--active-context cocoindex-code` adds an optional
CocoIndex-code sidecar profile: active-context skills for Claude/Codex-style agents,
local policy docs, graph nodes, and `.cocoindex_code/` in `.gitignore`. It does not
install CocoIndex-code, create an index, or enable MCP.

`doctor` validates the generated shell, privacy ignores, module directory indexes, and
typed graph:

```bash
python packages/create-vivary/create_vivary.py doctor sandboxes/coding-demo --json
```

---

Website & docs: <https://vivary.vercel.app/>
