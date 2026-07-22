---
title: "Lattice architecture"
description: "A public reference for the experimental Lattice evidence path and the authority each seam must refuse."
sidebar:
  hidden: true
---

:::caution[Experimental, not baseline Vivary]
Lattice explores governed context and evidence flows around Vivary. This is a design
preview, not a promise that every interface ships in baseline Vivary. Interfaces may
change while the experiment is hardened.
:::

If ordinary agent context is a shopping cart, Lattice is the receipt, security camera,
and itemized return policy. It does not make the shopping decision. It preserves enough
causal evidence to explain how the cart got there without appointing a mystery database
as emperor.

## The evidence path

The path moves in one direction:

1. **Observe** — read explicit workspace roots; preserve refusals and unknowns.
2. **Project** — relate observations without electing a winner among conflicting states.
3. **Compile** — select bounded claims for one task; retain omissions, conflicts, and reasons.
4. **Check** — run named verification; failed or absent checks stay failed or absent.
5. **Attest** — bind checks to the task and workspace; provenance alone is not proof.
6. **Record** — append validated evidence without silently rewriting earlier events.
7. **Explain** — render the causal record for inspection without creating a hidden truth store.

The verbs differ slightly between internal APIs and the course shorthand. The invariant
does not: **authority only moves forward when a named boundary permits it.** No stage gets
to forge a hall pass for the next one.

## Policy decisions

Policy classifies whether work may proceed, needs human review, or must stop. It does not
run checks or resolve the underlying conflict.

> **May:** classify readiness. **May not:** perform or judge the work.

## Receipt integrity and sufficiency

Verification recomputes integrity, confirms task and workspace binding, and evaluates
evidence against one named gate. It never repairs or waives a failed result.

> **May:** recompute and compare. **May not:** repair, waive, or self-certify.

## Recall firewall

Recall may classify a candidate as compatible, conflicting, superseded, or unresolved.
The classification never grants that candidate authority to overwrite graph truth.
Autocomplete is useful. Autocomplete with a badge and a gun is still a bad governance
model.

> **May:** classify a candidate. **May not:** mutate the source of truth.

## Evidence storage and synchronization

Evidence is appended in deterministic form and may be synchronized as a traceable
snapshot. Divergence fails closed instead of being overwritten.

> **May:** append and snapshot on request. **May not:** rewrite, reorder, or force divergence away.

## Imported records and typed views

Migration preserves source meaning while projecting fields into the Vivary layer that
already owns each decision. Importing data never makes it authoritative by itself.
Moving a rumor into a nicer folder does not turn it into a fact.

> **May:** project source meaning. **May not:** promote imported data to truth.

## The six refusal lines

| Seam | Permitted action | Refusal that keeps it honest |
| --- | --- | --- |
| Policy | Classify readiness | Never judge its own work |
| Verification | Recompute evidence | Never repair or waive failure |
| Recall | Classify candidates | Never overwrite graph truth |
| Evidence | Append and snapshot | Never rewrite history |
| Synchronization | Transfer identical snapshots | Never hide divergence |
| Migration | Project source meaning | Never promote imports to truth |

Use this reference with [Rebuild the truth path](/learn/0001-rebuild-the-truth-path/)
and [Trace the Lattice seams](/learn/0017-trace-lattice-seams/). Keep the label
**Experimental** attached to both lessons; detailed architecture is not the same thing as
a released contract.
