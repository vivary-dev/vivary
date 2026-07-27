# create-vivary

Scaffold a complete Vivary agent workspace: tropo config, strato workspace files,
runtime skills, private-memory boundaries, progressive module indexes, and a starter
typed graph.

**Current release:** 0.3.1. Use 0.3.1 for new installs; no migration is expected
from 0.2.1, 0.2.2, 0.2.3, 0.2.5, 0.2.6, 0.2.7, or 0.2.8.

**Release focus:** 0.3.1 is the adoption line: brownfield `create-vivary adopt <path>`
brings Vivary into an existing repo or vault without touching existing files
(dry-run by default, `--yes` to write), and `doctor --trend` tracks graph and
routing drift across runs in `.vivary/doctor-state.json`.

**Security hardening:** The 0.2.5 line validates active `.gitignore` rules for `USER.md`,
`MEMORY.md`, `memory/*`, and `heartbeat-reports/*`; scaffolds private heartbeat report
storage; and refuses symlinked or out-of-workspace scaffold, storage, and cleanup
paths.

## Install & scaffold

```bash
pip install create-vivary==0.3.1              # or: uvx create-vivary@0.3.1 ...
create-vivary my-workspace --preset coding    # interactive wizard on a TTY
create-vivary my-workbench --preset knowledge-work --memory local
create-vivary my-codebase --preset coding --active-context cocoindex-code
create-vivary capabilities --preset second-brain --json
create-vivary doctor my-workspace
create-vivary doctor my-workspace --receipt .vivary/receipts.jsonl

# Agent-mode (no prompts, machine-readable output):
create-vivary init . --preset coding --auto --size large --yes --json

# Reconfigure storage on an existing workspace:
create-vivary wizard my-workspace --auto --storage embedded --yes --json

# Preview brownfield adoption without writing:
create-vivary adopt .
```

`create-vivary <name>` is shorthand for `create-vivary init <name>`; pass `init` /
`doctor` / `wizard` / `capabilities` / `adopt` explicitly whenever you prefer. The
`@vivary/create` npm launcher forwards argv unchanged to this Python CLI, which owns
that command recognition and normalization; both packages are versioned in lockstep.

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

For local debugging, pass `--receipt PATH` or set `VIVARY_RECEIPT_LOG=PATH` to append
a dependency-free JSONL run receipt. Receipts stay local and record only command
envelope data such as tool version, command, flag names, exit code, duration, Python,
and platform; they do not capture stdout, stderr, file contents, preset values,
target paths, or environment variables.

Semantic memory is a separate optional capability. `--memory local` writes local-only
policy and graph nodes; `--memory cognee` writes Cognee policy and verification docs.
Neither option indexes content or sends data anywhere during scaffold, and Cognee is
not installed by default. The optional `vivary-memory-cognee` adapter package can run
`vivary-cognee doctor`, `index`, `recall`, and `forget` after an explicit install and
index approval. Use `create-vivary capabilities --preset <name> --json` to show agents
the available optional pieces before setup.

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
python packages/create-vivary/create_vivary.py doctor sandboxes/coding-demo --repair --json
```

In source builds and the next package release, `doctor --repair --json` previews a
guided repair plan without writing. After approval, `doctor --repair --yes`
regenerates missing ignored private placeholders, appends missing privacy ignore
lines, removes simple W210 redundant metadata, and reruns doctor. Non-workspace,
symlinked, junctioned, hardlinked, non-file, or non-UTF-8 repair targets are refused
or kept manual. Complex YAML W210 cases, broken refs, and exo conflicts stay manual
guidance.

## Developing from source

```bash
python packages/create-vivary/create_vivary.py init sandboxes/coding-demo --preset coding
python packages/create-vivary/create_vivary.py doctor sandboxes/coding-demo
python packages/tropo/tropo.py check --root sandboxes/coding-demo
```

---

Website & docs: <https://vivary.vercel.app/>
