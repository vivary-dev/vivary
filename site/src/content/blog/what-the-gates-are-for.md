---
title: "What the gates are for"
description: "Autonomy in the body of the work, alignment at the edges: which gates fire when, and why that split is what lets you actually let an agent run."
date: 2026-08-03
author: "Jeff Kazzee"
tags: ["gates", "process", "trust"]
draft: false---

The instinct people have about agent gates, when they first hear the phrase,
is usually wrong. They picture a human checking every step (reviewing each
file write, approving each command), which isn't a gate, it's supervision,
and it defeats the point of delegating work to an agent at all. If you have
to watch every move, you haven't automated anything; you've added a slower
human-in-the-loop step to work you could have done yourself.

The actual design is closer to the opposite: give the agent real autonomy in
the body of the work, and reserve human attention for a short, specific list
of things at the edges. That split, autonomy in the middle, alignment at the
boundary, is what a gate actually is, and it's worth being precise about,
because getting the split wrong in either direction breaks something
important.

## Which gates fire, and when

Vivary's gates aren't a vague posture, they're a specific, short list, and
naming them specifically is the point: a gate you can't name isn't a gate,
it's a vibe.

- **Merge.** Code or content lands on a shared branch. This is the point
  where a mistake stops being private to one session and starts affecting
  everyone who pulls next.
- **Publish.** A package release, a blog post going live, anything that
  reaches an audience outside the workspace. Irreversible in practice even
  when it's technically revertible: you can retract a bad post, but people
  already read it.
- **Destructive operations.** Deletions, force pushes, dropped data, anything
  where the failure mode is "and now it's gone," not "and now we fix it."
- **Memory writes to shared or private surfaces.** Writing to `MEMORY.md` or
  similar durable-memory files is a gate specifically because it's supposed
  to be durable. A bad write here doesn't just affect this session, it
  poisons every future session that trusts it.
- **Installs.** Adding a dependency, running a package install: the one
  category where "just try it and see" carries real supply-chain risk, not
  just a wasted session if it's wrong.

Everything else (reading files, running the deterministic checks, drafting
code, writing a typed note, iterating on a change before it's proposed for
merge) runs without a stop. That's the autonomy half, and it has to be real
autonomy, not gated in disguise, or the whole system just becomes slow.

## Autonomy in the body, alignment at the edges

The reason this split works, and a blanket "review everything" posture
doesn't, comes down to what each half is actually good at.

The body of the work (writing, editing, running checks, iterating) is
where an agent's speed is the entire value proposition. Slowing that down
with human review doesn't make it safer; a human skimming routine work is
worse verification than `tropo check` running automatically, and slower.
Deterministic checks catch what they're good at catching, every time, for
free, without fatigue. Let that run unsupervised, not because the work is
unimportant, but because a script verifies it better than a tired human
glancing at a diff would.

The edges are where judgment does something a script can't. No check can
tell you that publishing right now, with this changelog, at this level of
confidence, is the right call. That's a judgment about timing and risk a
deterministic tool doesn't have access to. That's what a human gate is for,
and it's exactly the kind of call that doesn't scale if an agent makes it
unsupervised.

Concretely: `ozone review` is advisory by default, exit 0 even with
findings, specifically because most of what it flags is judgment territory:
an orphaned node, a change with no verification edge yet. Pass `--strict` and
it becomes a hard gate, exit 1 on any warning, which is the right call for
CI on a mature project where those warnings should never appear. The publish
and push gates never get that same option to loosen. There is no `--strict
false` for "let the agent push to main unsupervised." That boundary doesn't
move, no matter how good the agent's track record gets.

## How this made a real release safe

This isn't hypothetical. The line that shipped `vivary-tropo` 0.4.1 and
`create-vivary`/`@vivary/create` 0.3.1 ran through exactly this split, and it
caught a real defect because of it, not despite it.

The autonomy half moved fast: adversarial reviews against hostile fixtures
for `adopt`'s "only adds files" claim, a full registry smoke pass, byte-parity
checks against the prior release, all without a human approving each step,
because those are exactly the repeatable checks a script does better than a
person watching over a shoulder. One adversarial pass found real gaps in
`adopt`'s guarantees before merge, not after a user hit them. A
version-parity check caught a stale `__version__` constant that would have
shipped both `0.4.0` and `0.3.0` self-reporting the wrong version. Neither
required a human staring at the right file at the right moment, just a
check that runs the same way every time.

Publishing itself stayed manual through the whole line. No `--yes` on a
release, no automated push to the registries. That's the alignment half, and
it held even though everything upstream of it had already passed. The
adversarial reviews and the registry smokes did their job during the
autonomous part; the human gate did its job by being the last checkpoint
regardless of how clean everything upstream looked. I go through the full
mechanics of that loop, what verify and learn actually mean turn to turn,
and the version-parity story in more detail, in [the loop: ask, retrieve,
act, verify, learn, gate](/blog/the-loop/).

## Why this is what lets you let it run

The honest reason to care about this split isn't philosophical, it's
practical: it's the only version of "let an agent run unsupervised" that
doesn't require you to trust the agent's judgment about things judgment isn't
reliable for. You're not trusting the agent to know when a release is ready.
You're trusting a small number of named, fixed gates to catch the handful of
moments where a mistake would actually matter, and trusting deterministic
checks to handle everything else at a speed and consistency no amount of
careful human review matches.

That's what makes autonomy safe to grant in the first place. Not "the agent
is trustworthy," but "the few places it needs to be stopped are named in
advance, and nothing shortcuts past them."

[Getting started](/getting-started/) sets up a workspace with this gate
structure from the start, and the [command reference](/commands/) documents
`ozone review`'s advisory-vs-strict behavior in full.
