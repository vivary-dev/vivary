# Vivary — active context

Active context is an optional sidecar pattern for Vivary-backed codebases. The simple
mental model is:

> Vivary routes the work. CocoIndex-code helps find fuzzy source-code candidates.

The baseline remains small and deterministic: `tropo` owns the typed graph, `strato`
owns the agent loop, and no index, daemon, embedding model, or MCP server is enabled by
default.

For coding workspaces, `create-vivary` can declare the CocoIndex-code capability:

```bash
create-vivary init my-workspace --preset coding --active-context cocoindex-code
```

This keeps the exact five-file Core seed. It changes only existing policy:

- `.vivary/workspace.toml` declares `cocoindex-code` and excludes its local index;
- `.gitignore` ignores `.cocoindex_code/`.

Tropo and Doctor fail closed if either privacy rule is missing or negated. Brownfield
adoption carries the declared capability through its exact plan hash and recovery
journal, so a missing or host-owned `.gitignore` receives the same private-index rule.

It does not copy a skill, guide, graph node, starter record, template, or framework
router into the new workspace. Use this canonical guide when setup is later approved.

The declaration does **not** install CocoIndex-code, initialize an index, run
embeddings, enable MCP, or send source text anywhere. Those are explicit gates after
the user approves active context. For copy/paste agent instructions, use
[LLM-ACTIVE-CONTEXT.md](LLM-ACTIVE-CONTEXT.md).

## The Rule

Agents ask before using active context unless the workspace already has explicit
approval. Installing, initializing, indexing, enabling MCP, and using external
embedding providers are Vivary gates.

## When CocoIndex-code Helps

Use it when semantic retrieval is likely to beat raw text search:

- a large or unfamiliar codebase;
- implementation questions where exact names are unknown;
- cross-module flows, feature tracing, refactors, or review;
- `rg` returns too much, too little, or only naming coincidences;
- the user explicitly asks for CocoIndex, `ccc`, semantic code search, or active
  context.

Skip it when the exact file/string is known, the codebase is tiny, the source
sensitivity is unknown, or the task is about Vivary graph truth rather than source-code
semantics.

## Retrieval Order

1. Ask Vivary what to open first: `tropo find "<task>" --budget 1200 --json`.
2. Use graph truth for ids, types, edges, and blast radius: `tropo graph`,
   `tropo blast <id>`, `ozone impact <id>`.
3. Use CocoIndex-code only for fuzzy code candidates:
   `ccc search --refresh "<query>"`.
4. Read matched files directly before acting.
5. Verify with project tests and Vivary checks before a gate.

## Install And Prove It

Useful commands after approval:

```bash
uv tool install --python 3.11 --upgrade "cocoindex-code[full]"
ccc init -f
ccc doctor
ccc index
ccc status
ccc search --refresh "authentication flow"
ccc search --path "src/db.py" "database connection pool"
codex mcp add cocoindex-code -- ccc mcp
```

When filtering with `ccc search --path`, prefer an exact indexed path such as
`src/db.py`. Broad folder globs like `src/*` or `docs/*` can return no results even
when matching files are indexed; run the query without `--path` first if you need to
discover the exact path.

On non-interactive Windows agent runs, drive init through stdin so it chooses the
local sentence-transformers default instead of opening an interactive prompt:

```powershell
cmd /c "echo. | ccc init -f"
```

The sidecar should report the query, refresh status, useful file paths/line ranges,
files read, and how the semantic hits changed or confirmed the graph-based context.
