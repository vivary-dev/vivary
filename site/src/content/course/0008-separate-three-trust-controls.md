---
title: "Separate three trust controls"
shortTitle: "Trust model"
description: "A short source-grounded lesson distinguishing privacy filtering, automated gates, and human approval in Vivary."
order: 7
module: "03"
moduleTitle: "Trust, privacy, and gates"
status: "Baseline"
minutes: 9
tags: ["trust", "privacy", "gates", "human-approval"]
outcomes:
  - "Name the three trust controls and the one question each answers: what may be seen, what structurally holds, and what needs your yes."
  - "Classify a given workspace action against all three controls separately instead of assuming a yes to one answers the others."
  - "State that only the human-gate list requires explicit, per-item, never-batched approval — memory writes, publishing, installs, push/PR, destructive ops."
sources:
  - label: "Vivary Getting Started — Operate the loop: the gate stage's two jobs"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/GETTING-STARTED.md"
    locator: "§5 Operate the loop, L170-183"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Vivary Commands — the check gate (strictness) and the ozone review layer"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/COMMANDS.md"
    locator: "L93-96, L184-187; §ozone — the review layer, L305-320"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Vivary Semantic Memory — privacy-filter non-negotiables and private paths"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/SEMANTIC-MEMORY.md"
    locator: "§Non-negotiables, L29-41; §Config, L225-229"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Vivary HOWTO — Publish your own Vivary-based tool (gated)"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md"
    locator: "§Publish your own Vivary-based tool (gated), L292-295"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
interactions:
  - id: "0008-gate-stage-jobs"
    kind: "multiple-choice"
    prompt: "Per Getting Started, the loop's gate stage bundles two jobs. Which pairing matches the source?"
    options:
      - text: "Name the blast radius; stop at the human gates."
        correct: true
        feedback: "Right — Getting Started names exactly these two jobs for the gate stage, nothing else."
      - text: "Run tropo check, then merge every pending change automatically."
        feedback: "That's the verify stage's job description, and nothing in the loop auto-merges anything."
      - text: "Filter private paths, then index approved project content automatically."
        feedback: "That's the separate semantic-memory privacy filter, not the loop's gate stage at all."
      - text: "Stop for every single risky-looking change, no list needed."
        feedback: "The gate stage stops specifically at the named human gates, not at every change that merely looks risky."
    success: "Correct — blast-radius naming is impact analysis; the human-gates list is what always needs a yes."
    reveal: "Gate does two jobs: name the blast radius, then stop at memory writes, publishing, installs, git push/PR, and destructive ops."
  - id: "0008-install-scenario"
    kind: "multiple-choice"
    prompt: "A workspace runs an install for a new dependency. Which control applies?"
    options:
      - text: "Only the explicit human gate required before a dependency install."
        correct: true
        feedback: "Right — installs are named directly among the human gates; nothing about installing triggers the privacy filter or a document check."
      - text: "Only the automatic privacy filter required before a dependency install."
        feedback: "The filter's trigger list is indexing, embedding, export, cache write, or recall — installing a dependency isn't on it."
      - text: "Only tropo check's document validation required before a dependency install."
        feedback: "An install isn't a tropo check event at all; it's the kind of durable action the human-gate list names directly."
      - text: "Both the filter and human gate together before dependency installation."
        feedback: "Only one control is documented as required here — a human gate on its own, nothing stacked with it."
    success: "Correct — installs sit on the human-gate list alone; nothing about them triggers the privacy filter."
    reveal: "One action, one control — don't assume every gate carries a filter along with it."
  - id: "0008-recall-scenario"
    kind: "multiple-choice"
    prompt: "A local recall step returns an already-indexed note to the agent. Which control governs that read?"
    options:
      - text: "Only the automatic privacy filter required for that recall read."
        correct: true
        feedback: "Right — recall sits directly on the filter's trigger list; the human gate already fired earlier, when the note was written."
      - text: "Only the explicit human gate required for that recall read."
        feedback: "Recall isn't on the human-gates list — that approval already happened at write time, not on every read."
      - text: "Only tropo check's document validation required for that recall read."
        feedback: "Reading a recall candidate back isn't a document check event; it's bounded by the privacy filter instead."
      - text: "Both filter and human gate together for that recall read."
        feedback: "Only the privacy filter is documented as required for a read — don't assume the human gate repeats on recall."
    success: "Correct — the filter can apply completely on its own, with no human gate attached at all."
    reveal: "Filter privacy boundaries before any indexing, embedding, export, cache write, or recall — recall is right there on that list."
---

> "Gate" does triple duty in Vivary's docs — a CLI describing its own strictness, a stage in the loop, and the one list that actually needs your yes. Confuse them and you'll either wait for an approval that was never coming, or skip one that was.

## Why this exists

Learn to ask three separate questions about any action — what may it see, does it hold together structurally, and does a person have to say yes — instead of collapsing all three into the single word "gate." The three controls live at different scopes across different docs: what a semantic-memory provider must filter before touching anything ([Semantic Memory](https://github.com/vivary-dev/vivary/blob/dev/docs/SEMANTIC-MEMORY.md)), what the CLI checks automatically ([Commands](https://github.com/vivary-dev/vivary/blob/dev/docs/COMMANDS.md)), and what the loop names as its own stages, including the actions that always need a human ([Getting Started](https://github.com/vivary-dev/vivary/blob/dev/docs/GETTING-STARTED.md)).

## How it works

Start with the overload. `tropo check`'s own command-reference entry calls it **"Opinionated: warnings fail by default"** — and its dedicated section heading is literally *"Strictness (the `check` gate)."* No human is asked; the check just fails closed on untyped docs, unknown fields, and broken refs. That's one automated document gate.

`ozone review` is a second, wider automated gate: *"Where `tropo check` asks 'is each document valid?', `ozone` reviews the whole graph and a change's impact."* It's **advisory by default** — exit 0 even with warnings — until `--strict` "makes it a gate (exit 1 on warnings)."

The loop's own gate *stage* is a third, different thing again. Getting Started names two jobs for it: "name the blast radius... for a risky change, and stop at the human gates (memory writes, publishing, installs, git push/PR, destructive ops)." Naming blast radius is impact analysis; it is not, itself, a person saying yes.

Underneath all of that sits a fourth control that never uses the word "gate" at all: the **privacy filter**. Semantic Memory's non-negotiables state plainly: *"Filter privacy boundaries before any indexing, embedding, export, cache write, or recall."* The documented `.vivary/memory.toml` example lists `private_paths = ["USER.md", "MEMORY.md", "memory/**", "heartbeat-reports/**"]`, and Cognee specifically must not become "Vivary's foundation, default install, or second source of truth" — it's never added to the core install path.

Three separate answers to three separate questions:

- **Privacy filter · what may be seen.** Fires before indexing, embedding, export, cache write, or recall. Scoped to the optional semantic-memory capability — it does nothing until that capability is on.
- **Automated gate · what structurally holds.** `tropo check` fails closed on document problems; `ozone review` (with `--strict`) fails closed on relationship problems. Neither asks a human per item.
- **Human gate · what needs your yes.** Memory writes, publishing, installs, `git push`/PR, destructive ops — named explicitly, approved per item, never batched. HOWTO says it outright: *"Publishing (PyPI/npm), creating orgs/repos, pushing, and opening PRs are human gates — one explicit approval per item... don't batch them."*

## Don't conflate

- **Not every gate carries a filter, and not every filter sits behind a human gate.** A local `tropo check` run with no export or index event never touches the privacy filter's trigger list at all. A `recall` read is filtered but isn't itself on the human-gates list — that approval already happened when the note was written.
- **"Advisory" and "strict" are not two different tools — they're two modes of the same one.** Plain `ozone review` reports; `--strict` is what turns the same command into something that can fail a build.
- **Cognee being documented doesn't make it default.** It's an optional provider behind an already-optional capability, further gated by `allow_network` and API-key config — not baseline trust machinery any workspace runs out of the box.

## Try it on a real workspace

Pick one real action from your own workspace — a note edit, a recall, an install, an export of unknown-sensitivity data. Classify it against all three controls separately: does it hit the privacy filter's trigger list, does it fail a `tropo check`/`ozone review` run, and is it named on the human-gates list? A "yes" to one of those three never answers either of the other two.

## One-minute recall

1. Three controls: **privacy filter**, **automated gate**, **human gate**.
2. Three separate questions: does it index/embed/export/cache-write/recall? does it fail a document or graph check? is it named on the human-gate list?
3. A "yes" to one never answers another — check all three, every time.
4. "Gate" alone names at least three different things across three different docs: a CLI's self-description, an advisory-vs-strict review mode, and a named per-item approval list.

Tomorrow, without notes, pick one real action from your own workspace and classify it against all three controls before you touch it.

## Sources

- [Vivary Getting Started — Operate the loop: the gate stage's two jobs](https://github.com/vivary-dev/vivary/blob/dev/docs/GETTING-STARTED.md)
- [Vivary Commands — the check gate (strictness) and the ozone review layer](https://github.com/vivary-dev/vivary/blob/dev/docs/COMMANDS.md)
- [Vivary Semantic Memory — privacy-filter non-negotiables and private paths](https://github.com/vivary-dev/vivary/blob/dev/docs/SEMANTIC-MEMORY.md)
- [Vivary HOWTO — Publish your own Vivary-based tool (gated)](https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md)
