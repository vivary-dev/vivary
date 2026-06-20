---
title: "Active context"
description: "Optional CocoIndex-code sidecar guidance for semantic code retrieval."
---

Active context is an optional sidecar pattern for Vivary-backed codebases. The
baseline remains small and deterministic: `tropo` owns the typed graph, `strato`
owns the agent loop, and no index, daemon, embedding model, or MCP server is enabled
by default.

For coding workspaces, `create-vivary` can scaffold a CocoIndex-code profile:

```bash
create-vivary init my-workspace --preset coding --active-context cocoindex-code
```

This writes:

- an `active-context` skill for Claude/Codex-style agents;
- `docs/active-context.md` with the local policy;
- graph nodes under `modules/active-context/index.md`, `decisions/`, and
  `verification/`;
- `.cocoindex_code/` in `.gitignore`.

It does **not** automatically install CocoIndex-code, initialize an index, run
embeddings, enable MCP, or send source text anywhere. Those are explicit gates after
the user approves active context.

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

1. Start with Vivary truth: `tropo graph`, `tropo blast <id>`, `ozone impact <id>`.
2. Use CocoIndex-code for semantic candidates: `ccc search --refresh "<query>"`.
3. Read matched files directly before acting.
4. Verify with project tests and Vivary checks before a gate.

## Install And Prove It

Useful commands after approval:

```bash
uv tool install --python 3.11 --upgrade "cocoindex-code[full]"
ccc init -f
ccc doctor
ccc index
ccc status
ccc search --refresh "authentication flow"
codex mcp add cocoindex-code -- ccc mcp
```

On non-interactive Windows agent runs, drive init through stdin so it chooses the
local sentence-transformers default instead of opening an interactive prompt:

```powershell
cmd /c "echo. | ccc init -f"
```

Verified on the Vivary repo on 2026-06-20: `cocoindex-code==0.2.36` installed with
local embeddings, `ccc doctor` passed model and file-walk checks, `ccc index` indexed
95 files into 886 chunks, and `ccc search --refresh "active context cocoindex sidecar
create-vivary scaffold"` returned the active-context docs and `create_vivary.py`
implementation.

The sidecar should report the query, refresh status, useful file paths/line ranges,
files read, and how the semantic hits changed or confirmed the graph-based context.
