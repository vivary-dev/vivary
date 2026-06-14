# Vivary launch — draft copy (UNPUBLISHED)

> Drafts only. Publishing to Twitter/X or as a GitHub release is a human gate — nothing
> here is posted without explicit per-item approval. Edit freely.

---

## Twitter / X thread

**1/**
I kept hand-rolling the same pile of Markdown context files for every AI-agent project —
specs, memory, "rules" — and watching them rot.

So I built **Vivary**: the `create-t3-app` for agent workspaces.

`npm create @vivary`

🧵

**2/**
The idea in one line:

*a self-improving loop running over a typed, navigable knowledge graph, with one visible
state surface and human gates.*

Not a flat pile of notes. A structured workspace your agent can actually operate.

**3/**
It's four small, zero-dependency layers:

◦ **tropo** — typed knowledge graph (the *folder* is the type)
◦ **strato** — the agent OS: state, memory, the loop, gates
◦ **ozone** — graph-aware review
◦ **exo** — coordinate many agents

Baseline is tropo + strato. The rest snaps on.

**4/**
The part I'm proud of: **review by blast radius.**

`tropo blast billing` → everything that depends on it.

You see what a change *touches* before it lands — impact a text diff can't show.

**5/**
And it's opinionated on purpose. `tropo check` is a gate, not a linter — untyped docs,
typo'd fields, broken links all *fail*. Your agent's context stays trustworthy instead
of quietly rotting.

**6/**
No lock-in. Plain Markdown + tiny CLIs. Works in any editor or none, and any runtime —
Claude Code reads `.claude/`, Codex reads `AGENTS.md`. Obsidian fans get an opt-in setup;
nothing depends on it.

**7/**
Try it (Python 3.11+):

```
npm create @vivary my-workspace
# or
pip install vivary-tropo vivary-ozone vivary-exo create-vivary
```

MIT, early (0.1.0), and useful today.

⭐ github.com/vivary-dev/vivary

---

## GitHub release / announcement (v0.1.0)

### Vivary 0.1.0 — the `create-t3-app` for agent workspaces

Vivary is a standard + scaffolder for **agent-native workspaces**. Instead of
hand-rolling a pile of Markdown context for every AI-agent project, scaffold a structured,
portable, *navigable* one:

```bash
npm create @vivary my-workspace
# or
pip install create-vivary && create-vivary init my-workspace --preset coding
```

**The core idea:** *a self-improving loop running over a typed, navigable knowledge
graph, with one visible state surface and human gates.*

**Four zero-dependency layers** (Python 3.11+):

- **tropo** — a typed knowledge graph where the *folder is the type*; an opinionated
  `check` that fails on drift, plus `graph` / `blast` / `view`.
- **strato** — the agent OS: the per-turn loop, visible state, compounding memory, human
  gates, and self-improvement.
- **ozone** — graph-aware review: relationship-level findings + **blast-radius impact**,
  the thing a text diff can't show.
- **exo** — coordinate many agents over one shared source of truth.

**Why it isn't just a folder of Markdown:**
1. Typed, *validated* graph substrate — not flat memory that rots.
2. Review by **what a change touches**, not just what lines changed.
3. Medium-agnostic — code *and* prose.
4. It standardizes the agent workspace — uncovered ground.

**No lock-in:** plain Markdown + tiny CLIs; any editor or none; Claude Code *and* Codex;
Obsidian optional. MIT.

**Install:** `pip install vivary-tropo vivary-ozone vivary-exo create-vivary`
**Docs:** [docs/](https://github.com/vivary-dev/vivary/tree/dev/docs) ·
**Source:** https://github.com/vivary-dev/vivary

This is an early, opinionated 0.1.0. Issues and feedback very welcome.
