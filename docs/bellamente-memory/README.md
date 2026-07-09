# Bellamente Memory Integration

Design and specification for adding Bellamente as an optional memory provider
in Vivary workspaces. All context for this integration lives here.

## Files

| File | What it is |
|---|---|
| [SPEC-bellamente-memory.md](SPEC-bellamente-memory.md) | Full spec: locked decisions, install flow, file list, MCP configs, test plan |
| [CONTEXT.md](CONTEXT.md) | Domain glossary: semantic memory vs agent LTM vs memory provider vs tropo |
| [ADR-0001-bellamente-agent-ltm-beside-tropo.md](ADR-0001-bellamente-agent-ltm-beside-tropo.md) | Architectural decision: Bellamente is agent LTM beside tropo, not a Cognee-shaped recall sidecar |

## Related (outside this folder)

- [../SEMANTIC-MEMORY.md](../SEMANTIC-MEMORY.md) — existing semantic memory architecture (Cognee pattern we are NOT following for Bellamente)
- [../../packages/memory-cognee/](../../packages/memory-cognee/) — the Cognee adapter implementation (contrast with our shell-out approach)
- Bellamente repo (`The-Little-AI-Company/bellamente`) — `src/mcp.ts` has the working MCP server with 9 tools

## Status

Design locked via `/grill-with-docs` session on 2026-07-09. 19 decisions locked.
Ready for implementation planning.
