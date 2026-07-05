# vivary-memory-cognee

Optional Cognee adapter for Vivary semantic memory.

This package keeps Vivary graph-first:

- `tropo` analyzes the workspace and owns typed graph truth.
- `vivary-cognee index` sends only privacy-filtered typed node packets to Cognee.
- `vivary-cognee recall` accepts only hits that map back to known Vivary node ids.
- provider state under `.vivary/memory/cognee/` is rebuildable cache.
- Cognee runtime directories are scoped to the workspace `state_path`.

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

Indexing and forgetting require `--yes` because they write provider memory. Provider
runtime calls also require `memory.cognee.allow_network = true`; the generated
default is `false`, so dry-runs and doctor checks are safe until a human explicitly
enables the Cognee/embedding provider path. If `memory.cognee.api_key_env` is set,
that environment variable must be present before provider writes or recalls run. Local
providers that intentionally need no API key must set
`memory.cognee.allow_without_api_key = true`. Cognee telemetry is disabled by
default unless `memory.cognee.allow_telemetry = true` is set explicitly; inherited
tracing environment variables are forced off by the default policy.
`doctor` checks package presence without importing Cognee runtime; runtime commands
bind Cognee's state/cache/log roots to the workspace before import.
Recall requires a current manifest fingerprint. Approved index replaces the previous
workspace-bound dataset first, and `forget --yes` requests dataset deletion instead of
a memory-only reset. Dataset names include a workspace path hash even when a label is
configured, so one workspace cannot accidentally target another workspace's dataset.

The adapter never imports Cognee from core Vivary packages.
