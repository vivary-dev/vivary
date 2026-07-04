---
title: "One substrate, many projects"
description: "The same typed-workspace shape in every project I run means each one greets me, and my agent, with its own context. That's the actual point of Vivary."
date: 2026-07-27
author: "Jeff Kazzee"
tags: ["philosophy", "context", "workflow"]
draft: true
---

I don't run one project. On a given week I'm in a coding repo, a content
pipeline, a research workbench, and a personal notes vault, sometimes all in
the same afternoon. If you also work this way, you already know the real cost
isn't any single project. It's the switch. You close one terminal, open
another, and your brain has to reload an entire world: what's this project,
where did I leave it, what did I decide last week, what's the agent allowed to
touch here.

That reload used to cost me real time and real mistakes, every single switch.
It doesn't anymore, and the reason is boring in the best way: every project I
run now has the same shape.

## The same shape, different content

`coding`, `second-brain`, `knowledge-work`, `writing`: four presets, and
underneath the different starter content, they're the same skeleton:
`AGENTS.md` as the contract, `STATE.md` as the one place that answers "where
are we," typed folders for whatever this project's version of changes,
decisions, and verification looks like, and gates at the edges for the stuff
that needs a human. A coding project's `changes/` entry and a writing
project's `changes/` entry hold different content, but they're the same kind
of thing, checked the same way, by the same commands.

That sameness is the entire value. Once the shape is fixed, switching
projects stops being "relearn how this one is organized" and becomes "read
the one file that always exists in the same place." `STATE.md` is `STATE.md`
whether I'm three files into a Python refactor or two drafts into an
editorial pipeline. I don't have to remember whether *this* project tracks
status in a Notion doc, a Slack pin, or someone's memory. It's always the same
file, always the same three questions answered: focus, status, next.

## Where this comes from: it helps me maintain context in every one of my projects

That's the sentence underneath all of this, and it's the actual reason I
built the thing instead of just living with the friction. Typed graphs are
elegant, sure, but that's not why I use them daily. It's that running
several projects at once used to mean carrying all their context in
my own head, re-deriving it every time I switched, and losing pieces of it
whenever I stepped away for more than a few days. Vivary's job, stated
plainly, is to hold that context outside my head, in a form checkable enough
that I trust it, structured consistently enough that I don't have to relearn
the structure every time I open a different project.

## What switching costs collapse into

Before: open a project, spend ten or twenty minutes reconstructing where
things stand, sometimes get it wrong, sometimes discover a decision got
reversed and nobody told the file that was supposed to know.

Now: open the project, read `STATE.md`, and I'm oriented in under a minute.
If I need more, `tropo find "what's the current focus"` gives me a small,
budgeted context packet instead of a pile of files to read myself. If I'm
handing the session to an agent, it does the exact same thing: reads
`STATE.md`, pulls a module index instead of the whole tree, and runs `tropo
blast` before touching anything with dependents. The agent and I are using
the same recovery mechanism, because it's the same workspace shape regardless
of which project it is.

This is also why adoption mattered enough to build a whole release around
it (see [the adoption line](/blog/the-adoption-line/) if you haven't read
it). Most of my projects didn't start life as Vivary workspaces. They were
already real, already messy, already had their own half-formed conventions.
`create-vivary adopt` is what let me bring the same shape to projects that
already existed instead of only getting this benefit on things I start from
scratch. If every new project gets the shape but every existing one doesn't,
you've just added a sixth kind of project to keep track of: the ones that
don't fit the pattern. Adoption is what makes "one substrate" actually mean
*every* project, not just the new ones.

## Same commands everywhere

The other half of this: the CLI surface doesn't change per project type.
`tropo check`, `tropo find`, `doctor`, `ozone review`: the same commands,
the same exit codes, the same `--json` flag, whether I'm in a codebase or a
manuscript folder. I don't hold four different mental models of "how do I
check if this project is healthy." I hold one, and it applies everywhere:

```bash
create-vivary doctor .
tropo check
```

That's it, in any of the four project types. The content behind those
commands differs (a coding workspace's graph has modules and verification
edges tied to tests; a writing workspace's graph has manuscripts and
editorial review) but the mechanism, the commands, and the trust model are
identical. I don't context-switch on *how to check whether things are okay*,
only on *what the project actually is*.

## The actual claim

I'm not claiming a typed graph makes every project the same. It doesn't, and
shouldn't. A codebase and a content pipeline have genuinely different
needs, which is exactly why there are four presets instead of one. The claim
is narrower and, I think, more useful: the *scaffolding* around the actual
work (how you find status, how you check health, how gates fire, how memory
is typed) can be identical across every project you run, even though the
work inside it isn't. That's what collapses the switching cost. Not that
projects become interchangeable, but that the parts of context-switching that
were never about the actual work stop taking any time at all.

If you want to see this land in a specific project shape, [Vivary for
coding](/blog/vivary-for-coding/) and a follow-up post on Vivary for writing
go deep on two of the four presets. [Getting started](/getting-started/) is
where to actually stand one up, and the [command reference](/commands/) is
the one CLI surface I mentioned above, in full.
