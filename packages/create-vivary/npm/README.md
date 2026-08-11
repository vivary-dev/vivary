# @vivary/create

`@vivary/create` is the npm launcher for Vivary's lightweight, local-first
governed-context scaffolder. It forwards arguments unchanged to the Python
`create-vivary` CLI; there is no second JavaScript implementation.

Published and development version truth lives in the
[root release status](https://github.com/vivary-dev/vivary/blob/dev/README.md#release-status).
The unpublished source candidates are `@vivary/create 0.4.0` and
`create-vivary 0.4.0`; both require `vivary-tropo>=0.5.2`.

```bash
npm create @vivary@latest my-workspace -- --preset coding
npx @vivary/create@latest doctor my-workspace --json

# Existing repo: preview, inspect the plan hash, then apply that exact plan.
npx @vivary/create@latest adopt . --json
npx @vivary/create@latest adopt . --yes --plan sha256:<plan-hash> --json

# One earned record: preview, approve, then apply one capsule-bound plan.
npx @vivary/create@latest record . changes/verified-slice.md --from ./verified-slice.md \
  --capsule ./task-capsule.json --json
npx @vivary/create@latest record . changes/verified-slice.md --from ./verified-slice.md \
  --capsule ./task-capsule.json \
  --yes --plan sha256:<plan-hash> --json
```

A default new-workspace init creates three Vivary payload files plus the bounded host
integrations `AGENTS.md` and `.gitignore`. Brownfield adoption remains capped at the
same three payload creates and may separately create or patch only those two host
integration surfaces. Neither path copies templates, runtime skills, placeholders,
starter records, or framework prose.

`record` is not a pack installer. It validates the complete governed capsule and its
current workspace binding, plans exactly one typed record, requires the exact approved
hash before writing, reruns Doctor, and rolls back on failed verification. The npm
package only forwards this command to the canonical Python implementation.

Optional adapters are explicit:

```bash
npx @vivary/create@latest init my-workspace --adapter agents --adapter claude
npx @vivary/create@latest init my-codebase --active-context cocoindex-code
```

Each agent adapter adds at most one bounded file. The active-context option adds two
bounded guidance files; it does not install or run an indexer, enable MCP, or transmit
source. Obsidian setup is separate from thin init.

Doctor is read-only unless an explicit write mode such as `--trend` is selected. It
recognizes both the new `thin-v0.3` contract and older `legacy-full` workspaces without
silently migrating them.

The launcher uses [uv](https://docs.astral.sh/uv/) (`uvx`) or
[pipx](https://pipx.pypa.io/) to run the matching Python package. Python 3.11+ and uv
or pipx must already be installed.

License: MIT.

Website and docs: <https://vivary.vercel.app/>
