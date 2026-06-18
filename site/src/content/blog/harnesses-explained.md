---
title: "Harnesses, explained"
description: "The model writes the words. The harness decides what the model sees, what tools it can use, and what happens to its output. Here's what that means, and why Vivary stays harness-neutral."
date: 2026-06-15
author: "Jeff Kazzee"
tags: ["harnesses", "agents", "explainer"]
---

People say "the AI did it," but a model on its own can't do much. It reads text and
writes text. It can't open a file, run a command, or remember yesterday. The thing
that turns a model into an agent is the **harness**.

If you've used Claude Code or Codex, you've used a harness. It's worth understanding
what it actually does, because almost everything that makes an agent reliable (or
unreliable) happens there, not in the model.

## What a harness does

A harness sits between you, the model, and your project. On every turn it makes three
decisions:

1. **What the model sees.** It assembles the prompt: your message, plus whatever
   files, rules, and memory it decides are relevant. The model only knows what the
   harness puts in front of it.
2. **What the model can do.** It exposes tools: read a file, edit a file, run a
   shell command, search the web. The model asks; the harness executes and feeds the
   result back.
3. **What happens to the output.** It applies the edits, runs the commands, and
   decides what to keep, often pausing for your approval first.

That middle layer is the whole game. A capable model with a careless harness will
confidently overwrite the wrong file. A modest model with a careful harness, good
context and a stop-and-confirm gate, will quietly get useful work done.

## How harnesses read your workspace

Different harnesses look for different files, and this is where most of the friction
lives. Two common conventions:

- **Claude Code** reads `.claude/skills/` for procedures it can load on demand.
- **Codex** reads `AGENTS.md` and an `.agents/` directory.

Both are just looking for the same things in different places: *who am I, what do I
know, what procedures can I run, what am I not allowed to do without asking?* If your
workspace answers those questions in the files the harness checks, the agent starts
the turn oriented instead of guessing.

This is exactly what an [agent-native
workspace](/blog/what-is-an-agent-native-workspace/) is for. The workspace is the
shared, durable memory; the harness is the engine that reads it each turn.

## Why model-agnostic and harness-neutral matter

Here is the trap. If you encode your project's knowledge *inside* one harness, or
inside one model's context window, you've tied your work to that vendor. Switch tools
and you start over.

Vivary refuses to do that. The workspace is plain Markdown and YAML plus a few tiny
CLIs. The knowledge lives in files on your disk, not in a harness's private database
or a model's memory. So the same workspace works under Claude Code and Codex today,
and under whatever harness shows up next. It also works with a frontier model or a
small local one, because none of the structure depends on a particular model being
smart enough to hold it all in its head.

The harness is the engine. The model is the fuel. Vivary is the road and the map,
and it doesn't care which engine you bolted in this week.

Want to run the whole thing on your own machine with no cloud model at all? That's
the next piece: [run Vivary with local models](/blog/run-vivary-with-local-models/).
