---
title: "Prove independent ownership"
shortTitle: "Capstone"
description: "A source-grounded capstone brief for proving independent ownership of a real Vivary workspace."
order: 17
module: "10"
moduleTitle: "Capstone"
status: "Baseline"
minutes: 11
tags: ["capstone", "ownership", "greenfield", "brownfield"]
outcomes:
  - "Choose the correct capstone track — greenfield or brownfield — and its first required step."
  - "Assemble all six evidence-bundle items from a real workspace run, not a description of one."
  - "Defend one architecture boundary using primary-source language, not a restated summary."
sources:
  - label: "Getting started: install, adopt, health checks, graph, and the loop"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/GETTING-STARTED.md"
    locator: "sections 1 through 6"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "How-to recipes: CI-gate recipes"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md"
    locator: "\"Use Vivary in CI\" and \"Run Vivary as a CI gate\""
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Product roadmap: current truth vs. active roadmap work"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/PRODUCT-ROADMAP.md"
    locator: "\"Current truth\" and \"Now: prove the adoption line\""
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
interactions:
  - id: "greenfield-first"
    kind: "multiple-choice"
    prompt: "For the greenfield track, what happens first?"
    options:
      - text: "Scaffold a workspace with create-vivary init."
        correct: true
        feedback: "Right — greenfield starts by scaffolding, before any real work goes in."
      - text: "Adopt an existing repository immediately instead."
        feedback: "Adopt is the brownfield track's dry-run-first entry point, not greenfield's."
      - text: "Publish a walkthrough before scaffolding anything."
        feedback: "A walkthrough documents friction after real commands run, not before them."
      - text: "Skip doctor checks until work ships."
        feedback: "A clean doctor run is required evidence-bundle item one — never optional to skip."
    success: "Correct — scaffold, then confirm clean checks, then add real work."
    reveal: "Greenfield order: scaffold with create-vivary init, confirm doctor, tropo check, and ozone review pass clean, then add real modules and changes."
  - id: "adopt-precondition"
    kind: "multiple-choice"
    prompt: "What must happen before create-vivary adopt applies any change?"
    options:
      - text: "A dry-run plan must be reviewed."
        correct: true
        feedback: "Right — adopt is dry-run by default; --yes only applies changes after you approve the plan."
      - text: "Changes apply immediately, no review needed."
        feedback: "The opposite: dry-run first, review the plan, then --yes."
      - text: "Existing files get overwritten first, automatically."
        feedback: "adopt only adds files — anything already there is reported \"exists, kept,\" never silently overwritten."
      - text: "ozone review runs before adopt starts."
        feedback: "ozone review is part of the clean-check evidence you gather after adopting, not an adopt precondition."
    success: "Correct — dry-run, approve, then --yes, every time."
    reveal: "create-vivary adopt . --json previews the plan and writes nothing; only create-vivary adopt . --yes, after your approval, applies it."
  - id: "gated-decision"
    kind: "multiple-choice"
    prompt: "Evidence-bundle item four requires one gated decision. What actually counts?"
    options:
      - text: "Stopping at one real human gate, shown, not skipped."
        correct: true
        feedback: "Right — a real stop-and-approve moment, not an automated pass."
      - text: "Running tropo check without pausing at any human gate."
        feedback: "tropo check is an automated verify gate, not the human-approval evidence item."
      - text: "Auto-approving every pending gate item without an actual stop."
        feedback: "Auto-approving erases the gate; the item needs a genuine stop-and-approve moment."
      - text: "Skipping gates because the workspace already works perfectly today."
        feedback: "Skipping gates contradicts the operating-loop contract's human-gate stops."
    success: "Correct — a human gate needs a real stop, not a rubber stamp."
    reveal: "Memory writes, publishing, installs, git push/PR, and destructive operations are the human gates named in the loop contract. The evidence bundle needs one shown, not skipped."
  - id: "brief-scope"
    kind: "multiple-choice"
    prompt: "What does finishing this lesson certify about you?"
    options:
      - text: "Readiness to attempt the capstone work independently."
        correct: true
        feedback: "Right — this brief checks that you understand the assignment, nothing more."
      - text: "Completed mastery of the whole Vivary product."
        feedback: "This page is a brief, not a claim of completed learning."
      - text: "A passing grade on every earlier lesson."
        feedback: "No lesson in this course issues grades — the evidence bundle gets reviewed, not scored."
      - text: "Full formal certification of independent professional judgment."
        feedback: "Finishing a brief and its self-check doesn't certify anyone's professional judgment."
    success: "Correct — readiness to start, not proof you've finished."
    reveal: "Close this lesson and open a terminal on a real workspace — that's the only thing left that proves anything."
---

> This page is a permission slip to start, not a diploma for having read it.

## Why this exists

The capstone happens outside this course, on a workspace you scaffold or adopt yourself. This lesson only names the two acceptable tracks and the evidence bundle a reviewer needs to see. Finishing it proves you understand the assignment. It proves nothing about your ability to run it.

## How it works

Pick one track. Both end at the same evidence bundle; they start from opposite conditions.

**Greenfield.** Run `create-vivary init <name> --preset <choice>` on a real, empty project. Confirm `create-vivary doctor .`, `tropo check`, and `ozone review` pass clean before adding anything. Then add real modules, changes, and decisions — typed folders, not placeholder files — and let `tropo check` tell you what each one requires. Operate several real turns of Ask → retrieve → act → verify → learn → gate.

**Brownfield.** Run `create-vivary adopt . --json` on a real repo or vault — dry-run by default, prints the plan, writes nothing. Read the plan before applying. Apply only with `--yes`, after you approve it; adopt only adds files, and anything already there is reported "exists, kept." Resolve any privacy follow-ups the plan surfaces, then reach a clean `create-vivary doctor . --json`, `tropo check`, and `ozone review --strict` — the same gate a CI job would run on exit code.

Either way, the evidence bundle needs six things, all from a workspace you actually ran commands against:

1. Real terminal output from doctor, `tropo check`, and `ozone review` (`--strict` for brownfield).
2. A graph view you interpret — `tropo graph --json` or a rendered `tropo view --out graph.html` — with a sentence on what it shows.
3. Blast or impact reasoning: `tropo blast <id>` or `ozone impact <id>` run before a real change, naming what it would touch before you touch it.
4. One gated decision: a real stop at a human gate — a memory write, an install, a publish, a git push/PR, or a destructive operation — with the approval moment shown, not skipped.
5. One diagnosed failure: a real check failure you triggered or hit, what it told you was wrong, and the fix that turned it green.
6. An architecture defense: why one boundary is drawn where it is, in your own words, grounded in primary-source language.

## Don't conflate

Getting Started documents `adopt` as available today; the product roadmap describes broader published field-validation evidence as still active roadmap work. Treat the command as shipped. Don't treat broad field validation as complete until published evidence backs that claim. And keep the automated/human distinction sharp when you pick your boundary defense: `tropo check` and `ozone review` can fail a build on their own exit code — that's automated. Memory writes, publishing, installs, and destructive operations are different; the operating-loop contract says stop there, not run through them.

## Try it on a real workspace

This is the assignment, not a rehearsal for it. Choose greenfield or brownfield, run every command for real, and assemble all six evidence-bundle items from that run. Then pick one boundary — automated gate versus human gate, or adopt-adds versus adopt-overwrites — and defend why it's drawn where it is. A defense that just restates the docs in different words isn't a defense; name the failure mode the boundary actually prevents.

## One-minute recall

Say the six bundle items aloud from memory before you start: clean check output, an interpreted graph view, one blast-radius call, one gated decision shown, one diagnosed failure, and an architecture defense. If you can only name four, reread the evidence-bundle list above before opening a terminal on the real workspace.

## Sources

- [Getting started: install, adopt, health checks, graph, and the loop](https://github.com/vivary-dev/vivary/blob/dev/docs/GETTING-STARTED.md) — both tracks and every command the evidence bundle requires.
- [How-to recipes: CI-gate recipes](https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md) — the exact clean and failing CI-gate commands referenced in bundle item one.
- [Product roadmap: current truth vs. active roadmap work](https://github.com/vivary-dev/vivary/blob/dev/docs/PRODUCT-ROADMAP.md) — the line between shipped adoption tooling and still-unpublished validation evidence.
