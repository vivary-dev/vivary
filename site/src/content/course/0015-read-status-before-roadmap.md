---
title: "Read status before roadmap"
shortTitle: "Roadmap laws"
description: "A short source-grounded lesson on cross-checking Vivary roadmap prose against current release status."
order: 16
module: "09"
moduleTitle: "Direction and permanent boundaries"
status: "Planned"
minutes: 9
tags: ["roadmap", "status", "planned", "permanent-boundaries"]
outcomes:
  - "Identify which live source states current status and which states direction."
  - "Classify a named surface as shipped, roadmap-worded-but-unconfirmed, or a permanent refusal."
  - "Recite the out-of-core boundaries that hold regardless of which optional layer is enabled."
sources:
  - label: "README: release status and current command surface"
    url: "https://github.com/vivary-dev/vivary/blob/dev/README.md"
    locator: "\"Release status\" block and \"Current command surface\" list"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Product roadmap: current truth, near-term work, and out-of-scope list"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/PRODUCT-ROADMAP.md"
    locator: "\"Current truth\", \"Now: prove the adoption line\", and \"Explicitly out of scope for the core\""
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Homepage FAQ: is it production-ready?"
    url: "https://vivary.vercel.app/#faq"
    locator: "\"Is it open source and production-ready?\""
    sourceRef: "site"
    verifiedAt: "2026-07-21"
interactions:
  - id: "shipped-trio"
    kind: "multiple-choice"
    prompt: "Which three commands does the README's release-status paragraph already name as shipped, even though nearby roadmap prose still uses forward-looking \"Outcome:\" language?"
    options:
      - text: "tropo map, create-vivary adopt, and doctor --trend are current shipped commands."
        correct: true
        feedback: "Right — all three are named directly in the README's release-status line and the roadmap's own \"Current truth\" section."
      - text: "tropo map, vivary-mcp, and doctor --trend are three current shipped commands."
        feedback: "vivary-mcp is a \"Later\" roadmap item, a read-only design still to ship — not named as current anywhere."
      - text: "tropo query, ozone review --pack all, and the module index planner."
        feedback: "The module index planner is a \"Next\" roadmap item; it isn't in the shipped list at all."
      - text: "context-budget repair workflow, tropo map, and create-vivary adopt are current commands."
        feedback: "The repair workflow is still an Outcome-framed \"Now\" item — only two of these three are actually shipped."
    success: "Correct — the trio README already calls current, even while roadmap prose around them still reads as ongoing work."
    reveal: "README's release line names this exact trio, plus CI integrity gates, as shipped in the current line. The roadmap's own \"Current truth\" section repeats tropo map and create-vivary adopt directly."
  - id: "benchmark-status"
    kind: "multiple-choice"
    prompt: "A token-savings benchmark and a published brownfield case study don't appear in the README's shipped list. What's their honest status?"
    options:
      - text: "Roadmap-worded, not confirmed complete in any current status source."
        correct: true
        feedback: "Right — a live source says this work is still active roadmap work, not shipped."
      - text: "Confirmed shipped, because no current source explicitly denies them."
        feedback: "Silence in a shipped-status list is a reason to keep checking, not proof of shipping."
      - text: "Confirmed cancelled, since the roadmap dropped the old wording."
        feedback: "Nothing in the current roadmap retracts either item — they're still open \"Now\" work, not cancelled."
      - text: "Guaranteed shipped, matching the trio confirmed earlier in README."
        feedback: "The shipped trio has positive evidence naming it directly; the benchmark and case study have none."
    success: "Correct — absence from a shipped-status source is a caution flag, not a verdict either way."
    reveal: "The homepage FAQ states it plainly: \"benchmark results, broader brownfield proof, and retention evidence are still active roadmap work.\" That is the honest label — unconfirmed, not denied."
  - id: "permanent-law"
    kind: "multiple-choice"
    prompt: "Which statement correctly states one of Vivary's permanent, out-of-core boundaries?"
    options:
      - text: "No workspace mutation happens without a preview and a human gate."
        correct: true
        feedback: "Right — this is unconditional; it doesn't depend on which optional sidecar or backend is active."
      - text: "No workspace mutation happens once the optional Cognee adapter is installed."
        feedback: "Cognee is one optional sidecar; the mutation-gate law isn't scoped to it."
      - text: "No workspace mutation happens after vivary-mcp ships as a default package."
        feedback: "vivary-mcp stays a separate opt-in package by design — it never becomes a default core dependency."
      - text: "No workspace mutation happens beyond the embedded storage backend's sandbox boundary."
        feedback: "Embedded storage is one optional backend; the gate law isn't scoped to it either."
    success: "Correct — the out-of-core boundaries apply no matter which optional layer is switched on."
    reveal: "The roadmap's \"Explicitly out of scope for the core\" list is unconditional: no default embeddings, no hidden daemons or network calls, no automatic bulk indexing, no second truth store, no mutation without a preview and a human gate, and no vendor or tool lock-in."
---

> A roadmap keeps its future tense even after the work ships. Read the status paragraph, not the verb tense.

## Why this exists

`docs/PRODUCT-ROADMAP.md` frames its near-term work as "Outcome:" statements — forward-tense language for work that reads as still ahead. That framing doesn't rewrite itself the moment a slice ships. Nothing turns an "Outcome:" line into a past-tense sentence just because the README already lists the surface it describes as current. Before you repeat any roadmap sentence, ask two questions: what tense does the roadmap use here, and does a live status source name this same surface as already shipped?

## How it works

`tropo map`, `create-vivary adopt`, and `doctor --trend` are the clearest case: the README's release-status paragraph names all three directly as part of the current line, alongside Strato's integrity gates in CI. The roadmap's own "Current truth" section repeats `tropo map` and `create-vivary adopt` as proven architecture. Yet the roadmap's "Now: prove the adoption line" section still uses "Outcome:" framing right next to them — not because the commands are unfinished, but because the roadmap is describing work to tighten and prove around them, not work to ship them for the first time. Tense and status are two different signals; read both, and don't let one stand in for the other.

The benchmark and a published brownfield case study sit on the other side of that line. Neither appears in the README's shipped list. The homepage FAQ answers the question directly: "The architecture and basic adoption path work today; benchmark results, broader brownfield proof, and retention evidence are still active roadmap work." That's the correct label — not proof they're missing forever, just proof they aren't shipped yet.

## Don't conflate

Silence in a status source is not a verdict either way — it's a reason to keep checking, not evidence the work shipped and not evidence it was cancelled. Keep "deliberately deferred" and "explicitly out of scope for the core" separate, too: deferred items (a hosted control plane, default cloud sync, a visual graph editor) are open to reconsideration once evidence justifies them; out-of-scope items (default embeddings, hidden daemons, automatic bulk indexing, a second truth store, mutation without a human gate, vendor or tool lock-in) are permanent refusals the roadmap doesn't put back up for debate.

## Try it on a real workspace

Pick one item from the roadmap's "Next" or "Later" sections. Check whether it has since shown up in a README status line, a changelog entry, or a package version bump. Note which source told you first — that's the habit this lesson is actually training.

## One-minute recall

Say the four-step habit aloud: open the README release-status paragraph; check whether the roadmap's own "Current truth" section repeats the surface; named in either? Label it current, regardless of "Outcome:" wording. Silent in both, using the same forward-tense wording as shipped items? Label it roadmap-worded, unconfirmed — and keep checking rather than asserting either way.

## Sources

- [README: release status and current command surface](https://github.com/vivary-dev/vivary/blob/dev/README.md) — the release-status paragraph and the current command list.
- [Product roadmap: current truth, near-term work, and out-of-scope list](https://github.com/vivary-dev/vivary/blob/dev/docs/PRODUCT-ROADMAP.md) — shipped architecture, "Now" outcome framing, and the permanent boundaries.
- [Homepage FAQ: is it production-ready?](https://vivary.vercel.app/#faq) — the live, plain-language status line this lesson quotes directly.
