# vivary

The unpublished 0.1.7 source manifest defines one install for the full Vivary CLI
suite. Release verification builds all local wheels. It proves that composition
without consulting a registry:

```bash
python -m pip install --no-index --find-links <wheelhouse> vivary
```

Do not use an unpinned registry install to verify this development line. Current
published and source versions live in the
[root release status](../../README.md#release-status).

The source install pulls every role, each still usable on its own:

- `create-vivary`: scaffold or adopt an agent-native workspace.
- `tropo` (`vivary-tropo`): the typed knowledge graph and governed context compiler.
- `strato` (`vivary-strato`): governed policy and human-gate decisions.
- `ozone` (`vivary-ozone`): graph-aware review and governed evidence verification.
- `exo` (`vivary-exo`): legacy coordination and bounded governed control.

The unpublished 0.1.7 source line requires `create-vivary>=0.3.4`,
`vivary-tropo>=0.5.2`, and `vivary-strato>=0.1.2`. It receives `vivary-core`
transitively through the role packages rather than owning a duplicate Core floor.
Source: [`pyproject.toml`](pyproject.toml); verified: 2026-08-09.
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
mail or upload telemetry. The draft excludes stdout, stderr, file contents, raw query
text, target ids, and local paths.

Docs: https://vivary.vercel.app/
