# Blog content roadmap

The blog lives at `site/src/content/blog/*.md`. To add a post, drop a new Markdown
file there with this frontmatter, and it appears on `/blog/` automatically (sorted by
date, newest first; set `draft: true` to keep it off the production site):

```yaml
---
title: "Your title"
description: "One-sentence standfirst, shown on the index and as the meta description."
date: 2026-06-20
author: "Jeff Kazzee"
tags: ["guide", "agents"]
draft: false
---
```

## Shipped

- **why-i-built-vivary** — origin and motivation.
- **what-is-an-agent-native-workspace** — the core concept and the five things.
- **harnesses-explained** — what a harness is; model-agnostic, harness-neutral.
- **run-vivary-with-local-models** — fully-local setup and tips.

## Backlog (the rest of the ideas)

Education and explanation:
- **Memory that doesn't rot** — deep dive on the typed graph vs flat notes.
- **Blast radius: review the way you think about risk** — `ozone impact` in practice.
- **The loop: ask, retrieve, act, verify, learn, gate** — how a turn actually runs.
- **What the gates are for** — human gates, why they exist, when they fire.
- **Second brain, coding, writing: one substrate, three presets.**

Use-cases and audiences:
- **Vivary for solo founders / indie hackers.**
- **Vivary for teams** — shared workspace, role contracts, coordination with `exo`.
- **Industry-specific:** regulated/NDA work (pairs with local models), research,
  legal/contract review, content/editorial teams.
- **Role-specific:** for the staff engineer, the technical writer, the PM, the
  researcher.
- **Task-specific:** migrations, audits, large refactors, literature reviews,
  long-form writing projects.

Guides and how-tos:
- **Vivary + Claude Code, end to end.**
- **Vivary + Codex, end to end.**
- **Bring an existing repo into Vivary** without starting over.
- **CI gate:** run `tropo check` in your pipeline.
- **Multi-agent:** coordinating several agents over one workspace with `exo`.
- **Obsidian, optionally** — the visual graph for people who like a vault.

Keep each post concrete, honest, and grounded in a command the reader can run.
Avoid claims that aren't backed by the package state (see `README.md` and
`CHANGELOG.md`).
