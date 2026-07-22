---
title: "Rebuild the truth path"
shortTitle: "Rebuild the truth path"
description: "A short retrieval lesson on Lattice's implemented evidence flow."
order: 14
module: "08"
moduleTitle: "Lattice: governed context and evidence"
status: "Experimental"
minutes: 8
tags: ["lattice", "evidence", "experimental", "truth-path"]
outcomes:
  - "Recite Lattice's seven-stage evidence path from observation to causal explanation, in order."
  - "State the one refusal that keeps each stage from exceeding its authority."
  - "Explain why Lattice's design preview does not change what ships in baseline Vivary today."
sources:
  - label: "Lattice architecture: the evidence path"
    url: "https://vivary.vercel.app/learn/reference/lattice-architecture/"
    locator: "\"The evidence path\" (steps 1–7)"
    sourceRef: "site"
    verifiedAt: "2026-07-21"
  - label: "Lattice architecture: the six refusal lines"
    url: "https://vivary.vercel.app/learn/reference/lattice-architecture/"
    locator: "\"The six refusal lines\" table"
    sourceRef: "site"
    verifiedAt: "2026-07-21"
interactions:
  - id: "conflict-projection"
    kind: "multiple-choice"
    prompt: "Two allowlisted checkouts prove the same repository identity but point at different commits. What should the Project stage do with that conflict?"
    options:
      - text: "Preserve both conflicting checkout observations as separate evidence records."
        correct: true
        feedback: "Right — conflicting observations stay separate; the conflict itself is the evidence, marked for review."
      - text: "Automatically choose the most recently fetched checkout as canonical."
        feedback: "Recency is evidence about fetching, not authority to choose which checkout is true."
      - text: "Prefer whichever available checkout is on the primary branch."
        feedback: "Branch naming proves nothing about which checkout supersedes the other."
      - text: "Merge both checkout states into one combined canonical record."
        feedback: "The two different commits are the conflict. Merging them would erase the very thing worth flagging."
    success: "Correct — ambiguity is evidence, not permission to invent a winner."
    reveal: "The invariant: conflicting observations remain separate — the Project stage relates evidence without electing a winner among conflicting states. A newer fetch timestamp is still only evidence about fetching; it never grants authority to pick which checkout is canonical."
  - id: "truth-path-order"
    kind: "sequence"
    prompt: "Put the seven Lattice evidence stages in execution order — from the only stage allowed to touch checkouts, to the stage where a human inspects the causal record."
    items:
      - text: "Observe checkout facts"
        feedback: "Observation comes first: every later stage consumes evidence derived from it."
      - text: "Project workspace graph"
        feedback: "The graph projects observations before any task-specific context is selected."
      - text: "Compile task capsule"
        feedback: "A capsule is compiled from the workspace graph, not directly from raw checkouts."
      - text: "Run required checks"
        feedback: "Checks run against the compiled task context before a receipt states their result."
      - text: "Create integrity receipt"
        feedback: "A receipt needs both a capsule and completed checks. Those come first."
      - text: "Append integrity events"
        feedback: "Events record accepted evidence after the receipt already exists."
      - text: "Render causal inspection"
        feedback: "The causal view is a projection of recorded evidence, so it comes last."
    success: "Chain rebuilt. Now you can trace which stage owns a failure — and which stage has no authority to fix it."
    reveal: "Checks sit between capsule and receipt because a receipt never performs verification — it binds named check results to the exact capsule and workspace state that were actually checked."
---

> If your agent's context window is a shopping cart, Lattice is the receipt taped to the side of it — proof of how the cart filled up, never a vote on what to buy next.

## Why this exists

Lattice is an experimental Vivary architecture, not part of the released baseline, and its interfaces may change while the design is hardened. This lesson covers its evidence path anyway, because the underlying discipline is worth learning before it ships: reconstruct the chain before you open a file. The chain tells you which stage owns a failure — and which stage has no authority to "fix" it, no matter how tempting a shortcut looks from inside a debugging session.

## How it works

Evidence moves in one direction through seven stages, and authority only ever moves forward when a named boundary permits it:

1. **Observe** checkout facts — may report, may not repair.
2. **Project** the workspace graph — may relate observations, may not resolve ambiguity between them.
3. **Compile** a task capsule — may select bounded claims, may not hide omissions or conflicts.
4. **Check** required verification — may produce evidence, may not self-certify.
5. **Attest** with an integrity receipt — may bind checks to a capsule, may not turn provenance into proof.
6. **Record** integrity events — may append validated evidence, may not rewrite earlier history.
7. **Explain** with a causal inspection — may render the record for a human, may not become a hidden truth store of its own.

No stage gets to forge a hall pass for the next one. A receipt doesn't run checks; it binds already-completed check results to the exact capsule and workspace state that produced them. A causal view doesn't create new facts; it projects what was already recorded.

## Don't conflate

"Verified" is not the same claim as "the task succeeded." Attest binds evidence to a capsule and a workspace fingerprint — it doesn't grant success, and a failed check stays visible on the record instead of getting quietly absorbed into a passing summary elsewhere. Keep Lattice's design preview separate from a shipped Vivary contract, too: this lesson describes an experimental architecture whose interfaces may still change, not a guarantee about what baseline Vivary does today. And don't let a fetch timestamp masquerade as authority — a more recent fetch is evidence about fetching, never a reason to elect one checkout as canonical over another.

## Try it on a real workspace

Pick one stage whose authority boundary feels arbitrary to you. Find the sentence in the Lattice architecture reference that actually limits it, then invent a counterexample that would violate that boundary if the stage let it through. If you can't construct one, you probably haven't found the real limit yet — look again.

## One-minute recall

Close the reference and say the seven stages aloud in under sixty seconds. For each one, use exactly one verb and one refusal: observe/repair, relate/elect, select/conceal, check/self-certify, attest/prove, record/rewrite, explain/replace. Tomorrow, before reopening this lesson, rebuild the same seven stages on blank paper and circle the first one whose refusal you can't state from memory.

## Sources

- [Lattice architecture: the evidence path](https://vivary.vercel.app/learn/reference/lattice-architecture/) — the seven numbered stages and the forward-only authority invariant.
- [Lattice architecture: the six refusal lines](https://vivary.vercel.app/learn/reference/lattice-architecture/) — the permitted action and refusal for each governed seam, including the ones this lesson's stages feed into.
