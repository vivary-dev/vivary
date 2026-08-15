# @vivary/create

`@vivary/create` is the npm launcher for Vivary's lightweight, local-first
governed-context scaffolder. It forwards arguments unchanged to the Python
`create-vivary` CLI; there is no second JavaScript implementation.

Published and development version truth lives in the
[root release status](https://github.com/vivary-dev/vivary/blob/dev/README.md#release-status).
The unpublished source candidates are `@vivary/create 0.4.2` and
`create-vivary 0.4.2`; both require `vivary-tropo>=0.5.3`.

Published registry commands pin **0.3.1**. Do not use unpinned `@latest` while
unpublished 0.4.2 remains off the registry.

```bash
npx --yes @vivary/create@0.3.1 my-workspace -- --preset coding --no-wizard
npx --yes @vivary/create@0.3.1 doctor my-workspace --json

# Existing repo: preview, then apply with --yes. Exact-hash --plan is unpublished 0.4.2.
npx --yes @vivary/create@0.3.1 adopt . --json
npx --yes @vivary/create@0.3.1 adopt . --yes
```

Published 0.3.1 writes the full-layout scaffold. The five-file payload, `record`,
and exact-hash `--plan` apply below are unpublished 0.4.2.

```bash
npx --yes @vivary/create@0.3.1 init my-workspace --adapter agents
```

Each agent adapter adds at most one bounded file. The active-context option keeps the
five-file seed: it declares the capability and ignores its local index path. It does
not copy guidance, install or run an indexer, enable MCP, or transmit source. Obsidian
setup is separate from thin init.

Doctor is read-only unless an explicit write mode such as `--trend` is selected. It
recognizes both the new `thin-v0.3` contract and older `legacy-full` workspaces without
silently migrating them.

The launcher uses [uv](https://docs.astral.sh/uv/) (`uvx`) or
[pipx](https://pipx.pypa.io/) to run the matching Python package. Python 3.11+ and uv
or pipx must already be installed.

License: MIT.

Website and docs: <https://vivary.vercel.app/>
