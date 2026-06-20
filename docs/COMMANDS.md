# Vivary — command reference

This is the full, technical list of every command. If you're just starting, you only
need a handful (`create-vivary init`, `doctor`, `tropo check`); the [getting started
guide](/getting-started/) walks through those. Come back here for the details.

Every CLI across the four layers. All engines are zero-dependency Python (3.11+);
the CLI command names are `tropo` / `ozone` / `exo` / `create-vivary` regardless of
how you install them.

- **Install (PyPI):** `pip install vivary-tropo vivary-ozone vivary-exo create-vivary`
- **Run without installing (uv):** `uvx vivary-tropo check`, `uvx vivary-ozone review`, …
- **Scaffold (npm):** `npm create @vivary my-workspace` / `npx @vivary/create my-workspace`
- **From a repo checkout:** `python packages/tropo/tropo.py check`, etc.

Exit codes are uniform: **`0`** success · **`1`** findings/errors · **`2`** usage/config
error. Gate CI on the exit code; don't parse text. Every command takes `--json` for
machine-readable output.

---

## tropo — the typed knowledge graph

```
tropo [command] [paths...] [--lenient | --strict] [--json] [--quiet]
                [--depth N] [--out FILE] [--packs a,b] [--root DIR] [--config PATH]
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
| `view [graph \| blast <id>] [--out FILE]` | Render the graph (or one radius) as a single self-contained HTML file. |
| `plan <change.toml>` | Simulate a change (remove/retype/break/add) and show the semantic delta. |
| `fix [--dry-run]` | Strip redundant frontmatter (`W210` — a field equal to its derived value). The only mechanical edit tropo makes. |
| `init [DIR] [--packs a,b]` | Scaffold a `tropo.toml` (optionally composing reusable type packs). |

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

---

## ozone — the review layer

```
ozone [review | impact <id> | packs] [--root DIR] [--json] [--strict]
```

Where `tropo check` asks "is each document valid?", `ozone` reviews the **whole graph**
and a change's impact. It reads tropo's graph in-process (one graph, no fork).

| Command | What it does |
|---|---|
| `review` | Run the `structure` pack: relationship/completeness findings over the graph. **Advisory by default** (exit 0); `--strict` makes it a gate (exit 1 on warnings). |
| `impact <id>` | The blast radius of a node — what (transitively) depends on it, with distance + the edge field it came in by. |
| `packs` | List the available rule packs (currently `structure`). |

### The `structure` pack

| Rule | Severity | Fires when |
|---|---|---|
| `change-unverified` | warn | a `changes/` node has no `verification` edge |
| `change-ungated` | info | a `changes/` node has no `gates` edge |
| `module-unverified` | info | a `modules/` node has no `verification` edge |
| `orphan` | info | a node has no edges in or out |
| `broken-edge` | warn | an edge points at a missing node (tropo `check` enforces this) |

```bash
ozone review --root .            # advisory report
ozone review --root . --strict   # gate: exit 1 if any warning (CI / pre-merge)
ozone impact human-gates --root . --json
```

---

## exo — the coordination layer

```
exo [conflicts | board | roles] [--root DIR] [--json]
```

The outermost, thinnest layer — engaged only when one agent becomes many. Read-only and
graph-native; it doesn't run agents, it coordinates them.

| Command | What it does |
|---|---|
| `conflicts` | Among **active** work items (changes with `status: active`), flags pairs that share an outbound target — two in-flight changes touching the same node. |
| `board` | Work items grouped by `status` (and `@assignee` if the workspace declares one). |
| `roles` | The bounded worker contracts: Orchestrator · Scout · Researcher · Builder · Verifier · Reviewer · Archivist. |

```bash
exo conflicts --root .    # who would collide
exo board --root .        # what's in flight
exo roles                 # the role grammar
```

---

## create-vivary — the scaffolder

```
create-vivary init <target> [--preset coding|second-brain|writing] [--force] [--obsidian]
                           [--active-context cocoindex-code]
create-vivary doctor <target> [--json]
```

| Command | What it does |
|---|---|
| `init <target>` | Lay down a complete workspace: the agent contract, the strato shell (SOUL/USER/STATE/MEMORY), runtime skills, a `tropo.toml`, and a starter typed graph. |
| `doctor <target>` | Validate a workspace: required files, privacy ignores, module directory indexes, and tropo graph health (no broken edges). |

| Flag | Effect |
|---|---|
| `--preset coding\|second-brain\|writing` | Which starter graph to seed (default `coding`). |
| `--force` | Overwrite existing scaffold files. |
| `--obsidian` | Also drop an opt-in Obsidian vault config (graph coloured by type). Never required — see [OBSIDIAN.md](OBSIDIAN.md). |
| `--active-context cocoindex-code` | For `coding` workspaces, add an optional CocoIndex-code sidecar profile: an active-context skill, docs, graph nodes, and `.cocoindex_code/` gitignore. It does **not** auto-install, index, or enable MCP; the generated docs include the approved `ccc init` / `ccc index` path. |

```bash
create-vivary init my-workspace --preset writing
create-vivary init my-codebase --preset coding --active-context cocoindex-code
create-vivary doctor my-workspace
# expected for a plain coding workspace: doctor: ok (9 node(s), 28 edge(s), 0 broken)
```

The three presets share the same agent-OS shell and differ only by starter graph. Each
starter module is a directory index (`modules/<id>/index.md`) so AGENTS can route to a
small surface before deeper context:

| Preset | Module | First change | Verification |
|---|---|---|---|
| `coding` | `codebase` | `local-ci-baseline` | `local-checks` |
| `second-brain` | `knowledge-base` | `capture-routine` | `retrieval-smoke` |
| `writing` | `manuscript-system` | `draft-review-loop` | `editorial-review` |

---

See [GETTING-STARTED.md](GETTING-STARTED.md) for a first run, [HOWTO.md](HOWTO.md) for
task recipes, [SKILLS.md](SKILLS.md) for the agent skills, and [FAQ.md](FAQ.md).
