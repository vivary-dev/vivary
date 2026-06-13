# @vivary/ozone

> Status: **stub** (optional layer). See [../../HANDOFF.md](../../HANDOFF.md).

**The review layer** — the protective filter. Ozone is the stratum that filters
out what's harmful; this layer reviews changes before they land.

The defining idea: **code review and editorial review are the same layer with
different rule packs.** ozone runs over tropo's graph, so a review is
graph-aware — it can show a change's **blast radius** (what else it touches), not
just a line diff.

- For code: correctness, security, regressions, the impact set.
- For prose: voice, claims/citations, structure, the impact set.

A review is a specialized `verify`/`gate` step in strato's loop, factored out so
it can be invoked on its own.

## To build

Depends on tropo's graph layer (`graph`/`blast`) existing first. Then: rule packs
per medium, and a render of the review + blast radius (reuse tropo's `view`).
