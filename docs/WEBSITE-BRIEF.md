# Website brief — handoff for the agent building the Vivary site

Paste this whole file to the agent building the Vivary website. It is the context,
positioning, copy direction, and links needed to replace the current placeholder copy.

---

## What you're building

The marketing/landing site for **Vivary** — a standard + scaffolder for **agent-native
workspaces**. One-liner: **"the `create-t3-app` for agent workspaces."** Audience:
developers building with AI coding agents (Claude Code, Codex, and friends) who are
tired of hand-rolling a pile of Markdown context files and want a structured, portable,
*navigable* workspace instead.

The product is real and shipping: four zero-dependency Python packages on PyPI + a
scaffolder on npm. Don't overclaim ("AI that thinks for you") — the pitch is **structure
and leverage**, not magic.

## The core idea (use this as the spine of the copy)

> A self-improving loop running over a typed, navigable knowledge graph, with one
> visible state surface and human gates.

Everything is a facet of that sentence. Translate it for a skim-reader:

- **Typed knowledge graph, not flat memory.** Your agent's context is structured and
  validated — the *folder is the type*, links are typed and navigable. (tropo)
- **A real operating loop.** Visible state, compounding memory, and self-improvement
  that carries across sessions. (strato)
- **Review by blast radius.** See everything a change touches *before* it lands — impact
  a text diff can't show. (ozone)
- **Coordinate many agents** over one shared source of truth when you scale up. (exo)
- **No lock-in.** Plain Markdown + tiny CLIs. Any editor or none; any runtime (Claude
  Code, Codex). Obsidian optional.

## Differentiators (the "why not just dump Markdown files" answer)

1. Typed, **validated** graph substrate (an opinionated `check` that fails on drift) —
   not a flat pile of notes that rots.
2. **Blast-radius / impact reasoning** — review by what a change *touches*.
3. **Medium-agnostic** — the same graph + review serves code *and* prose.
4. **It standardizes the agent workspace** — uncovered ground; the `create-t3-app`
   moment for agent infra.

## Tone

Confident, technical, concrete. Short sentences. Show commands, not adjectives.
Developer-to-developer. No corporate fluff, no hype, no emoji-spam. It's MIT and young
(`0.1.0`) — be honest about that; "early, opinionated, and useful" beats "revolutionary."

## Suggested page structure + copy starters

**Hero**
- H1: *The `create-t3-app` for agent workspaces.*
- Sub: *A typed knowledge graph, a self-improving loop, and graph-aware review — scaffold
  a structured, portable workspace your AI agent can actually operate. Plain Markdown.
  Any editor. Any agent.*
- Primary CTA: `npm create @vivary` (copy button) · Secondary: "Read the docs" → GitHub docs.

**The one command**
```bash
npm create @vivary my-workspace      # or: pip install create-vivary && create-vivary init
```
Caption: *Pick a preset — coding · second-brain · writing — and get a complete agent
workspace: contract, typed graph, memory, gates, and runtime skills.*

**Four layers** (a row of four cards): tropo (typed graph) · strato (agent OS) · ozone
(review) · exo (coordination). Use the one-liners above. Note baseline = tropo + strato;
ozone/exo are optional.

**"Why not just Markdown files?"** section → the 4 differentiators, each with a tiny
code/visual (e.g. a `tropo blast billing` output, or the `tropo view` graph image).

**Show the graph.** Embed a screenshot/render of `tropo view` output — the typed graph
is the hero visual. (Generate one: `tropo view --out graph.html` on a sample workspace.)

**Proof / honesty strip**: MIT · zero-dependency · Python 3.11+ · works in Claude Code &
Codex · 0.1.0 (early). Link PyPI + GitHub.

**Final CTA**: install command + "Star on GitHub" + link to docs.

## Links to use

- GitHub repo: **https://github.com/vivary-dev/vivary**
- Docs index: https://github.com/vivary-dev/vivary/tree/dev/docs
- PyPI: https://pypi.org/project/vivary-tropo/ · /vivary-ozone/ · /vivary-exo/ ·
  /create-vivary/
- npm scaffolder: `@vivary/create` (https://www.npmjs.com/package/@vivary/create once live)
- License: MIT

## Install / commands to feature (verified)

```bash
# scaffold
npm create @vivary my-workspace            # or npx @vivary/create
pip install create-vivary && create-vivary init my-workspace --preset coding

# the four CLIs
pip install vivary-tropo vivary-ozone vivary-exo
tropo check          # validate the typed graph (strict)
tropo view           # render the graph as HTML
ozone review         # graph-aware review
ozone impact <id>    # blast radius of a change
exo board            # multi-agent coordination
```

## Do / don't

- **Do** lead with the one command and the graph visual.
- **Do** be specific (folder-as-type, blast radius, human gates).
- **Don't** claim autonomy/AGI/"replaces engineers."
- **Don't** make Obsidian (or any editor/vendor) look required — it isn't.
- **Don't** invent metrics or testimonials.
