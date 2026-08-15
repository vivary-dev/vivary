---
title: "Run Vivary with local models"
description: "Vivary is plain files and standard-library CLIs, so it doesn't care where the model runs. Here's how to use it entirely with local models, and how to get good results from smaller ones."
date: 2026-06-17
author: "Jeff Kazzee"
tags: ["guide", "local-models", "privacy"]
---

Vivary never talks to a model. That sounds odd for agent infrastructure, but it's the
whole reason this works offline: the CLIs (`tropo`, `ozone`, `exo`, `create-vivary`)
just read and write files on your disk. The *harness* talks to the model. Swap a
cloud model for a local one and Vivary doesn't notice.

So you can run an entire agent-native workspace with no data leaving your machine.
Here's how, and how to make smaller models behave.

## The setup

You need three pieces: a local model server, a harness that can point at it, and a
Vivary workspace.

**1. A local model server.** Any of these expose an OpenAI-compatible endpoint:

- [Ollama](https://ollama.com) (`ollama serve`, then `ollama pull` a model)
- [LM Studio](https://lmstudio.ai) (a GUI with a built-in local server)
- [llama.cpp](https://github.com/ggml-org/llama.cpp) (`llama-server` for the
  hands-on route)

Pick one and load a capable instruct or coding model that fits your hardware. A
model with strong instruction-following and tool-use matters more here than raw size.

**2. A harness pointed at it.** Most agent harnesses let you set a custom base URL
and model name. Point yours at your local server's endpoint (commonly something like
`http://localhost:11434/v1` for Ollama) instead of a cloud provider. The harness now
runs your local model with the same tools it always had.

**3. A workspace.** Scaffold one the usual way:

```bash
npx --yes @vivary/create@0.3.1 my-workspace
uvx --from create-vivary==0.3.1 create-vivary doctor my-workspace
```

That's it. The agent now operates a real workspace using a model running on your own
hardware.

## Why this is a good fit for local models

Smaller local models have a smaller, more easily confused context. Vivary's structure
is unusually kind to them, because it does the remembering so the model doesn't have
to:

- **Retrieve, don't recall.** Instead of asking the model to hold the whole project
  in its head, the workspace lets it pull just what's relevant with `tropo graph` and
  `tropo blast <id>`. Less context, fewer mistakes.
- **State lives on disk.** `STATE.md` carries "where are we" between turns, so a model
  with a short memory still picks up where it left off.
- **The gate is deterministic, not the model.** `tropo check` and `ozone review` are
  plain Python. They catch a broken graph whether the model noticed or not, so a
  weaker model is backstopped by tooling that never has an off day.

In other words, the parts that need to be reliable don't depend on the model being
clever. That's the difference between a local-model setup that's a toy and one you'd
actually trust.

## Tips for getting good results

- **Prefer the coding-tuned models** for coding workspaces; instruction-following and
  clean tool-calls matter more than trivia.
- **Keep turns small.** Ask for one change, verify with `tropo check`, then continue.
  Small loops play to a local model's strengths.
- **Lean on the skills.** The strato and loops skills give the model a written
  procedure to follow, which steadies a smaller model far more than a long prompt.
- **Let the gates do the judging.** Don't ask the model to self-certify a risky
  change. Run `ozone impact <id>` to name the blast radius and stop at a human gate.

## When local is the point

Some work can't leave the building: client code under NDA, regulated data, anything
you simply don't want sent to a third party. Because Vivary is local files and local
CLIs, an air-gapped or fully-private setup isn't a special mode, it's just the default
with a local model plugged in.

New to the pieces here? Start with [harnesses,
explained](/blog/harnesses-explained/), then [get
started](/getting-started/).
