# create-vivary

Scaffold a complete Vivary agent workspace: tropo config, strato workspace files,
runtime skills, private-memory boundaries, and a starter typed graph.

## Local use

```bash
python packages/create-vivary/create_vivary.py init sandboxes/coding-demo --preset coding
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
