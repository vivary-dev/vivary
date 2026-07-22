---
title: "Coordinate without collision"
shortTitle: "Exo"
description: "A short source-grounded lesson on Exo coordination: packs, claim, board, conflicts, roles, and claim hardening."
order: 9
module: "05"
moduleTitle: "Exo: coordination"
status: "Optional layer"
minutes: 11
tags: ["exo", "coordination", "claim", "conflicts"]
outcomes:
  - "State the four-command coordination recipe in order: claim → board → conflicts → tropo check."
  - "Explain what exo claim writes, refuses, and rewrites — and why none of that proves correctness."
  - "Distinguish who's-responsible coordination (exo) from is-it-correct verification (tropo check)."
sources:
  - label: "Getting Started — opt into coordination fields, then claim"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/GETTING-STARTED.md"
    locator: "§5 Operate the loop, L186-199"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "HOWTO — Coordinate multiple agents"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md"
    locator: "§ Coordinate multiple agents, L113-134"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Architecture — the layer model"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/ARCHITECTURE.md"
    locator: "§3 The layer model, L63-89"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
interactions:
  - id: "exo-order"
    kind: "multiple-choice"
    prompt: "Per the source recipe, when do you inspect the board and conflict surface?"
    options:
      - text: "Right after claiming, before any edits."
        correct: true
        feedback: "Correct. Both Getting Started and HOWTO put board and conflicts right after claim, before any edit."
      - text: "Right before claiming any shared work."
        feedback: "The recipe claims first, then inspects — reversing the order misses a live claim."
      - text: "Only after tropo check reports errors."
        feedback: "Board and conflicts are inspected before you edit, not gated behind tropo check."
      - text: "Never, since assignee alone prevents collisions."
        feedback: "Assignee only records who claimed it — the board and conflict surface are what you actually read."
    success: "Correct. Both Getting Started and HOWTO put the same two commands right after claim, before any edit."
    reveal: "Fixed order: claim → board/conflicts → tropo check, every time, per both source docs."
  - id: "exo-claim-requirement"
    kind: "multiple-choice"
    prompt: "What must already be true before exo claim will write anything?"
    options:
      - text: "The workspace declares assignee via packs."
        correct: true
        feedback: "Correct. packs = [\"repo-graph\", \"coordination\"] declares assignee before claim can write it."
      - text: "The target module has zero conflicts."
        feedback: "Claim doesn't check for zero conflicts; it only checks that assignee is declared."
      - text: "The requesting agent outranks other claimants."
        feedback: "There's no seniority system in the source recipe — only whether assignee is declared."
      - text: "Ozone review already approved the change."
        feedback: "Claim and review are separate steps; the recipe never gates claim on review."
    success: "Correct. Claim's sole write path checks that assignee is already a declared field — nothing else."
    reveal: "The one declared precondition: packs = [\"repo-graph\", \"coordination\"] must already be in tropo.toml."
  - id: "exo-hardening"
    kind: "multiple-choice"
    prompt: "Which statement about claim hardening is accurate?"
    options:
      - text: "Claim refuses symlinked or out-of-workspace items."
        correct: true
        feedback: "Correct. Refusal happens at the filesystem layer, before any write is attempted."
      - text: "Claim silently overwrites any hard-linked target."
        feedback: "The workspace copy is rewritten instead; the external hard-linked target is never mutated."
      - text: "Claim also rewrites every related module."
        feedback: "Claim writes only to work items under changes/ — never to modules."
      - text: "Claim also verifies the work's correctness."
        feedback: "Claim only sets who's responsible; tropo check is the separate validity gate."
    success: "Correct. Two protections, not one — refusal and safe rewrite are different mechanisms."
    reveal: "Symlinked or out-of-workspace files are refused outright; hard-linked files are rewritten safely, workspace-copy only, external target untouched."
---

> Two agents, one workspace, zero coordination: that's not a bug report, that's Tuesday. Exo's whole job is making sure "who's touching this" has exactly one answer — never "is this right."

## Why this exists

Exo exists for one moment only: the instant a single-agent workspace becomes a multi-agent one. It answers "who is touching this, and would we collide?" It does not, and never will, answer "is this change correct?" Keep those two questions in separate tools, or a claim starts standing in for a review it never performed — and that's how a workspace quietly loses its safety net.

Exo is also the thinnest layer Vivary ships. Opt-in fields, a four-command recipe, and a hardened write path — that's the entire surface. Nothing about it activates until a workspace explicitly asks for it.

## How it works

One line unlocks the whole layer:

```toml
packs = ["repo-graph", "coordination"]
```

That's the opt-in. Two independent docs — Getting Started and the How-to guide — describe the identical step in nearly identical words, and both run it once per workspace, not once per claim.

Once opted in, the recipe is four commands, fixed order, no exceptions:

1. **`exo claim <id> --agent <handle>`** — the only writer exo has. Claim a work item under `changes/` before you touch it, never after editing has already started.
2. **`exo board`** — read the board before you start editing, not after.
3. **`exo conflicts`** — the other half of inspection. Checking it is how a second agent avoids starting work that would collide with something already claimed.
4. **`tropo check`** — not an exo command at all. It closes the recipe anyway, because nothing in the first three steps judges whether the resulting change is any good. `tropo check` only confirms the graph stays well-formed.

Claim itself is narrowly scoped and defensively written. It writes only to work items under `changes/` — nothing in `modules/`, `decisions/`, `verification/`, or `gates/`. It refuses to run at all unless `assignee` is a declared field, which is exactly what the coordination pack turns on. It rejects symlinked or out-of-workspace work-item files outright — the claim simply fails, no write happens. And when the target file is hard-linked from elsewhere on disk, claim rewrites the workspace copy instead of truncating it; the external hard-linked target is never touched. That's a distinct protection from the refusal case, not a restatement of it.

`assignee` and a **role** are not the same thing, either: `assignee` records who claimed the item, while a role is the bounded worker contract that agent operates under. `exo roles` lists those contracts as a separate command — and neither the field nor the role proves the work itself is correct.

## Don't conflate

- **Claiming an item is not the same as being an authority on it.** Assignee just records who's responsible; it grants no special say over what "correct" means.
- **Inspection is not optional pre-work — it's mandatory pre-work.** `exo board` and `exo conflicts` run right after claim, before any edit, in both source docs, every time.
- **Refusal and safe rewrite are two different protections.** A symlinked or out-of-workspace file gets refused outright. A hard-linked file gets rewritten in the workspace copy only. Neither one is "the same hardening" as the other.
- **Coordination is not verification.** Nothing in the four-command block judges whether a change is right. That job belongs entirely to `tropo check` (and, if the workspace has it, `ozone review`).

## Try it on a real workspace

Sketch a `changes/` folder after two agents claim different work items. Then write down, from memory, what `exo board`, `exo conflicts`, and the effective Tropo configuration should each reveal about that folder. If you can't answer one of the three without rereading the recipe, that's the piece to drill again before you trust exo on a real multi-agent workspace.

## One-minute recall

Rebuild this from memory, no notes:

1. The opt-in line: `packs = ["repo-graph", "coordination"]`.
2. The four-command order: claim → board → conflicts → tropo check.
3. The two things claim refuses outright, and the one thing it rewrites safely instead.
4. The boundary sentence: exo records **who's responsible**; it never decides **whether the work is correct**.

## Sources

- [Getting Started — opt into coordination fields, then claim](https://github.com/vivary-dev/vivary/blob/dev/docs/GETTING-STARTED.md) (§5 Operate the loop, L186-199)
- [HOWTO — Coordinate multiple agents](https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md) (§ Coordinate multiple agents, L113-134)
- [Architecture — the layer model](https://github.com/vivary-dev/vivary/blob/dev/docs/ARCHITECTURE.md) (§3 The layer model, L63-89)
