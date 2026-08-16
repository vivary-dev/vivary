# vivary

`vivary 0.1.10` is published and provides one install for the Vivary CLI suite:

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

- `create-vivary>=0.4.2`: thin greenfield init and deterministic brownfield adoption.
- `vivary-tropo>=0.5.3`: typed governed context and local retrieval.
- `vivary-strato>=0.1.2`: policy and deliberate human gates.
- `vivary-ozone>=0.3.1`: review and evidence verification.
- `vivary-exo>=0.3.0`: optional bounded orchestration.

It receives `vivary-core` transitively through the role packages rather than owning a
duplicate Core floor.

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
