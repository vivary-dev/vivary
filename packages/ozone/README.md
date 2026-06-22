# vivary-ozone

> Status: **working** (first slice — deterministic review). The optional review layer.

**The review layer** — the protective filter. Where `tropo` answers *"is each
document valid?"*, `ozone` reviews the **whole graph**: the relationship-level gaps a
per-document check can't see, and the **blast radius** of a change — everything that
depends on it. A review is graph-aware by construction because ozone reads tropo's
typed graph in-process (one graph implementation, never a fork).

The defining idea: **code review and editorial review are the same layer with
different rule packs.** This first slice ships the deterministic core — one
`structure` pack over the Vivary workspace vocabulary, zero dependencies, no LLM.
Medium-specific and semantic ("organize by meaning") review layer on top later;
semantic relatedness is graphify's job, not ozone's core.

## Try it locally

```bash
python ozone.py review --root <workspace>      # findings over the graph
python ozone.py review --root <workspace> --strict   # gate mode: exit 1 on warnings
python ozone.py impact <id> --root <workspace> # what depends on <id> (blast radius)
python ozone.py packs                          # list rule packs
```

`review` is **advisory by default** (exit 0) — a work-in-progress change legitimately
has nothing verifying it yet. Pass `--strict` to make it a gate (exit 1 when warnings
exist), e.g. pre-merge or in CI. `tropo check` remains the hard structural gate;
ozone is the relationship/impact review layered on top.

## The `structure` pack

Deterministic, topology-derived findings keyed on a node's workspace folder:

| rule | severity | fires when |
|---|---|---|
| `change-unverified` | warn | a `changes/` node has no `verification` edge |
| `change-ungated` | info | a `changes/` node has no `gates` edge |
| `module-unverified` | info | a `modules/` node has no `verification` edge |
| `orphan` | info | a node has no edges in or out |
| `broken-edge` | warn | an edge points at a missing node (tropo `check` enforces this) |

## Render

For a visual of a change's blast radius, reuse tropo's renderer:

```bash
python ../tropo/tropo.py view blast <id> --root <workspace> --out impact.html
```

## Requirements

Python 3.11+. Loads the sibling `packages/tropo/tropo.py` engine in-process (no pip
install needed in the repo); packaged builds depend on the `tropo` package.

---

Website & docs: <https://vivary.vercel.app/>
