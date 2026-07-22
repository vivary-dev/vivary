---
title: "Operate one complete turn"
shortTitle: "Operate one complete turn"
description: "A short source-grounded lesson on operating one complete Strato turn."
order: 6
module: "02"
moduleTitle: "Strato: the agent operating loop"
status: "Baseline"
minutes: 10
tags: ["strato", "operating-loop", "gates", "turn"]
outcomes:
  - "Recite the six-stage turn in order — Ask, retrieve, act, verify, learn, gate — and explain why retrieve precedes act."
  - "Explain why a clean verify never substitutes for the human gate on push, publish, install, memory-write, or destructive operations."
  - "Distinguish the inner turn (every turn) from the outer turn (heartbeat and self-improve) as the same mechanism running at two speeds."
sources:
  - label: "Vivary Getting Started — Operate the loop"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/GETTING-STARTED.md"
    locator: "§5 Operate the loop, L170-183"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Vivary Architecture — throughline + flywheel, inner and outer turn"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/ARCHITECTURE.md"
    locator: "§2 The first-principles baseline, L19-31"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Vivary HOWTO — Publish your own Vivary-based tool (gated)"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md"
    locator: "§Publish your own Vivary-based tool (gated), L292-295"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
interactions:
  - id: "0007-stage-order"
    kind: "multiple-choice"
    prompt: "Which option lists three consecutive stages of one Strato turn in the correct order?"
    options:
      - text: "Retrieve, then act, then verify."
        correct: true
        feedback: "Right — the graph gets consulted before anything changes, and nothing is verified before it happens."
      - text: "Act, then retrieve, then verify."
        feedback: "Acting before retrieving skips the graph-first rule; retrieve always comes first."
      - text: "Verify, then act, then learn."
        feedback: "Verify confirms what act already did — it can't run before act does."
      - text: "Gate, then verify, then learn."
        feedback: "Gate is the very last stage of all; verify and learn both happen before it."
    success: "Correct — retrieve, act, verify is the fixed order, no exceptions for small turns."
    reveal: "Ask, retrieve, act, verify, learn, gate. Skip the order and the turn goes stale."
  - id: "0007-retrieve-first"
    kind: "multiple-choice"
    prompt: "An agent needs context on the billing module before acting. What should it do first?"
    options:
      - text: "Query the graph, then open one relevant module index."
        correct: true
        feedback: "Right — the graph is the first source of truth; notes come second, and only the one module that matters."
      - text: "Load the entire repository tree before making any decision."
        feedback: "That's exactly the bloat modules/index.md exists to prevent — pick one module, not the whole tree."
      - text: "Open every available module index to compare them first."
        feedback: "modules/index.md exists so you pick one module index, not survey all of them up front."
      - text: "Skip retrieval and act on the raw request alone."
        feedback: "Retrieve always precedes act in the turn contract — it's never skipped, however small the ask."
    success: "Correct — graph first, notes second, one module index at a time."
    reveal: "tropo graph / tropo blast <id> before notes; modules/index.md before the whole tree."
  - id: "0007-gate-after-clean-verify"
    kind: "multiple-choice"
    prompt: "STATE.md shows verify is clean — tropo check and ozone review both passed. The next step is a git push that opens a PR. What now?"
    options:
      - text: "Stop and name the blast radius before the human gate fires."
        correct: true
        feedback: "Right — a clean verify clears verify. git push/PR is still its own named human gate."
      - text: "Push immediately since verification passed all required checks for this branch."
        feedback: "A clean check clears the verify stage; it doesn't authorize the separate gate stage."
      - text: "Batch this gate with the next few turns to save time."
        feedback: "Gates are never batched — each risky step stops on its own, every time."
      - text: "Skip the gate since ozone review already approved this proposed push."
        feedback: "ozone review is part of verify, not a substitute for the human gate."
    success: "Correct — verify and gate are separate stages; a clean check never authorizes a push on its own."
    reveal: "Name the blast radius, then stop at the human gate — publishing, installs, push/PR, and destructive ops all get the same stop."
---

> Ask → retrieve → act → verify → learn → gate isn't reserved for the big scary changes — it's the whole turn, every time, including the one-line fix you were about to just... do.

## Why this exists

This lesson is about running a single turn correctly — not describing Strato's files in the abstract. Every turn asks, retrieves from the graph before notes, acts, verifies, learns, and stops at a gate. Getting Started names the contract directly: *"Ask → retrieve → act → verify → learn → gate."* Architecture explains why the same shape repeats at two speeds: the self-improving loop that runs fast, inline, every turn also runs slow, on a heartbeat, distilling what got learned into durable memory, playbooks, and skills — "inner turn and outer turn of one mechanism."

## How it works

Walk it stage by stage, order fixed:

1. **Ask** — frame the scoped task before touching a file. There's no "too small to gate" exemption; the contract in `AGENTS.md` governs even a one-line fix.
2. **Retrieve** — "with `tropo graph` / `tropo blast <id>`: the graph is the first source of truth, notes second." Use `modules/index.md` to pick one module index instead of loading the whole tree.
3. **Act** — the scoped change the retrieved context actually supports, not a wider one the graph never confirmed.
4. **Verify** — "with `tropo check` and `ozone review` before a gate." A turn doesn't reach the gate on an unverified claim.
5. **Learn** — feeds the outer loop, deliberately, never silently inline. Heartbeat audits on a cadence; self-improve distills what repeated across turns into playbooks and skills after a slice, a bug, or a handoff.
6. **Gate** — "name the blast radius (`ozone impact <id>`) for a risky change, and stop at the human gates (memory writes, publishing, installs, git push/PR, destructive ops)."

Notice what "gate" actually is here: two jobs stacked, not one. Naming the blast radius is impact analysis — the turn should already know what it found before it asks a human to approve something risky. Stopping is the second, separate job, and it fires only at the specific actions named on that list. HOWTO spells one of them out directly: *"Publishing (PyPI/npm), creating orgs/repos, pushing, and opening PRs are human gates — one explicit approval per item... don't batch them."*

## Don't conflate

- **Inner turn and outer turn are the same mechanism, not two systems.** Every turn runs the fast loop; heartbeat and self-improve are the same `learn` step, distilled later, running slower.
- **Verify is not the gate.** A clean `tropo check` and `ozone review` clear verify. They do not clear a push, a publish, an install, a memory write, or a destructive op — those wait for their own named gate regardless of how clean verify came back.
- **"Learn" is not a silent inline rewrite.** What a turn found feeds heartbeat and self-improve deliberately, on their own cadence — never folded invisibly into the current turn's action.

## Try it on a real workspace

Narrate one real turn you ran recently, out loud, matching it against all six stages in order. Name the exact stage — if any — where you'd have stopped for a human. If you can't name one, you probably skipped the gate stage instead of clearing it.

## One-minute recall

1. **Ask** — frame the scoped task.
2. **Retrieve** — graph before notes; one module index, not the whole tree.
3. **Act** — scoped to what retrieval confirmed.
4. **Verify** — `tropo check` and `ozone review`, before the gate.
5. **Learn** — feeds the outer loop; heartbeat on cadence, self-improve after a slice — never inline.
6. **Gate** — name the blast radius, then stop at the human gates.

Tomorrow, before you open a file for even the smallest fix, say all six stages out loud first. If you catch yourself skipping straight to "act," that's the habit this lesson exists to break.

## Sources

- [Vivary Getting Started — Operate the loop](https://github.com/vivary-dev/vivary/blob/dev/docs/GETTING-STARTED.md)
- [Vivary Architecture — throughline + flywheel, inner and outer turn](https://github.com/vivary-dev/vivary/blob/dev/docs/ARCHITECTURE.md)
- [Vivary HOWTO — Publish your own Vivary-based tool (gated)](https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md)
