---
title: "The loop: ask, retrieve, act, verify, learn, gate"
description: "How a Vivary turn actually runs, what each gate is for, and why this release shipped through the same loop it asks agents to follow."
date: 2026-07-15
author: "Jeff Kazzee"
tags: ["loop", "gates", "process"]
draft: true
---

`AGENTS.md` in a Vivary workspace opens with one line that's supposed to
govern every turn an agent takes:

> **Ask → retrieve → act → verify → learn → gate.**

It's easy to read that as a slogan. It's actually a sequence with a specific
job at each step, and skipping one is exactly where agent work goes wrong. Let
me walk through what each step means in practice, then show you the loop this
release itself went through, because a process that only applies to the
agents using the tool and not to the people building it isn't a process, it's
marketing.

## The six steps

**Ask.** Before acting, the agent should know what it doesn't know. What's the
actual task? What's already decided? `STATE.md` answers "where are we" so the
agent isn't guessing at the start of a turn, and if the task is genuinely
ambiguous, this is where a human gets asked instead of the agent picking an
assumption and running with it.

**Retrieve.** Not "read everything," pull the specific things relevant to this
task. `tropo graph` for the shape of what exists, `tropo blast <id>` for
what's connected to the thing you're about to change, `modules/index.md` to
pick one module instead of loading the whole tree. This is the step that a
typed graph makes cheap and a flat notes folder makes expensive — see [memory
that doesn't rot](/blog/memory-that-doesnt-rot/) for why retrieval degrades
without types, and [tropo map](/blog/tropo-map-read-the-shape/) for the
version of this that runs before any graph exists at all.

**Act.** Do the actual work: write the code, edit the doc, run the command.
This is the part everyone assumes is the whole job. It's one of six steps.

**Verify.** Before calling anything done, run the deterministic checks:
`tropo check` on the graph, `ozone review` on the relationships between
things. These are plain Python, not a model's self-assessment. A model
grading its own work is the least reliable verification available; a script
that either passes or doesn't is the most reliable one you can wire in for
free.

**Learn.** Update the record. If a decision got made, write it down as a typed
`decisions/` doc, not a comment in someone's head. If `STATE.md` is now
stale, update it before the turn ends, not "eventually." This is the step
most flat-notes setups skip entirely, because nothing forces it, and it's why
those setups rot the way I described in the previous post.

**Gate.** Before anything with real consequence, name the blast radius
(`ozone impact <id>`) and stop for a human. Memory writes, publishing,
installs, `git push`/PR, anything destructive: these don't get to happen on
an agent's own authority, full stop, regardless of how confident the run felt.

## What the gates are actually for

Gates aren't there because agents are untrustworthy in some generic sense.
They're there because verification and judgment are different things, and
only one of them scales. `tropo check` can verify a graph is well-formed
every single time, instantly, for free. No script can verify that publishing
a package right now, with this changelog, under this level of confidence, is
the right call — that's a judgment call, and judgment calls are exactly what
a human gate is for.

That's why `ozone review` is advisory by default and only becomes a hard gate
with `--strict`. You choose where the line is between "flag it" and "block
it," and the gate that actually matters, the publish/push/install gate, stays
manual no matter what.

## Proof, not theory: how this release shipped

Point this at the release this whole series is about — `vivary-tropo` 0.4.1,
`create-vivary`/`@vivary/create` 0.3.1 — and the loop isn't a description of
some ideal process, it's what actually happened.

**Retrieve and verify, repeatedly.** Every PR in the line, #98 through #105,
went through adversarial review before merge, not after. That's the loop's
verify step applied to the process itself: don't ship, then hope someone
notices a problem. Look for the problem while there's still time to fix it
without shipping a patch release.

**Learn, applied to the tooling itself.** The clearest example: `tropo
0.4.0` and `create-vivary 0.3.0` both exist on PyPI right now, and both
self-report the wrong version, because of a stale `__version__` constant.
That's exactly the kind of small, boring bug that slips through when nobody's
specifically checking for it. A version-parity test caught it before this
release shipped, which is why you should install `0.4.1` / `0.3.1`, not
`0.4.0` / `0.3.0` — same functional content, but the constant is fixed and the
parity test now guards against it happening again silently. That's a gate
doing its actual job: not preventing every mistake, catching this one before
a user did.

**Gate held even under pressure to just ship.** Publishing stayed a manual
human step through the whole line. No `--yes` on a release. No auto-push. The
verification section in the changelog for this release is not "trust us," it's
a specific, checkable list: 83 of 83 tropo tests across Python 3.11 and 3.14,
`init` byte-parity against 0.2.8 verified across five flag configurations,
only-adds and dry-run purity verified against hostile fixtures for `adopt`.
Some of that testing found real problems in `adopt`'s guarantees — I wrote
about that specifically in [adopt, don't rebuild](/blog/adopt-dont-rebuild/) —
and those got fixed pre-merge, which is the entire point of running the
verify step before the gate instead of treating the gate as a formality.

## Why this is the whole pitch

Everything else Vivary ships — the typed graph, the map, the adopt path, the
trend tracking — exists to make one or more of these six steps cheaper or more
reliable. Retrieve is cheap because the graph is typed. Verify is reliable
because it's a script, not a vibe. Learn actually happens because there's a
typed place to put what was learned instead of a `notes.md` that nobody
revisits. Gate stays meaningful because it's reserved for the few things that
actually need a human, instead of being diluted across every trivial action.

If the loop is new to you, [getting started](/getting-started/) walks through
setting up a workspace where it runs by default, and the [command
reference](/commands/) has the full CLI surface behind each step. This is
also the last post in this series — if you started elsewhere, [the adoption
line](/blog/the-adoption-line/) is where it began.
