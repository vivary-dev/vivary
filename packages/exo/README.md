# @vivary/exo

> Status: **stub** (optional layer). See [../../HANDOFF.md](../../HANDOFF.md).

**The orchestration layer** — the exosphere, the thin outermost boundary. Engaged
only when one agent becomes many: multi-agent coordination, role assignment, and
handoff over a shared workspace.

It builds on strato's grammar (FW/WS/PRIV, the inbox/group-chat patterns from
flywheel's multi-agent conventions) and tropo's graph as the shared source of
truth, so parallel agents coordinate against one structured state instead of
stepping on each other.

Most workspaces never need this. Single-agent workspaces stop at tropo + strato.

## To build

Deferred until tropo + strato are solid. Likely a thin layer: role contracts,
work claiming, and conflict detection via the graph.
