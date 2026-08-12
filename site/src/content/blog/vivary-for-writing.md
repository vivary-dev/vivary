---
title: "Vivary for writing and content: a pipeline that remembers"
description: "The writing preset's typed status field for drafts, editorial memory of what you've already said, and how this very blog is drafted ahead and published on a schedule."
date: 2026-07-29
author: "Jeff Kazzee"
tags: ["writing", "content", "howto"]
draft: false---

Content work has its own version of the memory problem. Not "the agent
forgot the codebase," but "did I already make this point in a post from
three months ago," or "is this draft ready, or did I leave a note to myself
that it still needs a second pass I never did." Those are retrieval
questions, and a folder of loose drafts answers them badly, the same way a
flat `notes.md` answers "what's the current state of the billing refactor"
badly. The `writing` preset applies the same typed-memory idea to a content
pipeline instead of a codebase.

## Typed state instead of a folder of drafts

```bash
create-vivary init my-manuscript --preset writing
```

The starter graph is a `manuscript-system` module with a `draft-review-loop`
change and `editorial-review` verification, the same shape as the coding
preset's `local-ci-baseline` and `local-checks`, just named for what a
writing pipeline actually has: something in progress, and something that
proves it's ready.

The practical version of this, in most content workflows I run, is a piece
moving through stages as a status field changes, not as a file gets renamed
and moved between folders you have to remember the meaning of. A `changes/`
entry for a piece carries `status: planned`, `active`, `done`, `blocked`, or
`deferred`, the same enum the coding preset uses for a code change, checkable
by `tropo check` instead of inferred from a filename like
`draft-v3-FINAL-actually-final.md`.

## Editorial memory: what you've said, what's planned

The genuinely useful part isn't tracking one piece. It's tracking the
relationship between pieces over time. Two questions come up constantly when
you're producing content regularly:

**Have I already said this?** Restating your own point from four months ago,
with slightly different words, reads as repetitive to anyone who's been
reading along. A typed content graph makes this a retrieval question instead
of a memory-of-your-own-work question:

```bash
tropo find "have I written about blast radius before" --root . --budget 800
```

That's a fast, honest check against your own output, not a guess based on
what you remember writing.

**What's already planned?** A content roadmap that lives as prose in one file
tends to drift the same way any flat notes file drifts: items get written
without the roadmap being updated, or the roadmap accumulates ideas nobody's
committed to. A typed backlog, with each idea as its own `changes/` node and
a real `status`, survives that better: `tropo query "backlog" --type change
--explain` shows you what's actually queued, not what someone remembers
queuing.

## How this very blog works

This post, and the seven others published alongside it, are a real example
of the pipeline, not a hypothetical. Every post in this blog is a Markdown
file with frontmatter, drafted ahead of its publish date with `draft: true`
and a future `date`. A scheduled GitHub Actions workflow runs three times a
week, checks every post's frontmatter, flips `draft: true` to `draft: false`
for any post whose date has arrived, opens a pull request with the change,
and merges it automatically. Nobody has to remember to hit publish on the
right day. The mechanism doesn't know or care what the post says. It only
checks two fields, a boolean and a date, which is exactly why it's reliable.
A dumb, narrow check that runs on a fixed schedule beats a smart process that
depends on a human remembering.

That's editorial memory and scheduling handled by the same instinct behind
everything else in this series: make the fact machine-checkable (is `draft`
true, has `date` arrived) instead of a thing a person has to track in their
head or a calendar reminder. The workflow doesn't understand content
strategy. It doesn't need to. It just needs two fields to check, and it
checks them reliably every single time, which a human remembering to
"publish the Tuesday post" will eventually fail to do.

## Why this fits the same substrate as coding

If you've read [Vivary for coding](/blog/vivary-for-coding/), the parallel
should already be obvious: a `changes/` entry here plays the same role a
code change does there, `editorial-review` plays the role `local-checks`
does, and the gate that stops an agent from merging risky code is the same
kind of gate that should stop a post from publishing before you've actually
read it. It's [one substrate, many projects](/blog/one-substrate-many-projects/)
applied to the specific case of a content pipeline. The commands, the checks,
and the mental model don't change; only what the typed nodes represent does.

## Getting started

```bash
create-vivary init my-content --preset writing
create-vivary doctor my-content
tropo check --root my-content
```

Same three commands as every other preset. If you already have a pile of
drafts and published posts sitting in a repo, `create-vivary adopt .` brings
the same structure to that folder instead of asking you to start over. See
[adopt, don't rebuild](/blog/adopt-dont-rebuild/) for exactly what it will
and won't touch.

[Getting started](/getting-started/) has the full first-run walkthrough, and
the [command reference](/commands/) documents every flag used here.
