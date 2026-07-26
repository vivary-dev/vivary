---
title: "Architecture"
description: "The four-layer model and the principles behind Vivary."
editUrl: "https://github.com/vivary-dev/vivary/edit/dev/docs/ARCHITECTURE.md"
---

This page explains how Vivary is put together and why. It's the deep version; for the
plain-language overview, read [Concepts](/concepts/) first.

## 1. What Vivary is

Vivary is a **standard + scaffolder for agent-native workspaces**. Like
`create-t3-app` curates standalone best-in-class pieces into one coherent stack,
`create vivary` composes standalone modules into a normalized agent workspace —
for a second brain, a coding project, or a writing project, on any agent runtime
(Claude Code, Codex CLI, …) and any stack.

The goal is **normalization**: today everyone hand-rolls their agent setup.
Vivary makes the workspace a known, structured, portable thing.

## 2. The first-principles baseline

Four of Jeff's repos turned out to be **two ideas**, one of them a single loop
seen at two speeds:

- **braincheck → loam** — one knowledge-layer lineage (loam supersedes braincheck).
- **throughline + flywheel** — the *same self-improving loop*. throughline runs
  `Ask→retrieve→act→verify→learn→gate` every turn; flywheel distills what the
  loop `learn`ed into durable memory, playbooks, and skills on a heartbeat. Inner
  turn and outer turn of one mechanism.

The irreducible core, true of any agent workspace regardless of stack or task:

> **A self-improving loop running over a typed, navigable knowledge graph, with
> one visible state surface and human gates.**

**Design law (from throughline's minimalism hypothesis):** every always-on file
competes with the user's task for context. The framework must cost almost nothing
to load. Fewer files, fewer words, more room for the work. This is the constraint
that keeps Vivary from bloating into a heavy harness.

**DRY and progressive disclosure:** context management only works if it lowers the
active load. `AGENTS.md`, `STATE.md`, and `modules/**/index.md` are routing surfaces;
canonical detail lives once in the owning typed file or skill. Agents choose a module
through `modules/index.md`, open that module's `index.md`, and follow deeper links only
when the task proves they are relevant.

**No lock-in (corollary):** a workspace is plain Markdown + YAML plus a few
zero-dependency CLIs. It works in any editor or none and on any agent runtime
(Claude Code via `.claude/`, Codex via `AGENTS.md` + `.agents/`). tropo even ignores
`.obsidian/`, `.vscode/`, etc. — no editor, plugin, or single-vendor agent is ever
required.

**Active context is a sidecar.** For codebases, a workspace may opt into
CocoIndex-code guidance (`--active-context cocoindex-code`) so agents can ask before
using semantic code search. This does not move embeddings or indexing into the tropo
core; it keeps the deterministic graph as truth and treats semantic search as
candidate retrieval.

**Semantic memory is also optional.** For second-brain, knowledge-work, and writing
workspaces, semantic recall should use provider adapters over typed `tropo`
nodes, not naive chunked RAG and not a second source of truth. Database/search and
memory providers are optional capabilities presented in the install flow; Cognee may
be one provider behind that adapter, but it must stay out of the default install and
default preset path. See [Optional semantic memory](/semantic-memory/).

## 3. The layer model

A vertical column. Each layer is a standalone module that reads/writes the same graph
and obeys the same convention. The published CLIs are thin; `strato` is bundled
agent-OS source/templates inside the repo and generated workspaces, not a separate
npm/PyPI package today.

```
        exo      ── multi-agent orchestration            (outermost, optional)
       ozone     ── review: code + editorial / gates     (protective filter, optional)
       strato    ── agent OS: state · memory · loop · gates · self-improvement   (BASELINE)
       tropo     ── typed knowledge graph: what's true   (dense foundation, BASELINE)
```

- **tropo** (troposphere) — the dense, living foundation. Typed frontmatter →
  typed graph → search/navigation. Ground truth. *(ported from loam)*
- **strato** (stratosphere) — the stable layer above the churn. The visible state
  surface, compounding memory, the operating loop, human gates, and the
  self-improvement that falls out of `learn` over time. *(throughline + flywheel,
  fused)*
- **ozone** — the protective filter. Review for code *and* prose; a specialized
  verify/gate step. *(optional)*
- **exo** — the outermost layer. Coordination when one agent becomes many.
  *(optional)*

Baseline = **tropo + strato** (knowledge + the self-improving loop over it).
`ozone` and `exo` snap on as needed.

### The shared seam: `vivary-core`

The four layers above are the *vertical* column. `vivary-core` is the horizontal
seam beneath them — the governed-context primitives every role package is *meant* to
speak through, so that "what is true, and how do we know" ends up with exactly one
implementation rather than four that drift. No role speaks through it yet; see
**Status** below for where that stands.

It is a library, not a layer and not a CLI. Nothing about the baseline changes
because it exists: you still install and run `tropo`, `strato`, `ozone`, `exo`.

```
   exo · ozone · strato · tropo      ── the layers, each with its own CLI
   ─────────────────────────────
          vivary-core               ── the seam they share (library, no CLI)
```

What it owns:

- **Determinism** — canonical JSON, sha256 fingerprints, deterministic IDs. Same
  input, same bytes, on every machine.
- **Observation** — read-only checkout observation over explicit allowlisted roots.
  Never fetches, never writes, never crawls.
- **Projection** — observations into a typed evidence graph, where divergent
  checkouts become explicit unresolved conflicts with both sides preserved, never
  auto-resolved.
- **Capsules** — bounded task context, every claim carrying its evidence and its
  selection reason, every omission recorded.
- **Receipts and evidence** — what actually ran, bound to the exact capsule and
  workspace fingerprint it ran against, in an append-only store.

The governing rule is the same one the rest of Vivary follows: it never resolves an
ambiguity it merely observed. Conflicts are handed to review, not to confidence, and
anything unproven is reported `unknown` rather than guessed.

**Dependency direction:** role packages depend on `vivary-core`; the `vivary` meta
package receives it transitively and does not declare it. One owner per edge, so there
is no version-pinning fight between the meta package and the roles. The edge is added to
a role's `pyproject.toml` in the *same commit* that makes that role first import
`vivary_core` — never ahead of it. That is why no manifest declares `vivary-core` today:
nothing imports it yet, and a dependency nothing uses is a declaration the code does not
support.

**Status:** merged into `dev` and not yet reachable from any shipping CLI — wiring it
outward is tracked in [#207](https://github.com/vivary-dev/vivary/issues/207). Until
that lands, treat this section as describing the seam's contract, not a user-facing
feature.

## 4. The moat

Existing harnesses persist *flat context* — specs and memory dumped into Markdown.
Vivary's differentiators:

1. **Typed knowledge graph substrate**, not flat memory (tropo).
2. **Blast-radius / impact reasoning** — show what a change touches, before and
   after, visually, in a way a text diff cannot. (tropo's graph roadmap.)
3. **Medium-agnostic** — code review and editorial review are the same layer
   (ozone) with different rule packs.
4. **A standardized agent workspace** — uncovered ground.

## 5. Naming & namespace

The brand owns the namespace; current package truth is:

- npm: `@vivary/create` — the launcher for the scaffolder.
- PyPI: `vivary` (the meta package that installs the suite), `vivary-tropo`,
  `vivary-ozone`, `vivary-exo`, `create-vivary`, and the optional
  `vivary-memory-cognee`.
- `vivary-core` is declared in-repo but deliberately unpublished; it ships with the next
  major alongside the role packages, never ahead of them.
- `strato` is bundled source/templates, not a published npm or PyPI package.
- GitHub: `vivary-dev/vivary` holds the public repo.

Future packages can still use the Vivary namespace, but public docs should only name
packages that are actually published.

## 6. Module naming = atmosphere strata

The vertical column is named by altitude: `tropo` (troposphere, ground-hugging
and dense) → `strato` (stratosphere, stable) → `ozone` (the protective layer) →
`exo` (exosphere, the boundary to space). A *vivary* contains its own atmosphere,
so the metaphor nests cleanly: the world (Vivary) and its layers (the strata).
