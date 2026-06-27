# Vivary — command reference

This is the full, technical list of every command. If you're just starting, you only
need a handful (`create-vivary init`, `doctor`, `tropo check`); the [getting started
guide](/getting-started/) walks through those. Come back here for the details.

Every CLI across the four layers. All engines are zero-dependency Python (3.11+);
the CLI command names are `tropo` / `ozone` / `exo` / `create-vivary` regardless of
how you install them.

- **Install (PyPI):** `pip install vivary-tropo vivary-ozone vivary-exo create-vivary==0.2.8`
- **Run without installing (uv):** `uvx vivary-tropo check`, `uvx vivary-ozone review`, …
- **Scaffold (npm):** `npm create @vivary@latest my-workspace` / `npx @vivary/create@latest my-workspace`
- **From a repo checkout:** `python packages/tropo/tropo.py check`, etc.

Exit codes are uniform: **`0`** success · **`1`** findings/errors · **`2`** usage/config
error. Gate CI on the exit code; don't parse text. Every command takes `--json` for
machine-readable output.

**The CLI is the agent API.** Every command an agent needs to run Vivary is here — no
MCP server, no special protocol. Commands that interact or install also accept `--yes`
(auto-confirm all prompts), `--auto` (agent selects from explicit storage/privacy/size
hints), and `--dry-run` (inspect without side effects). See
[SPEC-data-layer.md](SPEC-data-layer.md) for the full agent CLI contract and the new
storage/migration commands.

---

## tropo — the typed knowledge graph

```
tropo [command] [paths...] [--lenient | --strict] [--json] [--quiet]
                [--depth N] [--out FILE] [--packs a,b] [--root DIR] [--config PATH]
                [--type TYPE] [--path GLOB] [--edge FIELD[:TARGET]]
                [--snippet N] [--explain] [--budget N]
```

A document's **type is the folder it lives in** (`decisions/0001.md` → type
`decision`). Metadata is only what can't be derived from where a file sits and what it
says. `tropo.toml` declares the types.

| Command | What it does |
|---|---|
| `check [paths]` | Validate frontmatter + the graph. **Opinionated: warnings fail by default.** Default command. |
| `signal [paths]` | Print only the *irreducible* metadata per doc — the literal signal, noise stripped. |
| `types` | Print the resolved, merged type registry. |
| `stats` | Document counts per type + a health summary. |
| `graph [--json]` | Emit the typed graph: nodes (`id`,`type`,`path`) + edges (`from`,`field`,`to`,`broken`). |
| `blast <id> [--depth N]` | The **blast radius** of `<id>`: everything that (transitively) refs it — what a change could touch. |
| `view [graph \| blast <id>] [--out FILE]` | Render the graph (or one radius) as a single self-contained HTML file. `--out` must stay inside the tropo root, refuse symlink targets, and rewrite the workspace output path without mutating hard-linked files outside the workspace. |
| `plan <change.toml>` | Simulate a change (remove/retype/break/add) and show the graph delta. |
| `fix [--dry-run]` | Strip redundant frontmatter (`W210` — a field equal to its derived value). The only mechanical edit tropo makes. |
| `init [DIR] [--packs a,b]` | Scaffold a `tropo.toml` (optionally composing reusable type packs). |
| `find <text> [--budget N] [--k N] [--json]` | Human-friendly context packet: the smallest typed nodes/files worth opening first, with reasons and snippets trimmed to an approximate token budget. |
| `query <text> [--k N] [--type TYPE] [--path GLOB] [--edge FIELD[:TARGET]] [--snippet N] [--explain] [--json]` | Filtered graph search over typed nodes. Searches id/title, frontmatter, path, body, and outbound edge context, then returns real graph ids/types/paths. |
| `migrate --from file --to embedded [--dry-run] [--json]` | Move file-backed graph data into the configured embedded backend. Cloud migration, non-file sources, backend installation, and `migrated_at` tracking are future 0.3.x work. |

`tropo find` is the default "what should I read first?" command for humans and agents.
`tropo query` is the lower-level filtered search primitive. Both are graph/text
retrieval, not the CocoIndex active-context sidecar. Use `create-vivary init ...
--active-context cocoindex-code` when a coding workspace needs semantic code
candidates.

Useful retrieval flags:

| Flag | Effect |
|---|---|
| `--type TYPE` | Restrict to a document type; repeat for multiple allowed types. |
| `--path GLOB` | Restrict to path globs such as `decisions/*`; repeatable and slash-normalized for Windows paths. |
| `--edge FIELD[:TARGET]` | Require an outbound graph edge field, optionally pointing at a target id. |
| `--snippet N` | Include up to `N` snippet characters per result; `0` disables snippets. |
| `--explain` | Include stable match reasons such as title/id, frontmatter, path, body, or edge context. |
| `--budget N` | `find` only: approximate token budget for the returned context packet. |

```bash
tropo find "where is release truth owned" --root . --budget 800 --json
tropo query "release truth" --type decision --path "decisions/*" --explain --json
tropo query "agent workspace" --edge affects:agent-workspace
```

### Strictness (the `check` gate)

`check` is **strict by default** — untyped docs, unknown fields, broken refs, and
redundant frontmatter all fail it. Relax when you need to:

```bash
tropo check                 # strict: any warning fails (exit 1)
tropo check --lenient       # warnings shown, exit 0
tropo check --quiet         # hide warnings, errors only
```

Or persistently per vault, in `tropo.toml`: `[base] strict = false`. `--strict` forces
it back on (overrides a lenient config). `strict` is *tighten-only* across nested
configs — a sub-folder may turn it on, never off.

### Finding codes

| Code | Level | Meaning |
|---|---|---|
| `E000` | error | file can't be read |
| `E001` | error | frontmatter isn't valid YAML / not a mapping |
| `E101` | error | required field missing for the type |
| `E102` | error | required field is empty |
| `E103` | error | field value violates its type spec |
| `W201` | warn | untyped document (no ancestor folder is a registered type) |
| `W202` | warn | unknown field for the type (typo? add it to the schema) |
| `W210` | warn | field equals its derived value (noise — run `tropo fix`) |
| `W220` | warn | ref points at no document id (broken edge) |

(Under the default strict mode, every `W2xx` fails the check.)

### `tropo.toml`

```toml
[base]
derive       = ["id", "title", "created", "updated"]   # never required, never noise
optional     = { tags = "string-list", status = "string" }   # any doc MAY carry these
allow_untyped = true     # W201 instead of error for files outside any type root
strict        = true     # warnings fail check (the opinionated default)
timezone      = "local"

packs = ["dev-project"]  # compose reusable type bundles

[types.decision]         # table key = the TYPE name
folder   = "decisions"   # the directory basename that roots it
required = { status = "enum:proposed|accepted|superseded", date = "date" }
optional = { supersedes = "ref", related_modules = "ref-list" }
```

Field specs: `string`, `slug`, `date`, `datetime`, `url`, `string-list`, `any`,
`enum:a|b|c`, and the graph types **`ref`** / **`ref-list`** (these become edges).

Built-in packs: `dev-project`, `repo-graph`, and `coordination`. Local
`.tropo/packs/<name>.toml` files take precedence over bundled packs. Use
`coordination` when exo should be allowed to write `assignee`:

```toml
packs = ["repo-graph", "coordination"]
```

---

## ozone — the review layer

```
ozone [review | impact <id> | packs] [--root DIR] [--json] [--strict]
      [--pack structure|context-budget|all]
```

Where `tropo check` asks "is each document valid?", `ozone` reviews the **whole graph**
and a change's impact. It reads tropo's graph in-process (one graph, no fork).

| Command | What it does |
|---|---|
| `review` | Run a deterministic review pack. Defaults to `--pack structure` for stable CI; use `--pack context-budget` for context bloat or `--pack all` for every pack. **Advisory by default** (exit 0); `--strict` makes it a gate (exit 1 on warnings). |
| `impact <id>` | The blast radius of a node — what (transitively) depends on it, with distance + the edge field it came in by. |
| `packs` | List the available rule packs. |

### The `structure` pack

| Rule | Severity | Fires when |
|---|---|---|
| `change-unverified` | warn | a `changes/` node has no `verification` edge |
| `change-ungated` | info | a `changes/` node has no `gates` edge |
| `module-unverified` | info | a `modules/` node has no `verification` edge |
| `orphan` | info | a node has no edges in or out |
| `broken-edge` | warn | an edge points at a missing node (tropo `check` enforces this) |

### The `context-budget` pack

`context-budget` reviews only public routing/startup surfaces:
`AGENTS.md`, `CLAUDE.md`, `STRATO.md`, `STATE.md`, `SOUL.md`, `README.md`,
`modules/index.md`, and `modules/*/index.md`. It does not read private memory files
such as `USER.md`, `MEMORY.md`, `memory/**`, heartbeat reports, `.vivary/**`, or
`.git/**`.

| Rule | Severity | Fires when |
|---|---|---|
| `module-index-missing` | warn | a `modules/<name>/` directory has no `index.md` |
| `legacy-module-file` | warn | `modules/<name>.md` coexists with `modules/<name>/index.md` |
| `always-on-large` | info | a root routing contract exceeds its fixed line/char threshold |
| `module-index-large` | info | `modules/index.md` or `modules/*/index.md` exceeds 120 lines or 8000 chars |
| `bulk-load-cue` | info | public routing text tells agents to read/load/scan/open whole repos, docs trees, folders, or everything |
| `duplicate-routing-block` | info | an exact normalized routing block over 100 chars repeats across public routing surfaces |

```bash
ozone review --root .            # advisory report
ozone review --root . --strict   # gate: exit 1 if any warning (CI / pre-merge)
ozone review --root . --pack context-budget
ozone review --root . --pack all --json
ozone impact human-gates --root . --json
```

---

## exo — the coordination layer

```
exo [conflicts | board | claim <id> --agent <handle> | roles] [--root DIR] [--json]
```

The outermost, thinnest layer — engaged only when one agent becomes many. Graph-native
and deterministic; it doesn't run agents, it coordinates them. `claim` is the only
writer, and it refuses to write unless the workspace declares `assignee` through
`packs = ["coordination"]`.

| Command | What it does |
|---|---|
| `conflicts` | Among **active** work items (changes with `status: active`), flags pairs that share an outbound target — two in-flight changes touching the same node. |
| `board` | Work items grouped by `status` (and `@assignee` if the workspace declares one). |
| `claim <id> --agent <handle>` | Claim a work item under `changes/` by setting top-level `assignee`; optional leading `@` is accepted and stripped before storage. Refuses symlinked or out-of-workspace work item files and replaces the workspace file instead of truncating hard-linked targets. |
| `roles` | The bounded worker contracts: Orchestrator · Scout · Researcher · Builder · Verifier · Reviewer · Archivist. |

```bash
exo conflicts --root .    # who would collide
exo board --root .        # what's in flight
exo claim local-ci-baseline --agent connie --root .
exo roles                 # the role grammar
```

JSON output for `claim` includes `id`, `path`, `assignee`, `previous_assignee`, and
`changed`.

---

## create-vivary — the scaffolder

```
create-vivary init <target> [--preset coding|second-brain|knowledge-work|writing] [--force] [--obsidian]
                           [--active-context cocoindex-code]
                           [--storage auto|file|embedded|cloud] [--provider lancedb|sqlite-vec|qdrant|astra]
                           [--memory none|local|cognee]
                           [--auto] [--yes] [--dry-run] [--json]
                           [--size small|medium|large] [--privacy local|cloud]
create-vivary wizard <target> [--storage auto|file|embedded|cloud] [--provider lancedb|sqlite-vec|qdrant|astra]
                              [--memory none|local|cognee] [--yes] [--dry-run] [--json]
create-vivary capabilities [--preset coding|second-brain|knowledge-work|writing] [--json]
create-vivary doctor <target> [--json]
```

| Command | What it does |
|---|---|
| `init <target>` | Lay down a complete workspace: the agent contract, the strato shell (SOUL/USER/STATE/MEMORY), runtime skills, a `tropo.toml`, a starter typed graph, and optional storage or semantic-memory config based on flags/wizard answers. |
| `wizard <target>` | Re-run the setup wizard on an existing workspace to reconfigure storage and optional semantic-memory policy. |
| `capabilities` | List optional capabilities for a preset: storage, semantic memory, and preset-specific sidecars. |
| `doctor <target>` | Validate a workspace: required files, active privacy ignore rules, module directory indexes, tropo graph health, backend reachability, and semantic-memory status. |

| Flag | Effect |
|---|---|
| `--preset coding\|second-brain\|knowledge-work\|writing` | Which starter graph to seed (default `coding`). |
| `--force` | Overwrite existing scaffold files and remove stale generated files, but still refuses symlinked destination parents or paths that resolve outside the target workspace. |
| `--obsidian` | Also drop an opt-in Obsidian vault config (graph coloured by type). |
| `--active-context cocoindex-code` | For `coding` workspaces, add CocoIndex-code sidecar profile (skill, docs, graph nodes, gitignore). Does not auto-install or enable MCP. |
| `--storage auto\|file\|embedded\|cloud` | Storage backend to configure. `auto` = LanceDB locally. Default: `file` (no new deps). Cloud writes config only; the tropo cloud backend is future 0.3.x work. |
| `--provider lancedb\|sqlite-vec\|qdrant\|astra` | Which implementation to use for the selected tier. `lancedb` is the shipped embedded provider. |
| `--memory none\|local\|cognee` | Optional semantic-memory policy. Default: `none`. `local` writes local-only policy. `cognee` writes gated Cognee policy and graph docs, but does not install Cognee or index content. |
| `--auto` | **Agent mode.** Skip all interactive prompts; pick the best option from explicit `--storage`, `--privacy`, and `--size` hints. |
| `--yes` | Auto-confirm installs and confirmations. Safe to combine with `--auto` for fully non-interactive agent use. |
| `--dry-run` | Print what would be scaffolded and installed; do not write, install, or clean stale files. |
| `--json` | Machine-readable output. Reports `ok`, `root`, `preset`, `storage`, `provider`, `memory`, capability metadata, `installed`, `files`, config paths, and `dry_run`. |
| `--size small\|medium\|large` | Hint for `--auto` storage decisions. Agents can pass this after inspecting the repo. |
| `--privacy local\|cloud` | Hint for `--auto` storage decisions. |

`doctor` checks that `USER.md`, `MEMORY.md`, `memory/*`, and `heartbeat-reports/*`
are actively ignored. Comments, negations, and unrelated patterns that merely contain
those names do not count. If `.vivary/memory.toml` exists, `doctor` reports semantic
memory as `disabled`, `healthy`, `configured`, `unavailable`, `misconfigured`, or
`privacy-failed` without requiring optional Cognee support to be installed.

When `--storage embedded` (or `auto`) is selected and `vivary-tropo[embedded]` is not yet installed, `init` installs it via `pip` before continuing unless `--dry-run` is set. In `--json` mode, `"installed": ["lancedb"]` reports what was added. Without `--yes`, a single confirmation prompt fires before any pip install. For scripted storage selection, pass `--no-wizard --storage embedded --yes` or use `--auto`; in human mode, the wizard asks and its answers drive storage. `--auto` never selects Cognee by itself.

## vivary-cognee

`vivary-cognee` ships from the optional `vivary-memory-cognee` package. It is not part
of core Vivary and does not run unless a workspace explicitly configures
`--memory cognee`, installs the adapter, and approves provider writes.

```bash
vivary-cognee doctor --root . [--json]
vivary-cognee index --root . [--dry-run] [--yes] [--json]
vivary-cognee recall "<query>" --root . [--k N] [--json]
vivary-cognee forget --root . --yes [--json]
```

| Command | What it does |
|---|---|
| `doctor` | Reports Cognee adapter readiness, typed node count, manifest path, and stale/healthy/unavailable status. |
| `index` | Builds privacy-filtered typed Tropo node packets and sends them to Cognee. Requires `--yes` unless `--dry-run` is set. |
| `recall <query>` | Calls Cognee recall, then returns only hits that contain known Vivary node ids from the current typed graph. |
| `forget` | Removes the workspace dataset from Cognee provider memory. Requires `--yes`. |

The adapter uses `tropo` graph truth for ids, types, paths, and edges. Provider state
under `.vivary/memory/cognee/` is rebuildable cache, not source truth.

```bash
# Human flow — interactive wizard:
create-vivary init my-workspace

# Agent flow — fully non-interactive:
create-vivary init . --preset coding --auto --size large --privacy local --yes --json

# Inspect available optional pieces for a preset:
create-vivary capabilities --preset knowledge-work --json

# Inspect without doing anything:
create-vivary init my-workspace --auto --dry-run --json

# Existing examples:
create-vivary init my-workspace --preset knowledge-work --memory local
create-vivary init my-workspace --preset writing
create-vivary init my-notes --preset second-brain --memory cognee --no-wizard --dry-run --json
create-vivary init my-codebase --preset coding --active-context cocoindex-code
create-vivary doctor my-workspace
# expected for a plain coding workspace: doctor: ok (9 node(s), 28 edge(s), 0 broken)
```

The four presets share the same agent-OS shell and differ only by starter graph. Each
starter module is a directory index (`modules/<id>/index.md`) so AGENTS can route to a
small surface before deeper context:

| Preset | Module | First change | Verification |
|---|---|---|---|
| `coding` | `codebase` | `local-ci-baseline` | `local-checks` |
| `second-brain` | `knowledge-base` | `capture-routine` | `retrieval-smoke` |
| `knowledge-work` | `workbench` + `sources` | `workbench-first-artifact` | `workbench-proof` |
| `writing` | `manuscript-system` | `draft-review-loop` | `editorial-review` |

---

See [GETTING-STARTED.md](GETTING-STARTED.md) for a first run, [HOWTO.md](HOWTO.md) for
task recipes, [SKILLS.md](SKILLS.md) for the agent skills, and [FAQ.md](FAQ.md).
