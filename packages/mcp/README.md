# vivary-mcp

Optional Python 3.11+ read-only MCP adapter for Vivary context.

- Protocol: `2026-07-28`
- SDK: exact `mcp==2.0.0`
- Transport: local standard input/output only
- Tools: `vivary_find`, `vivary_query`, `vivary_check`, `vivary_capsule`
- Authority: operator-bound local roots; no writes, network calls, providers, or
  caller-directed processes
- Status: development source candidate `0.1.2`, unpublished, disabled by default,
  external conformance unproven; requires `vivary-tropo>=0.5.3`.
  Source: [`pyproject.toml`](pyproject.toml); verified: 2026-08-13.

The read-only ceiling belongs to MCP, not to the whole Vivary workspace lifecycle.
The adapter may return a complete public capsule envelope. Save that complete object:
an id or fingerprint alone is not sufficient. An explicitly human-approved,
exact-plan-hash `create-vivary record --capsule <path>` transaction can then create or
update exactly one earned typed record outside MCP. MCP startup and calls never
materialize records or packs.

See the canonical [MCP adapter guide](../../docs/MCP.md) for installation, tool
schemas, privacy boundaries, diagnostics, and verification.
