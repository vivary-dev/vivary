---
title: "Blast radius: review the way you think about risk"
description: "tropo blast and ozone impact answer what depends on the thing you're about to change, with a walked example, and why edge-level review beats file-level review."
date: 2026-07-31
author: "Jeff Kazzee"
tags: ["tropo", "ozone", "risk"]
draft: false---

A text diff answers one question well: what did this file look like before,
and what does it look like now. It answers a completely different question
badly, or not at all: what else, elsewhere in the project, depends on the
thing this diff is changing. That second question is the one that actually
determines whether a change is safe, and it's the one most review processes
never ask explicitly, because the tooling doesn't make it easy to ask.

Blast radius is Vivary's answer: name everything connected to the node you're
about to change, before you change it, so "is this safe" is a command instead
of a guess.

## The two commands, and the difference between them

```bash
tropo blast <id> --depth N
ozone impact <id>
```

They sound like the same thing and they're related but distinct, and
mixing them up is an easy mistake to make:

**`tropo blast <id>`** walks the graph tropo already has and returns
everything that transitively references the target: direct references, and
references to those references, out to whatever `--depth` you ask for. It's
graph traversal: given the edges that exist, what reaches this node.

**`ozone impact <id>`** is ozone's read of the same underlying graph, but it
annotates each dependent with its **distance** from the target and the
specific **edge field** it came in by. Where `blast` tells you *what's*
connected, `impact` tells you *how*: this thing is two hops away, connected
through a `related_decisions` edge, not a `verification` edge, which usually
changes how worried you should be about it.

In practice: reach for `tropo blast` when you want the fast, raw list.
Reach for `ozone impact` when you want to understand the shape of the
dependency, not just its existence, which is most of the time, once a
project has enough history that "two hops via a decision reference" and "one
hop via direct verification" mean genuinely different levels of risk.

## A walked example

Say you're about to change how a `payments` module handles retries, and
before touching anything you run:

```bash
ozone impact payments --root . --json
```

The graph might come back looking something like this, conceptually:

- `changes/add-stripe-retry`: distance 1, via `related_modules`. A
  currently active change that already touches this module. If you edit
  `payments` right now, you and that change are both mid-flight on the same
  surface. `exo conflicts` would flag this pair the moment both are
  `status: active`.
- `verification/payments-integration-test`: distance 1, via `verification`,
  the test that's supposed to prove this module works. If you're changing
  retry behavior, this is the test that needs to still pass, and probably
  needs new cases added, not just re-run unchanged.
- `decisions/use-exponential-backoff`: distance 2, via `related_decisions`
  through the change above, the reason retries are shaped the way they are
  today. If your change contradicts this decision, that's not just a code
  review comment, it's a decision that needs to be explicitly superseded, not
  quietly overridden by a diff nobody connects back to it.
- `modules/billing/index.md`: distance 2, via a `related_modules` reference
  from `payments`, a neighboring module that reads output from this one.
  Nothing here says "don't touch payments," but it does say "billing consumes
  what you're about to change the shape of, so check it doesn't assume the
  old retry timing."

Four dependents, at two different distances, through three different kinds
of edges: a verification, a decision, and two module relationships. A
file-level diff of `payments/retry.py` would have shown you none of that. It
would have shown you the lines that changed and nothing about what those
lines connect to.

## Why edge-level review beats file-level review for knowledge bases

This matters more, not less, once you're applying the same idea outside code.
A text diff on a decision document, a note, or a manuscript section tells you
what prose changed. It tells you nothing about what else in the graph
referenced that decision, cited that note, or built an argument on top of
that section. In a typed knowledge base, the actual risk of an edit usually
isn't in the edited file. It's in what else was relying on the edited file
saying what it used to say.

That's the case for `ozone impact` mattering just as much in a `second-brain`
or `writing` workspace as in a `coding` one. A decision note that gets marked
`superseded` might have three other documents pointing at it with a `ref`
field expecting it to still be `accepted`. `tropo check` will catch the
broken semantics only if those documents' assumptions are themselves
encoded as checkable fields, but `impact` shows you the shape of what's
connected *before* you make the edit, which is the point where you can still
decide whether superseding it needs a follow-up edit somewhere else too.
File-level diffing has no equivalent move, because a file diff doesn't know
what a graph edge is.

## Making it a habit, not a one-off

The workflow that actually sticks: before any change to a node you know has
history (anything with existing `changes/`, `verification/`, or inbound
`ref` edges) run `impact` or `blast` first, read what comes back, and only
then start editing. It costs one command and a few seconds. Skipping it costs
nothing until the day it doesn't, which is exactly the kind of risk that's
easy to underweight until it bites once.

```bash
tropo blast payments --depth 2                 # raw traversal
ozone impact payments --root . --json          # distance + edge field, per dependent
```

Wire the concept into CI as a habit for high-traffic nodes, not just an
interactive check: any change touching a module with an active dependent
change is a reasonable thing to flag in review, and `exo conflicts` already
does exactly that for two active changes sharing a target.

If you're working in a coding workspace specifically, [Vivary for
coding](/blog/vivary-for-coding/) covers where blast radius fits into the
day-to-day loop. The full flag reference for both commands is in the
[command reference](/commands/#ozone--the-review-layer); [getting
started](/getting-started/) is where to set up a workspace if you don't have
one to run these against yet.
