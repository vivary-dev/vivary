# Vivary — architecture

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

**No lock-in (corollary):** a workspace is plain Markdown + YAML plus a few
zero-dependency CLIs. It works in any editor or none and on any agent runtime
(Claude Code via `.claude/`, Codex via `AGENTS.md` + `.agents/`). tropo even ignores
`.obsidian/`, `.vscode/`, etc. — no editor, plugin, or single-vendor agent is ever
required.

## 3. The layer model

A vertical column. Each layer is a standalone package that reads/writes the same
graph and obeys the same convention.

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

The brand owns the namespace; modules are scoped under it, so globally-taken bare
words (ozone, tropo) stop mattering:

- npm: `@vivary/tropo`, `@vivary/strato`, …
- PyPI: `vivary-tropo`, `vivary-strato`, …  (PyPI has no scopes — prefix instead)
- one GitHub org holds every module repo

`vivary` is free on npm and PyPI. The bare `github.com/vivary` login is a dead
account, so the org needs a handle variant (e.g. `vivary-dev`). See HANDOFF.

## 6. Module naming = atmosphere strata

The vertical column is named by altitude: `tropo` (troposphere, ground-hugging
and dense) → `strato` (stratosphere, stable) → `ozone` (the protective layer) →
`exo` (exosphere, the boundary to space). A *vivary* contains its own atmosphere,
so the metaphor nests cleanly: the world (Vivary) and its layers (the strata).
