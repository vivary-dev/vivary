---
title: "Trace the Lattice seams"
shortTitle: "Trace the Lattice seams"
description: "A source-grounded lesson on Lattice's five governed seams: policy, verification, the recall firewall, evidence store/ref sync, and migration/relay."
order: 15
module: "08"
moduleTitle: "Lattice: governed context and evidence"
status: "Experimental"
minutes: 11
tags: ["lattice", "experimental", "seams", "governance"]
outcomes:
  - "Name the one permitted action and one refusal for each of Lattice's five governed seams."
  - "Explain why classifying a recall candidate never grants it authority to overwrite graph truth."
  - "Explain why migration routes imported fields to an existing owner instead of becoming authoritative itself."
sources:
  - label: "Lattice architecture: policy, verification, and the recall firewall"
    url: "https://vivary.vercel.app/learn/reference/lattice-architecture/"
    locator: "\"Policy decisions\", \"Receipt integrity and sufficiency\", and \"Recall firewall\" sections"
    sourceRef: "site"
    verifiedAt: "2026-07-21"
  - label: "Lattice architecture: evidence, synchronization, and migration"
    url: "https://vivary.vercel.app/learn/reference/lattice-architecture/"
    locator: "\"Evidence storage and synchronization\" and \"Imported records and typed views\" sections"
    sourceRef: "site"
    verifiedAt: "2026-07-21"
  - label: "Lattice architecture: the six refusal lines"
    url: "https://vivary.vercel.app/learn/reference/lattice-architecture/"
    locator: "table under \"The six refusal lines\""
    sourceRef: "site"
    verifiedAt: "2026-07-21"
interactions:
  - id: "policy-conflict"
    kind: "multiple-choice"
    prompt: "A capsule carries an unresolved conflict. What can the policy seam do about it on its own?"
    options:
      - text: "Classify human review as needed — it can't resolve conflicts itself."
        correct: true
        feedback: "Right — policy classifies whether work may proceed, needs review, or must stop. Resolving the conflict is a separate, human step."
      - text: "Pick whichever available claim appears more recent or more trustworthy now."
        feedback: "Policy never resolves the underlying conflict itself — that stays a human call, no matter how the claims compare."
      - text: "Run the necessary checks to decide which claim is correct first."
        feedback: "Policy doesn't run or judge checks. It only classifies readiness based on what's already recorded."
      - text: "Clear the conflict silently because such conflicts commonly happen in practice."
        feedback: "An unresolved conflict is exactly the case that calls for human review, not a silent pass."
    success: "Correct — policy classifies readiness; it never resolves the conflict underneath it."
    reveal: "Policy classifies whether work may proceed, needs human review, or must stop. It does not run checks or resolve the underlying conflict — that decision stays with a human."
  - id: "tampered-receipt"
    kind: "multiple-choice"
    prompt: "A receipt's self-reported checks all say passed, but verification recomputes its fingerprint and finds a mismatch. What happens to those self-reported checks?"
    options:
      - text: "They're never trusted — a broken binding voids all receipt claims."
        correct: true
        feedback: "Right — verification confirms the binding first. A mismatch there means nothing self-reported gets trusted afterward."
      - text: "They're trusted because the receipt already reported every check as passed."
        feedback: "Verification recomputes and compares before trusting anything a receipt reports about itself."
      - text: "Verification quietly repairs the mismatch before trusting the receipt's reported results."
        feedback: "Verification never repairs anything — it only recomputes and compares."
      - text: "Verification waives the mismatch since the task otherwise looks fine overall."
        feedback: "Verification never waives a failed result, no matter how the rest of the task looks."
    success: "Correct — a broken integrity check voids everything the receipt self-reports."
    reveal: "Verification recomputes integrity, confirms task and workspace binding, and evaluates evidence against one named gate. It never repairs or waives a failed result."
  - id: "recall-authority"
    kind: "multiple-choice"
    prompt: "A recall candidate closely matches an existing graph assertion and looks like a strong correction. Can classifying it as compatible, by itself, overwrite the graph's existing truth?"
    options:
      - text: "No — classification alone never grants authority to overwrite existing graph truth."
        correct: true
        feedback: "Right — recall may classify a candidate; it may never mutate the source of truth on the strength of that classification alone."
      - text: "Yes, once the match is close enough to justify overwriting graph truth."
        feedback: "Closeness of match isn't what the boundary depends on. Classification never grants overwrite authority, however strong the match looks."
      - text: "Yes, but only after a recall provider is installed for this workspace."
        feedback: "Installing a provider only makes classification possible. It still never hands classification the power to overwrite truth."
      - text: "Yes, automatically, whenever the candidate's subject resolves cleanly against existing graph records."
        feedback: "A cleanly resolved subject only means classification can proceed — it still never grants authority to overwrite graph truth."
    success: "Correct — a classification is a label, not a write."
    reveal: "Recall may classify a candidate as compatible, conflicting, superseded, or unresolved. The classification never grants that candidate authority to overwrite graph truth."
  - id: "migration-routing"
    kind: "multiple-choice"
    prompt: "An importer brings in gate and evidence-sufficiency text from an external record. Which seam ends up with authority over what that text means?"
    options:
      - text: "The seam that owns the decision — migration invents no authority."
        correct: true
        feedback: "Right — migration projects source meaning into the Vivary layer that already owns each decision; it never becomes authoritative itself."
      - text: "Migration itself, since it performed the importing work on this record."
        feedback: "Migration explicitly never becomes authoritative over what it imports — it hands meaning to the layer that already owns it."
      - text: "No seam — imported text remains outside every Lattice authority model."
        feedback: "Migration explicitly projects fields into the layer that owns each decision, rather than leaving them outside every seam's authority."
      - text: "Whichever seam the importing agent picks during import for each record."
        feedback: "Routing follows which seam already owns that kind of decision, not an ad hoc choice made at import time."
    success: "Correct — migration routes meaning to an existing owner instead of claiming authority for itself."
    reveal: "Migration preserves source meaning while projecting fields into the Vivary layer that already owns each decision. Importing data never makes it authoritative by itself."
---

> Five seams, five refusals: authority moves forward only when a boundary says it can — no seam gets to forge its own hall pass.

## Why this exists

Lesson 0001 walked the seven-stage evidence path. Five more seams govern how that evidence gets classified, verified, recalled, stored, and migrated — and Lattice is still an experimental Vivary architecture, not part of the released baseline, with interfaces that may keep changing. Learning the seams now means you can name exactly which one refuses a shortcut, instead of vaguely distrusting "the system."

## How it works

Each seam gets exactly one permitted action and one refusal:

- **Policy** — may classify whether work may proceed, needs human review, or must stop; may not run or judge the work itself.
- **Verification** — may recompute a receipt's integrity and compare it against recorded evidence; may not repair, waive, or self-certify.
- **Recall firewall** — may classify a candidate as compatible, conflicting, superseded, or unresolved; may never mutate graph truth on the strength of that classification alone.
- **Evidence store & sync** — may append evidence deterministically and synchronize it as a traceable snapshot; divergence fails closed instead of being overwritten.
- **Migration / relay** — may project imported meaning into the Vivary layer that already owns each decision; may never become authoritative over what it imports.

Notice the shape repeats: every seam is allowed to *look at* something and *say something about it* — classify, recompute, compare, project. None of them is allowed to *become* the fact it's describing. A recall candidate that looks like an obvious correction still doesn't get to overwrite graph truth just by being classified; a receipt that reports all-green checks still gets nothing trusted once its own fingerprint fails to match. The seam's judgment and the underlying truth stay two separate things, on purpose.

## Don't conflate

A receipt's own integrity check is not the same thing as the task it describes succeeding — verification confirms binding and evaluates evidence against a named gate, it doesn't declare the task a win. A result that "needs human review" is not a denial either; authority passes to a person, it doesn't vanish. And classifying a recall candidate is not the same act as writing it into the graph — the doc draws that line explicitly, because a similarity score is a hint about relevance, never a grant of authority. One more boundary worth holding onto: none of this is a released Vivary contract yet. These five seams describe a design preview, and the shape of any one refusal could still shift before — or if — it ships in baseline Vivary.

## Try it on a real workspace

Pick one "may not" rule from the five seams above and describe, in concrete terms, the observable failure a contract test should catch if that refusal quietly disappeared. If you can't describe a failure a test would catch, you likely don't understand the boundary yet — go back to the reference and read the refusal again in context.

## One-minute recall

From memory, say the five seams aloud in under sixty seconds, one verb and one refusal each: policy classifies, never judges the work; verification recomputes, never repairs or waives; recall classifies, never overwrites truth; evidence appends and snapshots, never rewrites or hides divergence; migration projects meaning, never claims authority over what it imports. Tomorrow, redraw the five-seam list from blank paper before reopening this lesson, and circle the first refusal you can't state without looking.

## Sources

- [Lattice architecture: policy, verification, and the recall firewall](https://vivary.vercel.app/learn/reference/lattice-architecture/) — the classify/review/stop model, receipt integrity, and the never-overwrite recall rule.
- [Lattice architecture: evidence, synchronization, and migration](https://vivary.vercel.app/learn/reference/lattice-architecture/) — append-only evidence, fail-closed sync, and typed-view routing for imported records.
- [Lattice architecture: the six refusal lines](https://vivary.vercel.app/learn/reference/lattice-architecture/) — the one-line permitted-action/refusal table this lesson compresses each seam into.
