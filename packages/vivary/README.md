# vivary

`vivary 0.2.0` is the source version and provides one install for the Vivary CLI
suite:

```bash
python -m pip install vivary
```

Release verification builds local wheels and proves their composition without
consulting a registry:

```bash
python -m pip install --no-index --find-links <wheelhouse> vivary
```

Published versions live in the
[root release status](../../README.md#release-status). Pin an exact version when you
need to reproduce a specific composition.

The install includes:

- `create-vivary>=0.4.3`: thin greenfield init and deterministic brownfield adoption.
- `vivary-tropo>=0.5.4`: typed governed context and local retrieval.
- `vivary-strato>=0.1.3`: policy and deliberate human gates.
- `vivary-ozone>=0.3.2`: review and evidence verification.
- `vivary-exo>=0.3.1`: optional bounded orchestration.

It receives `vivary-core` transitively through the role packages rather than owning a
duplicate Core floor.

The `vivary` command is also the front door. It routes ten task verbs to the
installed components in the same process, grouped in `vivary --help` as Workspace,
Graph and retrieval, Policy, Review, and Coordination:

```bash
vivary create my-workspace --preset coding --no-wizard
vivary check --root my-workspace
vivary review --root my-workspace --strict
```

Each route declares the component version floor it needs, and a component below
that floor is refused with exit code 2. The standalone `create-vivary`, `tropo`,
`strato`, `ozone`, and `exo` commands remain the advanced surface with the full
operation set and are not deprecated. `vivary <verb> --help` currently prints the
component program name in its usage line.

Ozone and Exo expose explicit governed paths:

```bash
ozone verify request.json --governed --json --strict
exo control request.json --governed --json --strict
```

The small `vivary` helper CLI reads local receipts and can render a local email draft:

```bash
tropo check --root . --receipt .vivary/receipts.jsonl
vivary logs .vivary/receipts.jsonl
vivary logs email .vivary/receipts.jsonl --to support@example.com --out .vivary/support.eml
```

It does not send mail or upload telemetry. Drafts exclude stdout, stderr, file
contents, raw query text, target ids, and local paths.

Docs: <https://vivary.vercel.app/>
