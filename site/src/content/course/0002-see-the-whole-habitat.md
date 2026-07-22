---
title: "See the whole habitat"
shortTitle: "Whole habitat"
description: "A short source-grounded lesson on the complete Vivary product map."
order: 1
module: "00"
moduleTitle: "Whole habitat and vocabulary"
status: "Baseline"
minutes: 10
tags: ["orientation", "product-model", "tropo", "strato", "whole-habitat"]
outcomes:
  - "State Vivary's one-sentence definition and name the four obligations it implies."
  - "Sort Tropo, Strato, Ozone, and Exo into baseline vs. optional layers without mistaking either for a sidecar or Lattice."
  - "Explain why sidecars, Lattice, and neighbor products never count as shipped baseline Vivary."
sources:
  - label: "Vivary README — mental model and modules"
    url: "https://github.com/vivary-dev/vivary/blob/dev/README.md"
    locator: "L156-L176 (mission sentence; Modules)"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Vivary Architecture — the layer model"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/ARCHITECTURE.md"
    locator: "§3 The layer model, L63-L119"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
interactions:
  - id: "0002-baseline-layers"
    kind: "multiple-choice"
    prompt: "Which statement assigns the two baseline jobs correctly?"
    options:
      - text: "Tropo provides graph truth; Strato operates the loop."
        correct: true
        feedback: "Right. Tropo is the dense, ground-level layer that holds what the workspace knows; Strato is the layer that runs the per-turn loop on top of it."
      - text: "Ozone provides graph truth; Exo operates the loop."
        correct: false
        feedback: "Ozone reviews relationships and Exo coordinates agents — neither one owns graph truth or the operating loop."
      - text: "Strato provides graph truth; Tropo operates the loop."
        correct: false
        feedback: "That's the two baseline layers with their jobs swapped. Tropo is the graph; Strato is the loop."
      - text: "Exo provides graph truth; Ozone operates the loop."
        correct: false
        feedback: "Exo coordinates who acts and Ozone reviews what changed — neither owns graph truth or the loop either."
    success: "Correct. Tropo plus Strato is the irreducible baseline."
    reveal: "Compression: Tropo = knows. Strato = operates."
  - id: "0002-sidecar-classification"
    kind: "multiple-choice"
    prompt: "How should semantic recall be classified?"
    options:
      - text: "Semantic recall is an optional sidecar capability."
        correct: true
        feedback: "Right. It's opt-in, and its candidates may point at graph node IDs — they never become the graph itself."
      - text: "Semantic recall is a baseline graph capability."
        correct: false
        feedback: "The baseline graph exists and works fine with zero semantic recall installed."
      - text: "Semantic recall is a required review capability."
        correct: false
        feedback: "Review belongs to Ozone. Recall only returns candidates for a human or agent to consider."
      - text: "Semantic recall is an experimental evidence capability."
        correct: false
        feedback: "It ships today as an optional capability — it isn't Lattice's experimental evidence architecture."
    success: "Correct. Recall adds capability without taking ownership of graph truth."
    reveal: "Invariant: candidates may point to known node IDs; the graph files stay the truth."
  - id: "0002-lattice-classification"
    kind: "multiple-choice"
    prompt: "Where does Lattice belong on the whole-product map?"
    options:
      - text: "Lattice is experimental target architecture, not baseline."
        correct: true
        feedback: "Right. It explores Vivary's end-state direction; an implemented lab slice doesn't promote it to shipped baseline."
      - text: "Lattice is shipped baseline architecture, not optional."
        correct: false
        feedback: "A working lab slice existing doesn't make the whole architecture baseline Vivary."
      - text: "Lattice is required storage architecture, not experimental."
        correct: false
        feedback: "Storage is an independent sidecar axis. Lattice is about governed context and evidence, a separate concern."
      - text: "Lattice is default coordination architecture, not neighboring."
        correct: false
        feedback: "Exo owns coordination today. Lattice explores governed context and evidence, not agent coordination."
    success: "Correct. Lattice stays valuable precisely because its experimental status stays visible."
    reveal: "Use it later: Lattice is a deep course module, not the definition of all Vivary."
---

> Vivary is not four equally load-bearing products wearing a shared brand. It's one self-improving loop wearing four hats — and only two of those hats hold up the building.

## Why this exists

Say "Vivary" to three people and you'll get three different mental models, and at least one of them will be wrong in a way that costs real debugging time later. The fix is not memorizing a feature list. It's learning which surfaces are load-bearing, which are optional-but-shipped, which are opt-in capability, and which are still under construction — before you touch any of them.

Your job in this lesson is narrow on purpose: learn the baseline deeply, use optional layers deliberately, enable sidecars safely, and talk about Lattice without quietly promoting it to "how Vivary works today." The primary definitions come from the [Vivary README](https://github.com/vivary-dev/vivary/blob/dev/README.md) and its [architecture doc](https://github.com/vivary-dev/vivary/blob/dev/docs/ARCHITECTURE.md). Commands and statuses in this course are cross-checked against those docs because roadmap prose can drift ahead of what's actually shipped.

## How it works

Hold the whole product in one line:

> **Vivary is a self-improving loop** running over a typed, navigable knowledge graph, with one visible state surface and human gates.

That sentence carries four obligations — durable graph truth, an operating loop, visible state, and explicit approval boundaries — and every module either supplies one of those four or sits optionally around them.

The four modules are named for atmospheric altitude, which tells you role, not install order:

- **Tropo · graph truth** — the typed, navigable knowledge graph. Folder placement decides type; checks fail closed on broken structure. Baseline, shipped, published CLI.
- **Strato · agent OS** — visible state, memory, the per-turn loop, gates, self-improvement. It's bundled workspace source, not a separately published package. Baseline, shipped.
- **Ozone · review** — graph-aware code and editorial review: relationships, impact, verification gaps, context-budget pressure. Optional layer, shipped.
- **Exo · coordination** — the thinnest outer layer: claims, conflicts, board, roles for multi-agent work. It coordinates who acts; it does not prove correctness. Optional layer, shipped.

Only Tropo and Strato are irreducible. Ozone and Exo are real, shipped, useful — and skippable.

## Don't conflate

Four categories look similar from a distance and are not the same thing:

- **Optional layers** (Ozone, Exo) are shipped and load exactly like baseline modules — they're just not required to have a working loop.
- **Optional sidecars** — embedded LanceDB storage, local/Cognee semantic recall, the CocoIndex-code active-context adapter, Obsidian visualization — require an explicit choice at setup time. Recall candidates may *reference* graph node IDs; they never *become* graph truth.
- **Lattice** is the experimental target: governed Task Capsules, checks, receipts, events, evidence, and causal inspection. It explores where Vivary is headed. It is not the shipped baseline, no matter how far along a given lab slice is.
- **Neighbors** — Bellamente, Agent Relay, Entire — may supply recall, migration input, or provenance, but they remain separate products from Tropo, Strato, Ozone, and Exo.

One more distinction that matters more than it sounds: the README and Getting Started guide don't fully agree on how installation presets compose. The README implies presets *choose* optional layers; Getting Started says presets share the same structure and differ only in starter notes. Treat exact preset composition as unresolved until generated output or the running CLI proves it one way — don't repeat either claim as settled fact.

Underneath all of this sits a short list of permanent boundaries: no hidden embeddings, MCP, daemon, network calls, auto-indexing, whole-repository context, or ungated mutation, ever, by default. Optional capability has to stay visibly optional or it isn't optional.

## Try it on a real workspace

Pick one real Vivary workspace — yours or a public example. For every surface you find in it (a `tropo.toml`, a `strato/` directory, an `ozone` invocation in CI, an `exo` claim, LanceDB config, a Cognee adapter), name its ring — baseline, optional layer, optional sidecar, experimental, or neighbor — and justify that call from the README or architecture doc, not from vibes. If you can't find the justification in the docs, that's a signal to check current CLI behavior instead of guessing.

## One-minute recall

Redraw the map from memory, in this order:

1. Center: write **Tropo + Strato**.
2. Next ring out: write **Ozone + Exo**.
3. Outside that: three separate boxes for **sidecars**, **Lattice**, and **neighbors**.
4. Underneath everything, write the loop: **Ask → retrieve → act → verify → learn → gate**.

Tomorrow, before you open the whole-product docs again, redraw it cold. If a surface lands in the wrong ring, say out loud which authority you accidentally handed it.

## Sources

- [Vivary README — mental model and modules](https://github.com/vivary-dev/vivary/blob/dev/README.md)
- [Vivary Architecture — the layer model](https://github.com/vivary-dev/vivary/blob/dev/docs/ARCHITECTURE.md)
