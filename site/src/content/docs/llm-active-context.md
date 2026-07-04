---
title: "LLM active-context guide"
description: "Copyable agent instructions for graph-first CocoIndex-code retrieval."
---


Copy this into an agent when a Vivary coding workspace was created with
`--active-context cocoindex-code`.

## Rule

Keep context small. Use Vivary's typed graph first. Use CocoIndex-code only for fuzzy
source-code search when exact file names or symbols are unknown.

## Before Using CocoIndex-code

Ask before any install, index, daemon, MCP setup, or external embedding provider.

If approval is not already clear, ask:

```text
Should I use CocoIndex-code active context for this codebase before I continue?
It can improve fuzzy code retrieval, but it creates local index state and embedding
settings must be approved.
```

## Retrieval Order

```bash
tropo find "<task or question>" --budget 1200 --json
tropo graph --json
```

Open only the routed module indexes or files that matter. Do not load the whole repo or
docs tree.

If graph search and `rg` are not enough, use CocoIndex-code:

```bash
ccc doctor
ccc index
ccc search --refresh "<semantic question>"
```

On non-interactive Windows runs, initialize with:

```powershell
cmd /c "echo. | ccc init -f"
```

Then read the returned files directly. Semantic hits are candidates, not truth.

## Path Filters

Use exact indexed paths after discovery:

```bash
ccc search --path "src/db.py" "database connection pool"
ccc search --lang python --path "src/db.py" "database connection pool"
```

Avoid broad `ccc --path` guesses such as `src/*` or `docs/*`; current CocoIndex-code
releases can return no hits for broad folder globs even when matching files are
indexed. Search without `--path` first, then rerun with an exact returned path.

## Report Back

When active context was used, report:

- Vivary commands run.
- CocoIndex-code query.
- Whether the index was refreshed.
- Exact files read after search.
- What changed in the working understanding.

## Do Not Use CocoIndex-code For

- Private memory files unless explicitly approved.
- Vivary graph truth; use `tropo` for ids, types, edges, and blast radius.
- Tiny tasks where direct file reads are cheaper.
