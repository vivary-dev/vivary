# Getting started with Vivary

Vivary is a lightweight, local-first governed-context layer for agent work. It gives a
project one bounded context capsule, one visible state surface, provenance and
verification hooks, and deliberate human gates. It does not require a particular
editor, agent runtime, database, memory provider, or MCP client.

> **Release truth:** the five-file workflow on this page describes the
> unpublished 0.4.0 development source. Registry `@latest` is still 0.3.1 and
> creates the historical full layout. During release review, run the scaffolder
> from a Vivary checkout or an isolated candidate artifact; do not substitute an
> unpinned registry command. The [README release table](../README.md#release-status)
> is the publication authority.

## Set up with an agent

Paste this into Claude Code, Codex, Cursor, or another coding agent:

```text
Set up Vivary in this project.

1. Confirm Python 3.11+ and the Vivary 0.4.0 candidate command route described below are available. Do not install anything without approval or substitute registry latest while it remains 0.3.1.
2. If this folder already has content, run `create-vivary adopt . --json`. Show me the exact creates, bounded patches, optional projections, kept files, conflicts, privacy result, and plan_hash. Stop on any conflict. Apply only the exact approved plan with `--yes --plan <plan_hash>`.
3. If this folder is empty, ask which preset fits (coding, second-brain, knowledge-work, or writing), then run `create-vivary init . --preset <choice>`.
4. Verify with `create-vivary doctor .` and `tropo check --root .`. Both must pass.
5. Read AGENTS.md and .vivary/context.md. Read STATE.md only when current state matters.
```

## 1. Install

You need Python 3.11 or newer. To inspect the 0.4.0 candidate from this repository
without changing an installed tool, call its entry points directly:

```bash
python packages/create-vivary/create_vivary.py --help
python packages/tropo/tropo.py --help
```

When operating on another folder, replace `create-vivary` and `tropo` in the
examples below with those absolute source-script paths, or use an isolated release
candidate environment. The optional MCP package has third-party runtime dependencies;
verify its `vivary-mcp --help` entry point only inside the isolated candidate
environment where its wheel is installed. Published 0.3.1 remains available for the previous layout
with `uvx --from create-vivary==0.3.1 create-vivary ...` or
`npx @vivary/create@0.3.1 ...`. Do not expect those pinned commands to produce the
five-file seed.

## 2. Create a new workspace

```bash
create-vivary init my-workspace --preset coding
cd my-workspace
```

The preset selects configuration for `coding`, `second-brain`, `knowledge-work`, or
`writing`. A preset changes thin policy only. In particular, `second-brain` does not
install a pre-populated second brain, starter notes, or framework records.

Default init creates exactly five files:

```text
AGENTS.md                 bounded startup route
STATE.md                  visible Focus / Status / Next surface
.gitignore                bounded private/runtime ignore block
.vivary/context.md        first governed context capsule
.vivary/workspace.toml    thin workspace contract and policy
```

No templates, skills, placeholders, starter records, or framework prose are copied.
Records under `.vivary/records/` appear only when real work earns them. Private
material belongs under `.vivary/private/` and runtime state under `.vivary/runtime/`;
both are ignored.

Optional runtime projections are explicit and bounded:

```bash
create-vivary init my-workspace --preset coding --adapter agents
create-vivary init my-workspace --preset coding --adapter claude
create-vivary init my-codebase --preset coding --active-context cocoindex-code
```

Each agent adapter adds one file of at most 1,200 bytes. Active context keeps the
five-file seed and declares `cocoindex-code` in `.vivary/workspace.toml`. It also
ignores `.cocoindex_code/`; it does not copy guidance, install an indexer, create an
index, enable MCP, or send source text anywhere.
Configure Obsidian or another editor separately after initialization.

Storage and semantic memory are separate opt-ins. A non-interactive init without
explicit storage or memory options stays file-backed and writes no optional provider
config. Provider installation, indexing, network access, and credentials remain later
human gates.

### Adopt an existing repo or vault

Brownfield adoption is dry-run first:

```bash
create-vivary adopt . --json
create-vivary adopt . --yes --plan sha256:<plan-hash> --json
```

The plan is deterministic and reports `creates`, managed `patches`,
`optional_projections`, `kept`, `conflicts`, privacy checks, and `plan_hash`. Apply
accepts only the exact approved hash and revalidates the inputs before writing.

Adoption creates at most three Vivary payload files:

- `.vivary/context.md`
- `.vivary/workspace.toml`
- `STATE.md`, only when it is absent

Separately, it may create or patch only the generated Vivary blocks in `AGENTS.md` and
`.gitignore`. User-owned content outside those blocks is kept. Nested ignore rules
that expose private paths, stale or divergent generated adapters, invalid thin
contracts, and changed plan inputs are conflicts that fail closed.

Apply is transactional. If a process is interrupted, the next run reports the bound
adoption hash. Plan recovery before any rollback:

```bash
create-vivary adopt . --recover sha256:<plan-hash> --json
```

Review `recovery_plan_hash` and its bounded actions. Apply only that separately
approved recovery plan:

```bash
create-vivary adopt . --recover sha256:<plan-hash> \
  --yes --plan sha256:<recovery-plan-hash> --json
```

## 3. Verify

```bash
create-vivary doctor .
tropo check --root .
```

Doctor validates the thin contract, startup reachability, privacy, optional adapters,
and pending adoption recovery. Plain Doctor is read-only. `doctor --trend` is the
explicit mode that writes local runtime trend state.

Tropo reads `.vivary/workspace.toml` as the base policy and returns small typed context
packets:

```bash
tropo find "where is release truth owned" --root . --json
tropo graph --root . --json
```

A root or nested `tropo.toml` can tighten thin policy but cannot expand its scope.
Competing thin workspace roots fail closed.

## 4. Operate the loop

The compact operating loop is:

> Ask → retrieve → act → verify → learn → gate.

Start with `AGENTS.md` and `.vivary/context.md`; load `STATE.md` when the current focus
or next action matters. Create a receipt or record only when it is evidence from real
work. Stop at authority, privacy, destructive, publishing, credential, or deliberate
human-approval gates.

MCP is optional. The Vivary adapter uses local standard input/output and is read-only
by default; every baseline workflow remains available through the CLI. Install and
start it separately, binding the workspace at operator-controlled startup:

```bash
vivary-mcp --workspace project .
```

Its four tools can find, query, check, and return a public Task Capsule. Starting it or
calling those tools does not create `.vivary/records/`, enable a provider, or authorize
a write. A fresh non-Git thin workspace is readable only while its `.gitignore` is the
exact generated private/runtime block; arbitrary or extended non-Git ignore policy
fails closed. Once the folder is an exact Git worktree, Git's effective ignore policy
is authoritative.

When verified work earns a durable record, keep the read and write authorities
separate:

1. Save the complete JSON Task Capsule from `tropo find --governed --json`, or save
   the complete public capsule object returned as the optional MCP `vivary_capsule`
   result.
2. Prepare one complete typed Markdown record outside the destination.
3. Run `create-vivary record` without `--yes`, inspect its one-file plan and hash, and
   get the deliberate human approval required for the write.
4. Apply only that exact hash with `--yes --plan`; Doctor verifies the workspace and
   the command rolls back the record if verification fails.

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

This creates or updates exactly one record under `.vivary/records/`; it never expands
the selected preset into a template pack or a pre-populated graph.

## Next

- [Guide library](LEARN-BY-DOING.md) — complete one real task with a concise STE100 style procedure.
- [Concepts](/concepts/) — the governed-context vocabulary.
- [Command reference](/commands/) — commands, flags, outputs, and exit codes.
- [Active context](/active-context/) — the optional code-retrieval projection.
- [Architecture](/architecture/) — ownership and package boundaries.
- [MCP](/mcp/) — the optional local read-only adapter.
