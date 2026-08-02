# vivary

One install for the full Vivary CLI suite:

```bash
python -m pip install vivary
```

Current published and development source versions live in the
[root release status](../../README.md#release-status).

That pulls the four layers, each still usable on its own:

- `create-vivary` — scaffold or adopt an agent-native workspace
- `tropo` (`vivary-tropo`) — the typed knowledge graph
- `ozone` (`vivary-ozone`) — graph-aware review and governed evidence verification
- `exo` (`vivary-exo`) — legacy coordination and a bounded governed-control adapter

Ozone's opt-in governed path verifies capsule-bound evidence without writing:

```bash
ozone verify request.json --governed --json --strict
```

Exo's governed path is development source only:

```bash
exo control request.json --governed --json --strict
```

The [command reference](../../docs/COMMANDS.md#governed-control-development-source)
owns its request envelope and examples. The [Core package README](../core/README.md#governed-exo-control)
owns its lifecycle semantics.

It also installs the small `vivary` helper CLI for local receipt visibility:

```bash
tropo check --root . --receipt .vivary/receipts.jsonl
vivary logs .vivary/receipts.jsonl
vivary logs email .vivary/receipts.jsonl --to support@example.com --out .vivary/support.eml
```

`vivary logs email` writes a local draft or prints a `mailto:` URL. It does not send
mail, upload telemetry, or include stdout/stderr, file contents, raw query text, target
ids, or local paths.

Docs: https://vivary.vercel.app/
