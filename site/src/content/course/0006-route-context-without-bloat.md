---
title: "Route context without bloat"
shortTitle: "Route context without bloat"
description: "A short source-grounded lesson on routing versus owning context in a Vivary workspace."
order: 5
module: "02"
moduleTitle: "Strato: the agent operating loop"
status: "Baseline"
minutes: 9
tags: ["strato", "context-routing", "agents-md", "state-md"]
outcomes:
  - "Classify any workspace file as a routing surface (thin, always loaded) or an owner (canonical detail lives once), using Architecture's design law."
  - "State the fixed dispatch chain: modules/index.md routes to a module's own index.md, which links deeper only when the task proves it matters."
  - "Name the private, Git-ignored boundary — USER.md/MEMORY.md and memory/, heartbeat-reports/ — that a routing surface never quotes."
sources:
  - label: "Vivary Architecture — Design law and DRY/progressive disclosure"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/ARCHITECTURE.md"
    locator: "§2 The first-principles baseline, L33-42"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Vivary Getting Started — the complete workspace file list and sidecar files"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/GETTING-STARTED.md"
    locator: "§2 Create a workspace, L104-123"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Vivary Concepts — private boundaries, defined"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/CONCEPTS.md"
    locator: "§The five things Vivary creates, L44-53"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
interactions:
  - id: "0006-status-surface"
    kind: "multiple-choice"
    prompt: "STATE.md says \"we finished the migration; next we validate the gate.\" Which file is that?"
    options:
      - text: "STATE.md — the single visible current status surface."
        correct: true
        feedback: "Right. STATE.md is read first and updated last, so Focus/Status/Next never scatters across other files."
      - text: "AGENTS.md — the per-turn loop-and-gates contract for agents."
        feedback: "AGENTS.md owns the per-turn contract the agent follows, not a running status report."
      - text: "modules/index.md — the module dispatch table for routing."
        feedback: "modules/index.md only tells an agent which module index to open next; it never reports status."
      - text: "SOUL.md — the agent's identity and personality file."
        feedback: "SOUL.md owns identity and principles, not the Focus/Status/Next snapshot."
    success: "Correct — one status surface, read first, updated last."
    reveal: "STATE.md is the only file allowed to say \"where are we,\" so nobody has to guess which copy is current."
  - id: "0006-dispatch-chain"
    kind: "multiple-choice"
    prompt: "An agent needs deep context on the trust-controls module. What does it open first?"
    options:
      - text: "modules/index.md, then follow its link to that module's own index.md."
        correct: true
        feedback: "Right — the dispatch table routes you to the one module index before anything deeper opens."
      - text: "Open modules/trust-controls/index.md directly first, skipping the top-level dispatch table entirely."
        feedback: "That file opens second, once the top-level dispatch table has already pointed you there."
      - text: "Open AGENTS.md first, because it defines the per-turn agent contract."
        feedback: "AGENTS.md governs how a turn runs; it doesn't route between modules."
      - text: "Open STATE.md first, to review the currently active project status."
        feedback: "STATE.md reports current status, not which module index holds the deep context."
    success: "Correct — modules/index.md dispatches, then the module's own index.md, then deeper links only if the task proves they matter."
    reveal: "That's the whole chain: dispatch table, then module index, then a deeper link — in that order, every time."
  - id: "0006-owning-skill"
    kind: "multiple-choice"
    prompt: "Where do the exact CLI flags a migration skill needs actually live?"
    options:
      - text: "In the owning skill — the one place that detail exists."
        correct: true
        feedback: "Right. One fact, one owner; a routing surface may link to it, never copy it in."
      - text: "Duplicated into AGENTS.md so every agent sees detailed instructions each turn."
        feedback: "AGENTS.md holds the loop and the gates, not a skill's own procedural detail."
      - text: "Duplicated into STATE.md so it stays visible throughout each work turn."
        feedback: "STATE.md answers where the project stands, not how one skill's command works."
      - text: "Duplicated into modules/index.md for quick agent access during every migration task."
        feedback: "modules/index.md only dispatches to a module index; it never carries a skill's own detail."
    success: "Correct — canonical detail lives once, in the owning skill, never copied into a router."
    reveal: "If a fact doesn't have exactly one named owner, that's a bug to flag — never a shortcut to take."
---

> A router that starts memorizing facts stops being a router. It becomes a second, staler copy of whatever file already owns the truth — and now two files can quietly disagree with each other, forever.

## Why this exists

Your goal here is boring but load-bearing: given any file in a Strato workspace, say in one breath whether it's a **routing surface** — small, always loaded, either dispatch-only or the sole owner of one narrow, current fact — or an **owner**, the one place a fact's full detail actually lives. Architecture states the design law plainly: *"every always-on file competes with the user's task for context... Fewer files, fewer words, more room for the work."* That sentence is the whole reason the split exists — not tidiness for its own sake, but context you don't have to spend twice.

## How it works

Follow the chain Getting Started actually ships. Think of `modules/index.md` as a hotel directory, not a guest folder: it tells you which floor to visit, never what's inside the room. It holds no fact of its own — pure dispatch, "the router that tells agents which module index to open." From there an agent opens that module's own `index.md`, also dispatch-only, and follows deeper links "only when the task proves they are relevant." That's progressive disclosure, and Architecture is explicit that it "only works if it lowers the active load."

Two routers get to own something directly, and only one narrow fact each. `AGENTS.md` owns "the contract the agent follows each turn (the loop and the gates)" itself — not a copy of any module's deeper reasoning. `STATE.md` owns "the one place that answers 'where are we?' (Focus / Status / Next)," read first and updated last. Neither may hold a second copy of a module's deep context, a skill's procedure, or an identity.

Canonical detail lives once, in "the owning typed file or skill" — a decision note, a source file, a test, a skill's own procedure — and a router may link to it, never restate it. `SOUL.md` is an owner too, of a different kind: personality and principles, not a dispatch table.

Sidecars don't change this shape; they extend it. Enabling `--active-context cocoindex-code` or `--memory local`/`cognee` adds more *owning* files — `docs/active-context.md`, `docs/semantic-memory.md`, `.vivary/memory.toml` — not more copies of what the routers already say.

## Don't conflate

- **A router owning its one fact is not the same as a router owning deep context.** AGENTS.md owning the loop contract, and STATE.md owning the current snapshot, are both allowed — that fact is narrow, current, and has nowhere else to live. A router restating a module's deep reasoning is the bug this lesson exists to catch.
- **STRATO.md is a mechanism doc, not a per-turn router.** You read it once to understand how the agent operating system works; you don't route through it every turn the way you do AGENTS.md or STATE.md.
- **Private is a separate axis from routing.** `USER.md`, `MEMORY.md`, `memory/`, and `heartbeat-reports/` are private and Git-ignored — the agent writes there, but no router ever quotes them back into a shared file.

## Try it on a real workspace

Pick one real fact from your own workspace — a decision, a config value, a procedure. Name the single file that should own it, then list every routing file allowed to point at it without repeating it. If you find that same fact stated in two places, that's not redundancy for safety — that's the exact drift this lesson exists to stop.

## One-minute recall

1. Four routers: `AGENTS.md` (loop-and-gates contract), `STATE.md` (Focus/Status/Next), `modules/index.md` (dispatch only), `modules/<id>/index.md` (module dispatch only).
2. One owner category: the owning typed file or skill — plus `SOUL.md` for identity.
3. Two private, Git-ignored pairs: `USER.md`/`MEMORY.md` and `memory/`/`heartbeat-reports/`.
4. Strato's status, from memory: baseline, shipped, bundled source — never a separately published package.

Tomorrow, before you open `modules/index.md` for real work, redraw this split without looking. If a fact doesn't have exactly one named owner, that's a bug to flag — never a detail to duplicate into a router.

## Sources

- [Vivary Architecture — Design law and DRY/progressive disclosure](https://github.com/vivary-dev/vivary/blob/dev/docs/ARCHITECTURE.md)
- [Vivary Getting Started — the complete workspace file list and sidecar files](https://github.com/vivary-dev/vivary/blob/dev/docs/GETTING-STARTED.md)
- [Vivary Concepts — private boundaries, defined](https://github.com/vivary-dev/vivary/blob/dev/docs/CONCEPTS.md)
