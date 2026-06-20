---
name: active-context
description: >-
  Decide whether to use optional active context in a Vivary-backed codebase,
  especially CocoIndex-code semantic search. Use when a task spans unfamiliar
  code, exact names are unknown, grep is too thin or too noisy, the user asks
  about CocoIndex/ccc/active context, or the workspace needs a fresh semantic
  retrieval pass before implementation or review.
---

# active-context

Active context is an optional sidecar for a Vivary workspace. Vivary's core truth
stays the typed graph (`tropo`) and the agent loop (`strato`). CocoIndex-code can add
fresh semantic code search when the codebase is large enough or fuzzy enough that
plain file search is wasting context.

## Ask First

Ask before installing, initializing, indexing, enabling MCP, or sending code to any
external embedding provider. These are Vivary gates. If the user has already approved
the sidecar for this workspace, say so and continue.

Use a short question like:

> Should I use CocoIndex-code for active semantic context on this codebase before I
> continue?

Explain the tradeoff in one sentence: it can improve semantic retrieval, but it may
create local index state and, depending on embedding settings, may send source text to
an external provider.

## When To Use It

Use CocoIndex-code when:

- the task asks "where is this implemented?" and exact names are unknown;
- a feature spans several modules, routes, packages, or languages;
- grep/rg returns too much, too little, or only naming coincidences;
- you are onboarding to an unfamiliar codebase;
- a refactor, review, or risk check needs related implementations by meaning;
- the user explicitly asks for CocoIndex, `ccc`, semantic code search, or active
  context.

Skip it when:

- the exact file, symbol, or string is already known;
- the codebase is tiny enough that `rg` and direct reads are cheaper;
- source sensitivity is unknown and the embedding path is not approved;
- the question is Vivary graph truth, where `tropo graph` / `tropo blast` should lead.

## Retrieval Order

1. Read the Vivary graph first: `tropo graph`, `tropo blast <id>`, or
   `ozone impact <id>` for workspace truth and blast radius.
2. Use `modules/index.md` and the relevant `modules/<id>/index.md` to stay DRY.
3. Use CocoIndex-code for semantic candidates: `ccc search --refresh "<query>"`.
4. Read the matched files and nearby lines directly before acting.
5. Verify with the repo's tests/build and Vivary checks (`tropo check`,
   `ozone review`) before a gate.

## Useful Commands

```bash
ccc doctor
ccc index
ccc status
ccc search --refresh "authentication flow"
ccc search --lang python --path "src/*" "database connection pool"
```

For MCP-backed agents, use the `search` tool with `refresh_index=true` on the first
query of a session or after code changes.

## Reporting

When you use active context, report:

- the semantic query;
- whether the index was refreshed;
- the top useful file paths and line ranges;
- what exact files you then read;
- whether the semantic hits confirmed, expanded, or contradicted the Vivary graph.
