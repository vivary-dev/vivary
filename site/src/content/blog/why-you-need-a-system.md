---
title: "Why you need a system like Vivary"
description: "Agents forget between sessions, projects rot, and context is the real bottleneck. The case for a typed, checkable system instead of another pile of notes."
date: 2026-07-17
author: "Jeff Kazzee"
tags: ["philosophy", "agents", "context"]
draft: true
---

Here's the failure mode, and you've probably lived it: you spend a session getting
an agent up to speed on a project, you make real progress, and then the session
ends. Tomorrow, or in a fresh chat, that agent knows nothing. Not "knows less,"
knows nothing. You're back to re-explaining the shape of the codebase, the
decisions you already made, the thing you agreed not to touch until next quarter.
Multiply that by every project you run at once and you're not doing the work
anymore, you're doing orientation, over and over, forever.

That's not an agent problem. It's a memory problem, and it was always going to
show up once the thing doing the work stopped being a person with continuous
memory and started being a model that reloads from zero every session.

## Context is the bottleneck, not capability

Model capability keeps improving. That's not the constraint anymore. The
constraint is: how much of what matters can you get in front of the model
before it has to act? A brilliant model with no context makes confident, wrong
decisions. A mediocre model with the right five files in front of it makes
reasonable ones. Everything about how you structure a project either shrinks
that gap or widens it.

Unstructured context widens it. A giant `notes.md` you have to re-read in full
because nothing in it says what's still true. A `README.md` that describes the
project as it was six months ago. Decisions that live only in a Slack thread
or your own head. None of that is retrievable in the way an agent, or a human
returning after a break, actually needs: a small, current, checkable answer
to "where are we and why."

## The five things, rebuilt by hand every time

I've written about this before: every serious agent project ends up
reinventing the same handful of things, typed memory, one visible state
surface, reusable skills, private boundaries, verification gates, usually
badly, usually late, usually after the pain of not having them has already
cost you a few confused sessions. I won't re-list them here; [why I built
Vivary](/blog/why-i-built-vivary/) goes through all five and why nobody had
standardized them.

I built Vivary for myself first. I use it in every project I run now: this
codebase, my writing, my notes. Almost none of that started as a clean
Vivary workspace; nearly all of it was already a real, messy, brownfield
project before I brought the system to it.

What I want to add here is the first-principles version of *why* those five
specifically, and not some other five. They're not arbitrary. They map onto
the actual failure modes of running an agent over time:

- Agents forget between sessions, so you need memory that persists and is
  worth trusting.
- Trust requires knowing what's stale, so memory needs a type system, not
  just a pile of prose.
- Multiple things happen across a project at once, so you need one place
  that says where things stand right now, not scattered across five files.
- Procedures get re-explained every time, so they should be written down
  once as skills, not re-typed into every prompt.
- Confident agents can be confidently wrong, so something has to stop and
  ask a human before the expensive or irreversible stuff.

Each one is a direct answer to a specific way agent work goes wrong without
it. That's the case for a system, not a preference for tidiness.

## What changes when the system is typed and checkable

Here's the part that's easy to undersell: the difference between "we have
documentation" and "we have a system" is whether a machine can tell you when
it's wrong.

A flat `STATE.md` reads fine right up until it's lying to you, and nothing
tells you when that happens. A typed graph, Vivary's `tropo` layer, makes
facts into fields: a change has a `status`, a `verification` edge, maybe a
`related_decisions` list that points at a real document or doesn't. Run `tropo
check` and it either passes or tells you exactly what's broken: an untyped
file sitting outside any registered folder, a reference that points at
nothing, frontmatter that just repeats what the folder structure already
implies. None of that is possible to ask of a paragraph of prose. A sentence
can't fail a check. A typed field can.

That's the actual shift. Not "more organized notes," but notes a script can
audit. `doctor` verifies the shell is intact and privacy boundaries are
actually enforced, not just documented. `ozone review` looks at the whole
graph's relationships, not just each file in isolation, and flags a change
with no verification attached or a module with no index. None of that
replaces judgment. It just means the boring, mechanical parts of "is this
memory still trustworthy" get checked automatically instead of by whoever
happens to notice something's off three weeks later.

## Where this leaves you

You don't have to take my word that this compounds. You can watch it fail to
compound in a project that doesn't have it. Pick any repo you've worked on for
more than two months without an explicit memory system, and ask: could a new
agent (or a new hire) get oriented from what's written down, or would they
need you to sit next to them for an hour? If it's the second one, you're
carrying the system in your head, and that doesn't scale past one person or
one session.

Vivary is my answer to that specific gap: a standard, plus a scaffolder,
so the typed-memory-plus-gates system isn't something you build from
scratch on project four. [Getting started](/getting-started/) walks through
standing one up in a few commands; the [command reference](/commands/) has
the full CLI if you'd rather read the flags first. If you want the origin
story and the five things in full, that's [why I built
Vivary](/blog/why-i-built-vivary/).
