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
- The first Cognee adapter slice now lives in `packages/memory-cognee/`, returning
  typed Vivary node hits only and keeping provider state rebuildable.

## P1 — the adoption line (set 2026-07-03)

The product diagnosis behind this priority: installs far outnumber engagement,
the current funnel only pays off on greenfield scaffolds, and the value has to
be *felt* on an existing messy repo before anyone commits. Everything in P1
either lets Vivary work on brownfield projects, proves the token thesis with a
number, or gives an adopter a reason to come back.

### P1.1 Large filesystem map (`tropo map`)

Goal: let agents understand a large repo, vault, docs tree, or file system
without opening hundreds of files. This is the brownfield wedge — the first
Vivary command that is useful on a workspace Vivary did not create.

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

### P1.2 Brownfield adopt (`create-vivary adopt .`)

Goal: turn the map into an adoption path for existing repos and vaults, so the
product motion becomes "point Vivary at your mess" instead of "start a new
world from scratch."

Shape:

- read the filesystem map of an existing workspace;
- propose (dry-run first, always) a `tropo.toml`, a starter typed graph, the
  strato surface files, and `index.md` routing surfaces for the likely modules;
- explicit write gate before any file is created; never move, rename, or edit
  existing content in the first slice — adopt only *adds*, and only behind the
  gate;
- `doctor` must pass on an adopted workspace the same way it does on a
  scaffolded one.

High-value tests:

- dry-run JSON names every proposed write and nothing else gets written;
- adopt refuses symlinked/out-of-root targets (same hardening line as 0.2.5);
- existing files are byte-identical after adopt;
- adopted workspace passes `doctor` and `tropo check`.

### P1.3 Token-savings benchmark

Goal: measure the thesis instead of asserting it. The entire product filter is
"reduce the tokens an agent spends finding information" — that claim needs a
published number.

Shape:

- fixed task set (e.g. "where is X owned?", "what breaks if Y changes?") on a
  real public repo, run two ways: agent with `tropo find`/`query` vs. agent
  with raw file search;
- record tokens, turns, and wrong-files-opened per task;
- publish methodology + results as `docs/BENCHMARK.md`, a site chart, and a
  blog post; keep the harness re-runnable so the number stays honest across
  releases.

High-value tests:

- benchmark harness is deterministic in task order and reporting format;
- results clearly label model, date, and repo revision;
- a regression in the number is visible release-over-release.

### P1.4 `vivary-mcp` (optional package)

Goal: meet agents on the rail they already ride. Claude Code, Codex, and Cursor
users should be able to use the typed graph without CLI plumbing.

Shape:

- a separate, opt-in package (never core — the no-hidden-MCP law stands)
  exposing read-only `find`, `query`, and `check` over MCP;
- no write tools in the first slice;
- same privacy-ignore rules as the CLIs; provider returns typed node hits only.

High-value tests:

- server exposes exactly the three read-only tools and nothing else;
- private/ignored paths never appear in tool results;
- works against a scaffolded and an adopted workspace;
- core packages remain installable and testable without the MCP package.

### P1.5 Doctor as the retention loop

Goal: give adopters a reason to run Vivary weekly, not once. Today adopters
run `doctor` once at creation and have no reason to run it again.

Shape:

- teach `doctor` drift: compare graph health, routing-surface size, and
  context-budget findings against the previous run and report the trend;
- ship a copy-paste GitHub Action recipe running `tropo check` and
  `ozone review --strict` as a CI gate;
- keep all of it read-only; trend state lives in one small, inspectable file.

High-value tests:

- trend output is stable and diffable;
- first run (no prior state) degrades gracefully;
- CI recipe fails the build on a broken graph and passes on a clean one.

### P1.6 Dogfood program

Goal: every active repo the maintainer touches runs Vivary, and one public
walkthrough proves it (issue #24: run the Vivary site repo as a Vivary
workspace and publish the WALKTHROUGH).

Shape:

- adopt-in-place (P1.2) is the mechanism; the dogfood repos are its first
  users and its bug reports;
- publish one honest WALKTHROUGH.md from a real repo, including what was
  awkward;
- fold friction found here straight back into P1.1/P1.2.

### P1.7 Strato as a verifiable agent OS

Goal: the conceptual core of the product — the agent OS layer — must be as
testable as the code layers. Today strato is unversioned Markdown with no
checks.

Shape:

- scaffold smoke in CI: `init` → `doctor` → `tropo check` green on every
  preset, every commit;
- template integrity tests (no stale cross-references, private files ignored,
  skills present for both Claude and Codex runtimes);
- decide and document versioning: strato rides create-vivary's release train,
  and the changelog says so when templates change.

## P2 — next candidates

Sequenced behind the adoption line. The module index planner is deliberately
*not* P1: it builds on `tropo map` output and comes after the map has real
users.

### P2.1 Module index planner

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

### P2.2 Structured content query

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

### P2.3 Typed recall provider contract

Goal: define the boundary between Vivary graph truth and optional recall engines
without importing embeddings, Cognee, LanceDB, or CocoIndex into core.

Shape:

- define a provider contract that returns typed node hits only: id, type, path,
  score, reason, and optional snippet;
- ship fake-provider tests for deterministic adapter behavior;
- make `tropo find` able to merge provider hits after graph-first retrieval;
- keep providers opt-in and inspectable.

High-value tests:

- fake provider merge order is deterministic;
- provider hits cannot invent nodes outside the graph;
- missing/unavailable providers degrade to graph-only results;
- no network or embedding dependency is imported by default.

### P2.4 Optional integration proof pass

Goal: keep LanceDB, CocoIndex-code, and Cognee useful without letting them become
ambient risk.

Shape:

- LanceDB: smoke embedded storage migration and query from a fresh scaffold;
- CocoIndex-code: smoke active-context setup against a tiny fixture and document
  exact-path filtering;
- Cognee: smoke import/doctor/policy behavior behind the optional
  `vivary-memory-cognee` adapter;
- report proof as local verification, not as a claim that integration is always
  installed or enabled.

High-value tests:

- each integration can be tested in a disposable sandbox;
- core test suites pass with none of them installed;
- doctor output distinguishes configured, unavailable, stale, and privacy-failed;
- docs state the gate before install/index/network/MCP.

### P2.5 Context-budget repair workflow

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
- no hidden LanceDB, Cognee, CocoIndex-code, MCP, daemon, or network behavior
  (`vivary-mcp` is a separate opt-in package, never a core dependency);
- no automatic indexing of source code or personal notes;
- no command that tells an agent to read the whole repo, whole docs tree, or
  everything "just in case";
- no workspace mutation without a dry-run path and a human gate.
