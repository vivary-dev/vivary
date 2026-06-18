---
title: "Why I built Vivary"
description: "Every serious AI-agent project ends up rebuilding the same five things by hand. Vivary is what happens when you stop rebuilding them and ship the layer instead."
date: 2026-06-10
author: "Jeff Kazzee"
tags: ["origin", "agents", "philosophy"]
---

I kept building the same thing by accident.

Every time I started a new project with an AI coding agent, the first hour went the
same way. I'd make a `notes.md`. Then a file of "rules" so the agent would stop
forgetting things. Then a place to track what we were working on, because the agent
had no memory between sessions. Then some scratch folder for decisions, because I
couldn't remember why we'd done things three days later either. Then a private file
for the stuff I didn't want committed to a public repo.

By the third project I realized I wasn't improvising. I was re-implementing the same
small system, badly, every single time. And it always rotted: the notes drifted out
of date, the "rules" contradicted each other, the state file lied.

## The pattern under the pile

If you watch enough agent projects, the same need shows up underneath all of them,
no matter the stack or the task:

> A self-improving loop running over a typed, navigable knowledge graph, with one
> visible state surface and human gates.

That sentence is the whole product. Everything Vivary ships is just a concrete facet
of it. Pull it apart and you get five things every serious agent project eventually
invents:

1. **Typed project memory.** Not a flat `notes.md`, but a small validated graph of
   what the project knows: its modules, changes, decisions, and how they relate.
2. **Visible state.** One surface, `STATE.md`, that the agent reads at the start of a
   turn and updates at the end. No more guessing where things stand.
3. **Reusable skills.** The procedures the agent runs, written down once instead of
   re-explained in every prompt.
4. **Private boundaries.** The personal context (who you are, durable memory) that
   should never land in a public commit.
5. **Verification gates.** The checks and the human sign-off that stop a confident
   agent from shipping something wrong.

Nobody hands you these. You build them by hand, or you feel their absence.

## A small, well-formed world

The name is the thesis. A *vivary* is an old word for a vivarium: a self-contained
world where living things are kept, arranged in stacked layers. That is exactly what
a good agent workspace is. The agent lives inside it. It needs a substrate to stand
on, an atmosphere of rules and review around it, and gates at the edges.

So Vivary scaffolds that world in one command and gets out of the way. It is plain
Markdown and a few tiny CLIs. There is no runtime to adopt, no editor you must use,
no model you must buy. It works in Claude Code and Codex, in vim, or in nothing at
all. The design law it inherited from its predecessors is blunt: the framework must
cost almost nothing to load, or it steals the context the actual work needs.

## Why bother making it real

I could have kept my personal pile of templates. Plenty of people have one. But a
pile of templates is not a standard, and the interesting thing about this problem is
that *nobody had standardized it*. Web stacks got `create-t3-app`. Agent workspaces
got a thousand private `notes.md` files.

Vivary is my attempt to name the missing layer and ship it: typed memory, visible
state, reusable skills, private boundaries, and gates, scaffolded and verifiable in
minutes. If you have ever felt yourself rebuilding that pile for the fourth time,
this is the thing I wish I'd had on project one.

[Try it](/getting-started/), or read [what an agent-native workspace actually
is](/blog/what-is-an-agent-native-workspace/).
