# @vivary/exo

> Status: **working** (first slice — read-only coordination). The optional, outermost layer.

**The coordination layer** — the exosphere. Engaged only when one agent becomes
many. exo does **not run agents** (that's the harness / the loops skill) — it reasons
about coordination over the shared tropo graph and hands workers their role
contracts. It reads the graph in-process (one graph, no fork) and is read-only,
deterministic, zero-dependency.

Most workspaces never need this. Single-agent workspaces stop at **tropo + strato**.

## Commands

```bash
python exo.py conflicts --root <workspace>   # who would collide
python exo.py board     --root <workspace>   # what's in flight
python exo.py roles                          # the bounded worker contracts
```

- **`conflicts`** — among `active` work items (changes with `status: active`), flags
  pairs that **share an outbound target** (two in-flight changes touching the same
  module / verification / gate). The graph's collision signal — the coordination
  hazard a task list can't show.
- **`board`** — work items grouped by `status` (and `@assignee` if the workspace
  declares one). The "what's in flight" surface.
- **`roles`** — strato's role grammar as bounded contracts: Orchestrator · Scout ·
  Researcher · Builder · Verifier · Reviewer · Archivist. Workers get a bounded
  contract; they never become product owners.

## Design

- Reuses tropo in-process (like ozone) — no second state store, no new schema.
- Coordination state is **graph-native**: it uses the existing `status` field
  (`active` = in flight). Because `tropo check` is strict, exo does not write
  undeclared fields.
- **Deferred (next slice):** `exo claim <id> --agent <name>` to *set* a claim. Writing
  an `assignee` cleanly needs an opt-in coordination field declaration, so it's a
  follow-up rather than something that bloats every workspace's schema.

## Requirements

Python 3.11+. Loads the sibling `packages/tropo/tropo.py` engine in-process (no pip
install needed in the repo); packaged builds depend on the `tropo` package.
