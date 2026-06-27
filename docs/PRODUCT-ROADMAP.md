# Vivary product roadmap

This is the durable backlog for high-leverage Vivary upgrades that should not be
lost in chat. The filter is first-principles Vivary:

- reduce the tokens an agent spends finding, storing, and reusing specific
  information;
- prefer typed graph truth, public routing surfaces, and progressive disclosure;
- keep core deterministic and zero-dependency unless a capability is explicitly
  optional;
- test locally before release, with disposable fixtures or sandboxes when needed;
- never turn optional integrations into always-on bloat.

## Current release slice

The context-compression release covers the first concrete slice:

- `tropo find` returns typed context packets: ranked files/nodes to open first,
  with type, path, reason, snippet, JSON, and a rough token budget.
- `tropo query` searches analyzed graph nodes instead of raw files and supports
  type, path, edge, snippet, and explain filters.
- `ozone review --pack context-budget` flags missing module indexes, large public
  routing surfaces, duplicate routing blocks, and bulk-load cues.
- `create-vivary --active-context cocoindex-code` gives agents simpler
  graph-first CocoIndex-code guidance without installing, indexing, or enabling
  MCP by default.
- Local LanceDB, CocoIndex-code, and Cognee-policy smokes proved the optional
  surfaces can be exercised without making them core dependencies.

## Next release candidates

### 1. Large filesystem map

Goal: let agents understand a large repo, vault, docs tree, or file system without
opening hundreds of files.

Shape:

- add a read-only command that inventories major folders, file counts, obvious
  language/doc surfaces, large files, and existing index files;
- identify likely module boundaries and missing `index.md` routing surfaces;
- output a compact Markdown and JSON map;
- do not write or rearrange the workspace in the first slice.

High-value tests:

- fixture with nested code, docs, ignored folders, and oversized files;
- Windows-safe path behavior;
- ignored/private paths stay out of the map;
- output remains stable enough for agents to cite and diff.

### 2. Module index planner

Goal: turn missing-index findings into safe, reviewable routing proposals instead
of making an agent invent a repo map from scratch.

Shape:

- read the large filesystem map and Ozone context-budget findings;
- propose `modules/<name>/index.md` surfaces with ownership, purpose, and links;
- detect legacy `modules/<name>.md` files and propose non-destructive migration
  steps;
- require an explicit write gate before creating or changing files.

High-value tests:

- missing index suggestions are deterministic;
- private/ignored surfaces are never proposed as public routers;
- dry-run JSON names every proposed write;
- write mode refuses symlink/out-of-root paths.

### 3. Structured content query

Goal: make `tropo query` better at answering "where is this fact owned?" without
semantic search.

Shape:

- add frontmatter-specific filters such as field existence and exact value;
- add body-only, title-only, path-only, and frontmatter-only query modes;
- return which section or field matched when possible;
- keep `tropo find` friendly and make the extra controls power-user flags.

High-value tests:

- frontmatter fields match without body false positives;
- body-only excludes title/path/frontmatter matches;
- JSON explain output is stable;
- snippets remain bounded by `--snippet` and context budgets.

### 4. Typed recall provider contract

Goal: define the boundary between Vivary graph truth and optional recall engines
without importing embeddings, Cognee, LanceDB, or CocoIndex into core.

Shape:

- define a provider contract that returns typed node hits only: id, type, path,
  score, reason, and optional snippet;
- ship a fake/local provider first for deterministic tests;
- make `tropo find` able to merge provider hits after graph-first retrieval;
- keep providers opt-in and inspectable.

High-value tests:

- fake provider merge order is deterministic;
- provider hits cannot invent nodes outside the graph;
- missing/unavailable providers degrade to graph-only results;
- no network or embedding dependency is imported by default.

### 5. Optional integration proof pass

Goal: keep LanceDB, CocoIndex-code, and Cognee useful without letting them become
ambient risk.

Shape:

- LanceDB: smoke embedded storage migration and query from a fresh scaffold;
- CocoIndex-code: smoke active-context setup against a tiny fixture and document
  exact-path filtering;
- Cognee: smoke import/doctor/policy behavior behind an optional package or adapter;
- report proof as local verification, not as a claim that integration is always
  installed or enabled.

High-value tests:

- each integration can be tested in a disposable sandbox;
- core test suites pass with none of them installed;
- doctor output distinguishes configured, unavailable, stale, and privacy-failed;
- docs state the gate before install/index/network/MCP.

### 6. Context-budget repair workflow

Goal: help humans fix token bloat after Ozone finds it.

Shape:

- add a report that groups findings by "open first", "split", "deduplicate", and
  "route through an index";
- estimate token savings with the same no-dependency approximation used by Tropo;
- propose edits, but do not auto-apply in the first slice.

High-value tests:

- info-only reports do not fail strict mode;
- warn findings still gate under `--strict`;
- savings estimates are approximate and clearly labeled;
- duplicate-routing suggestions cite both paths.

## Explicitly out of scope for core

- no default embeddings;
- no hidden LanceDB, Cognee, CocoIndex-code, MCP, daemon, or network behavior;
- no automatic indexing of source code or personal notes;
- no command that tells an agent to read the whole repo, whole docs tree, or
  everything "just in case";
- no workspace mutation without a dry-run path and a human gate.
