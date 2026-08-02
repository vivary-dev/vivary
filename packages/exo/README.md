# vivary-exo

> Release status: [root release status](../../README.md#release-status).
> `exo control` is unpublished development source.

`exo` is the optional outer coordination layer. It has two separate surfaces:

- **Legacy graph coordination** reads the Tropo graph. `exo claim` remains the only
  legacy graph write. It updates an opted-in work item's `assignee`.
- **Governed control** dispatches one bounded Core lifecycle request over
  caller-supplied state. The caller persists the returned projection.

Most workspaces do not need Exo. Single-agent workspaces stop at `tropo + strato`.

## Legacy graph coordination

```bash
exo conflicts --root <workspace>
exo board --root <workspace>
exo claim local-ci-baseline --agent connie --root <workspace>
exo roles
```

`conflicts` reports active work items that share an outbound target. `board` groups
work items by `status` and declared `@assignee`. `roles` prints the bounded worker
contracts.

To enable the legacy claim field, declare it in the workspace:

```toml
packs = ["repo-graph", "coordination"]
```

`exo claim` accepts an optional leading `@` in an agent handle. It refuses malformed
frontmatter, undeclared fields, and symlinked or out-of-workspace work item targets. For
a hard-linked work item, it safely replaces the workspace path without mutating the
other linked file.

## Governed control

```bash
exo control REQUEST --governed [--json] [--strict]
```

This command sends one complete request to Core. It does not persist the request,
result, claim ledger, task list, or execution log. The
[command reference](../../docs/COMMANDS.md#governed-control-development-source) owns
the exact request envelope, operation list, runnable examples, and strict exits. The
[Core control contract](../core/README.md#governed-exo-control) owns lifecycle
semantics.

The adapter adds no scheduler, state store, agent runner, network or provider call,
MCP server, repair write, or publishing path. It makes no Agent Relay compatibility or
byte-parity claim.

Local `--receipt` records are separate from governed state and are not telemetry. See
the [receipt policy](../../docs/COMMANDS.md#local-run-receipts-are-not-telemetry).

## Requirements

Python 3.11+. Packaged builds declare the Tropo and Core dependency floors in
[pyproject.toml](pyproject.toml).

Website and canonical docs: <https://vivary.vercel.app/>
