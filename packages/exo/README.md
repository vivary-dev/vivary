# vivary-exo

> Status: **working** (coordination + graph-native claims). The optional, outermost layer.

**The coordination layer** — the exosphere. Engaged only when one agent becomes
many. exo does **not run agents** (that's the harness / the loops skill) — it reasons
about coordination over the shared tropo graph and hands workers their role
contracts. It reads the graph in-process (one graph, no fork) and has one narrow writer:
`exo claim`, which only updates an opt-in `assignee` field on work items under
`changes/`.

Most workspaces never need this. Single-agent workspaces stop at **tropo + strato**.

## Commands

```bash
python exo.py conflicts --root <workspace>   # who would collide
python exo.py board     --root <workspace>   # what's in flight
python exo.py claim local-ci-baseline --agent connie --root <workspace>
python exo.py roles                          # the bounded worker contracts
```

- **`conflicts`** — among `active` work items (changes with `status: active`), flags
  pairs that **share an outbound target** (two in-flight changes touching the same
  module / verification / gate). The graph's collision signal — the coordination
  hazard a task list can't show.
- **`board`** — work items grouped by `status` (and `@assignee` if the workspace
  declares one). The "what's in flight" surface.
- **`claim <id> --agent <handle>`** — claim a work item under `changes/` by setting
  top-level `assignee`. Agent handles may have an optional leading `@` and then
  letters, digits, `.`, `_`, or `-`; the stored value omits the leading `@`.
  BOM-prefixed frontmatter is updated in place, and malformed frontmatter is rejected
  instead of guessed through.
- **`roles`** — strato's role grammar as bounded contracts: Orchestrator · Scout ·
  Researcher · Builder · Verifier · Reviewer · Archivist. Workers get a bounded
  contract; they never become product owners.

To enable claims, opt into the coordination field:

```toml
packs = ["repo-graph", "coordination"]
```

Then:

```bash
exo claim local-ci-baseline --agent connie
exo board
exo conflicts
tropo check
```

## Design

- Reuses tropo in-process (like ozone) — no second state store, no new schema.
- Coordination state is **graph-native**: `status` marks in-flight work and
  `assignee` records ownership when the workspace opts into `packs = ["coordination"]`.
  Because `tropo check` is strict, exo refuses to write undeclared fields.

## Requirements

Python 3.11+. Loads the sibling `packages/tropo/tropo.py` engine in-process (no pip
install needed in the repo); packaged builds depend on the `tropo` package.

---

Website & docs: <https://vivary.vercel.app/>
