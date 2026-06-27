# vivary-memory-cognee

Optional Cognee adapter for Vivary semantic memory.

This package keeps Vivary graph-first:

- `tropo` analyzes the workspace and owns typed graph truth.
- `vivary-cognee index` sends only privacy-filtered typed node packets to Cognee.
- `vivary-cognee recall` accepts only hits that map back to known Vivary node ids.
- provider state under `.vivary/memory/cognee/` is rebuildable cache.

Install this package only when a workspace explicitly opts into Cognee:

```bash
pip install vivary-memory-cognee
```

Useful commands:

```bash
vivary-cognee doctor --root . --json
vivary-cognee index --root . --dry-run --json
vivary-cognee index --root . --yes --json
vivary-cognee recall "where is auth handled" --root . --json
vivary-cognee forget --root . --yes --json
```

Indexing and forgetting require `--yes` because they write provider memory. The
adapter never imports Cognee from core Vivary packages.
