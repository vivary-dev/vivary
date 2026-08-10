# vivary-mcp

Optional Python 3.11+ read-only MCP adapter for Vivary context.

- Protocol: `2026-07-28`
- SDK: exact `mcp==2.0.0`
- Transport: local standard input/output only
- Tools: `vivary_find`, `vivary_query`, `vivary_check`, `vivary_capsule`
- Authority: operator-bound local roots; no writes, network calls, providers, or
  caller-directed processes
- Status: development source, unpublished, disabled by default, external conformance
  unproven

See the canonical [MCP adapter guide](../../docs/MCP.md) for installation, tool
schemas, privacy boundaries, diagnostics, and verification.
