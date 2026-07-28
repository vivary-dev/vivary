# vivary

One install for the full Vivary CLI suite:

```bash
python -m pip install vivary
```

That pulls the four layers, each still usable on its own:

- `create-vivary` — scaffold or adopt an agent-native workspace
- `tropo` (`vivary-tropo`) — the typed knowledge graph
- `ozone` (`vivary-ozone`) — graph-aware review
- `exo` (`vivary-exo`) — multi-agent coordination

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
