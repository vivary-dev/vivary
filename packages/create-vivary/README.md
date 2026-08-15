# create-vivary

`create-vivary` installs Vivary's lightweight, local-first governed-context contract.
It gives agents one visible state surface, a bounded context capsule, provenance and
verification hooks, and deliberate human gates without copying a framework into the
workspace.

Published and development version truth lives in the
[root release status](https://github.com/vivary-dev/vivary/blob/dev/README.md#release-status).
The unpublished source candidates are `create-vivary 0.4.2` and
`@vivary/create 0.4.2`; both require `vivary-tropo>=0.5.3`.

Published registry commands pin **0.3.1**. Unpinned `uvx create-vivary` is not a
stranger install path while unpublished 0.4.2 remains off the registry.

## New workspaces

```bash
uvx --from create-vivary==0.3.1 create-vivary init my-workspace --preset coding --no-wizard
uvx --from create-vivary==0.3.1 create-vivary doctor my-workspace --json
uvx --from vivary-tropo==0.4.1 tropo check --root my-workspace
```

Published 0.3.1 writes the full-layout scaffold, not the unpublished five-file seed.

## Unpublished 0.4.2 source

The rest of this package README describes checkout behavior. It is not what
registry 0.3.1 writes.

A default greenfield 0.4.2 init creates exactly five files:

- Vivary payload: `.vivary/context.md`, `.vivary/workspace.toml`, and `STATE.md`.
- Host integration: `AGENTS.md` and `.gitignore`.

It does not copy templates, runtime skills, placeholders, starter records, or
framework prose. `--adapter agents` and `--adapter claude` add at most one bounded
adapter file each. `--active-context cocoindex-code` is also explicit but keeps the
five-file seed: it declares the capability and ignores `.cocoindex_code/`. It does not
copy guidance, install CocoIndex-code, create an index, enable MCP, or send source.

Storage and semantic-memory config remain explicit options. Non-interactive init
without those options stays file-backed and writes no optional provider config.
Obsidian setup is no longer scaffolded by thin init; configure the editor separately.

## Existing repositories and vaults

Adoption is a deterministic dry-run/apply transaction:

```bash
create-vivary adopt . --json
create-vivary adopt . --yes --plan sha256:<plan-hash> --json
# After an interrupted transaction only:
create-vivary adopt . --recover sha256:<plan-hash> --json
create-vivary adopt . --recover sha256:<plan-hash> \
  --yes --plan sha256:<recovery-plan-hash> --json
```

The preview reports `creates`, managed `patches`, `optional_projections`, `kept`,
`conflicts`, privacy checks, and `plan_hash`. Apply accepts only that exact plan and
revalidates kept files before writing.
The first recovery command is read-only. It returns the exact recovery plan hash that
must receive separate approval before the second command rolls the transaction back.

Brownfield adoption is capped at three Vivary payload creates: `.vivary/context.md`,
`.vivary/workspace.toml`, and `STATE.md` when it is absent. Independently, adoption may
create or patch the bounded Vivary blocks in `AGENTS.md` and `.gitignore`. It never
copies templates, skills, starter graph records, or placeholders, and it never
overwrites arbitrary user content. Conflicts fail closed.

Privacy is checked before payload writes. Apply uses a local transaction journal and
exact-byte backups so an ordinary failure rolls back and an interrupted transaction
can be recovered explicitly.

## Doctor and compatibility

`doctor` validates thin workspace metadata, the context capsule, startup reachability,
privacy rules, optional adapters, and pending adoption recovery. Plain Doctor is
read-only; `--trend` is the explicit mode that writes runtime trend state.

Doctor also reads older full Vivary workspaces without migrating or regenerating
them. Its versioned compatibility report uses `schema_version = 2`: new workspaces
report `workspace_contract = "thin-v0.3"`; old workspaces report
`workspace_contract = "legacy-full"` plus their detected legacy layout.

Tropo resolves `.vivary/workspace.toml` as the thin base policy. A root or nested
`tropo.toml` may tighten that policy but may not expand its scope. Competing thin roots
fail closed.

MCP is optional. When selected, it is local stdio and read-only by default.

## One earned record

Vivary can maintain the minimal workspace without turning MCP into a write surface.
After governed Tropo returns a full Task Capsule JSON—or the optional
`vivary_capsule` MCP tool returns its public projection—save that complete capsule
object, prepare one typed Markdown file, and preview a capsule-bound plan:

```bash
create-vivary record . changes/verified-slice.md \
  --from ./verified-slice.md \
  --capsule ./task-capsule.json \
  --json

create-vivary record . changes/verified-slice.md \
  --from ./verified-slice.md \
  --capsule ./task-capsule.json \
  --yes --plan sha256:<approved-plan-hash> --json
```

The first call is read-only and verifies the capsule's canonical integrity, exact
workspace scope or fingerprint, and current workspace state. The second creates or
updates exactly one validated record
under `.vivary/records/`, reruns Doctor, and rolls back on failure. There is no batch,
starter-pack, or automatic second-brain materialization mode. An optional
`--receipt .vivary/runtime/receipts.jsonl` records only privacy-preserving command
metadata.

## Other commands

```bash
create-vivary capabilities --preset coding --json
create-vivary doctor . --receipt .vivary/receipts.jsonl
create-vivary wizard . --storage embedded --yes --json
```

Local receipts contain command-envelope metadata only. They do not capture stdout,
stderr, file contents, target paths, preset values, or environment variables.

The `@vivary/create` npm package is a shell-free launcher that forwards arguments to
this Python implementation. Python 3.11+ is required.

## Development

```bash
python packages/create-vivary/tests/test_adopt.py
python packages/create-vivary/tests/test_init_thin.py
python packages/create-vivary/tests/test_record_workflow.py
python packages/create-vivary/tests/test_create_vivary.py
python packages/tropo/tropo.py check --root <workspace>
```

Website and docs: <https://vivary.vercel.app/>
