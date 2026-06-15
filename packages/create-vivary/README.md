# create-vivary

Scaffold a complete Vivary agent workspace: tropo config, strato workspace files,
runtime skills, private-memory boundaries, and a starter typed graph.

## Install & scaffold

```bash
pip install create-vivary                     # or run without installing: uvx create-vivary …
create-vivary my-workspace --preset coding    # bare target defaults to `init`
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

Presets share the same agent OS shell, then seed a different starter graph:

| Preset | Module | First slice | Verification |
|---|---|---|---|
| `coding` | `codebase` | `local-ci-baseline` | `local-checks` |
| `second-brain` | `knowledge-base` | `capture-routine` | `retrieval-smoke` |
| `writing` | `manuscript-system` | `draft-review-loop` | `editorial-review` |

The command is local-only and zero-dependency. It does not install packages, initialize
git, push, publish, or enable hooks.

`doctor` validates the generated shell, privacy ignores, and typed graph:

```bash
python packages/create-vivary/create_vivary.py doctor sandboxes/coding-demo --json
```

---

Website & docs: <https://vivary.vercel.app/>
