---
title: "How to actually use a second brain, day to day"
description: "Capture, type, link, retrieve: the practical loop, scaffolding or adopting a vault, and tropo find as the habit that replaces frantic scrolling."
date: 2026-07-22
author: "Jeff Kazzee"
tags: ["second-brain", "howto", "tropo"]
draft: true
---

Knowing why unstructured notes rot doesn't tell you what to actually do on a
Tuesday when you have a thought worth keeping. I covered the "why" in [why a
second brain matters](/blog/why-a-second-brain-matters/); this is the
practical follow-up: the loop I actually run, and the commands behind it.

## The loop: capture, type, link, retrieve

Four steps, in order, and the order matters:

**Capture.** Write the thing down. Don't overthink where yet. Friction here
is what kills second brains before they start. A rough note in the right
general area beats a perfectly placed note you never wrote because you were
still deciding on a folder.

**Type.** This is the step unstructured systems skip, and it's the one that
actually matters. In Vivary, type is mostly free: a note's type is the folder
it lives in, so dropping a decision under `decisions/` already types it as a
decision. You only add frontmatter for what the folder and content can't
already tell you: a status, a date, an edge to something else. Run `tropo
check` and it tells you if you got the required fields wrong, right away,
not months later when you go looking for the note and can't parse your own
past self.

**Link.** A note that references another idea should say so with a real
edge, a `ref` or `ref-list` field, not a loose mention in prose. That turns
"I think I wrote something related to this once" into a graph traversal:
`tropo graph` shows you the whole shape, `tropo blast <id>` shows you
everything that points at a given note. This is the step that makes the vault
more useful the more you use it, instead of just bigger.

**Retrieve.** The payoff step, and the one a flat notes pile can't deliver on
at scale. More on this below; it's worth its own section.

## Getting a workspace: scaffold or adopt

If you're starting fresh:

```bash
create-vivary init my-brain --preset second-brain
cd my-brain
```

That gives you the full shell: `AGENTS.md`, `STATE.md`, a starter
`knowledge-base` module, and a `tropo.toml` with the second-brain types
already declared. If you want the wizard to also set up semantic memory or
storage, run it interactively; for a fully scripted setup, `--no-wizard
--storage embedded --memory local --yes` gets you there without prompts.

If you already have a notes vault, a folder of Markdown you've been
accumulating for years, Obsidian or otherwise, you don't rebuild it from
scratch. You adopt it:

```bash
create-vivary adopt . --json      # see the plan first, writes nothing
create-vivary adopt . --yes       # apply it
```

`adopt` only adds files. It auto-detects `second-brain` as the preset when
your folder is markdown-heavy, and it gives markdown-dense directories a thin
`modules/<name>/index.md` router instead of touching them. Your existing
notes stay exactly where they are; adopt tells you where they'd need a bit of
frontmatter to become fully graph-typed, and you decide when to do that, note
by note, at your own pace. I go deeper on the mechanics, and what "only
adds" actually had to survive to be a trustworthy claim, in [adopt, don't
rebuild](/blog/adopt-dont-rebuild/).

## `tropo find`: the habit that replaces scrolling

The single highest-leverage habit change, if you take away only one thing
from this post: stop scrolling for what you need. Ask for it.

```bash
tropo find "what did I decide about the pricing model" --root . --budget 800
```

`tropo find` is the "what should I read first?" command. It returns a small,
ranked set of typed nodes and files relevant to your query, with reasons and
trimmed snippets, sized to a token budget instead of dumping everything that
loosely matches. That's a fundamentally different retrieval experience than
full-text search over a folder of loose Markdown: you get a short, curated
answer instead of a list of forty files you now have to read yourself to find
the one that matters.

If you want the lower-level primitive instead of the curated packet, `tropo
query` does filtered graph search. Restrict by `--type`, `--path`, or
`--edge`, and add `--explain` to see why each result matched:

```bash
tropo query "pricing" --type decision --explain --json
```

Make `tropo find` the first thing you run when you're looking for something,
before you open a single file by hand. That one habit is most of what
separates a second brain that compounds from one that quietly stops getting
used.

## `doctor`: the weekly health check

Once a week, or whenever something feels off, run:

```bash
create-vivary doctor .
tropo check
```

`doctor` confirms the workspace shell is intact and that private files
(`USER.md`, `MEMORY.md`, `memory/*`) are actually ignored by Git, not just
supposed to be. `tropo check` validates every note's frontmatter and the
graph as a whole. It's strict by default, meaning warnings fail the check,
not just errors. That's deliberate: an untyped stray file, a broken
reference, or redundant frontmatter that just repeats what the folder
already says all surface immediately instead of accumulating quietly the way
they would in an unstructured vault. `tropo fix` clears the
redundant-frontmatter case automatically.

If you want to track drift over time rather than just catching it in the
moment, `create-vivary doctor . --trend` records a baseline on first run and
reports signed deltas (module count, graph health, file count) against the
prior run on every run after that. It's the difference between noticing rot
when it breaks something and noticing the early signal that something's
trending the wrong way. I go deep on that mechanism in [memory that doesn't
rot](/blog/memory-that-doesnt-rot/).

## You don't need Obsidian, but you can have it

Everything above works against plain Markdown files in any editor, or none.
If you like a visual graph and a vault-style UI, `create-vivary init --obsidian`
adds an opt-in Obsidian config with the graph colored by type. See
[docs/OBSIDIAN.md](/obsidian/) for the setup. But nothing about `tropo
find`, `check`, or `doctor` requires it. The second brain is the typed
Markdown; Obsidian, if you use it, is just one way to look at it.

## Where to go from here

[Getting started](/getting-started/) has the full first-run walkthrough if
you haven't scaffolded anything yet, and the [command
reference](/commands/) documents every flag mentioned here. If you're
curious why this structure matters more than it looks like it should, that's
[why a second brain matters, and why most of them fail](/blog/why-a-second-brain-matters/).
