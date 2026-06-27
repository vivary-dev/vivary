# create-vivary

Scaffold a complete Vivary agent workspace: tropo config, strato workspace files,
runtime skills, private-memory boundaries, progressive module indexes, and a starter
typed graph.

**Current release:** 0.2.7. Use 0.2.7 for new installs; no migration is expected
from 0.2.1, 0.2.2, 0.2.3, 0.2.5, or 0.2.6.

**Release focus:** 0.2.7 ships the context-compression release surface: generated
active-context guidance now leads with `tropo find`, points agents to the canonical
LLM active-context guide, and names LanceDB as embedded storage rather than hidden
search behavior.

**Security hardening:** The 0.2.5 line validates active `.gitignore` rules for `USER.md`,
`MEMORY.md`, `memory/*`, and `heartbeat-reports/*`; scaffolds private heartbeat report
storage; and refuses symlinked or out-of-workspace scaffold, storage, and cleanup
paths.

## Install & scaffold

```bash
pip install create-vivary==0.2.7              # or: uvx create-vivary@0.2.7 ...
create-vivary my-workspace --preset coding    # interactive wizard on a TTY
create-vivary my-workbench --preset knowledge-work --memory local
create-vivary my-codebase --preset coding --active-context cocoindex-code
create-vivary capabilities --preset second-brain --json
create-vivary doctor my-workspace

# Agent-mode (no prompts, machine-readable output):
create-vivary init . --preset coding --auto --size large --yes --json

# Reconfigure storage on an existing workspace:
create-vivary wizard my-workspace --auto --storage embedded --yes --json
```

`create-vivary <name>` is shorthand for `create-vivary init <name>`;
pass `init` / `doctor` / `wizard` / `capabilities` explicitly whenever you prefer. The same UX is available on npm
via the `@vivary/create` launcher (`npm create @vivary@latest my-workspace`), versioned in
lockstep.

Presets share the same agent OS shell, then seed a different starter graph. Each
starter module is generated as `modules/<id>/index.md` so agents route through a small
module index before opening deeper context:

| Preset | Module | First slice | Verification |
|---|---|---|---|
| `coding` | `codebase` | `local-ci-baseline` | `local-checks` |
| `second-brain` | `knowledge-base` | `capture-routine` | `retrieval-smoke` |
| `knowledge-work` | `workbench` + `sources` | `workbench-first-artifact` | `workbench-proof` |
| `writing` | `manuscript-system` | `draft-review-loop` | `editorial-review` |

The command is local-only. With `--storage embedded` or `--auto` on a large workspace, it
self-installs `vivary-tropo[embedded]` (LanceDB) with a confirmation prompt, or silently
with `--yes`. Scaffold writes, storage config writes, and stale generated cleanup
refuse symlinked destination parents, including when `--force` is used, so output
stays inside the selected target. Use `--dry-run` to simulate without writing,
installing, or cleaning stale files. For scripted storage selection, pass
`--no-wizard --storage embedded --yes` or use `--auto`;
in human mode, the wizard asks and its answers drive storage.

Semantic memory is a separate optional capability. `--memory local` writes local-only
policy and graph nodes; `--memory cognee` writes Cognee policy and verification docs.
Neither option indexes content or sends data anywhere during scaffold, and Cognee is
not installed by default. Use `create-vivary capabilities --preset <name> --json` to
show agents the available optional pieces before setup.

For coding workspaces, `--active-context cocoindex-code` adds an optional
CocoIndex-code sidecar profile: active-context skills for Claude/Codex-style agents,
local policy docs, graph nodes, and `.cocoindex_code/` in `.gitignore`. It does not
auto-install CocoIndex-code, create an index, or enable MCP; the generated docs give
the approved `ccc init` / `ccc index` path, and the skill points agents to the
canonical copyable LLM guide.

`doctor` validates the generated shell, active privacy ignore rules, module directory
indexes, semantic-memory status, and typed graph:

```bash
python packages/create-vivary/create_vivary.py doctor sandboxes/coding-demo --json
```

## Developing from source

```bash
python packages/create-vivary/create_vivary.py init sandboxes/coding-demo --preset coding
python packages/create-vivary/create_vivary.py doctor sandboxes/coding-demo
python packages/tropo/tropo.py check --root sandboxes/coding-demo
```

---

Website & docs: <https://vivary.vercel.app/>
