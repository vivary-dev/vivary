# Vivary Bellamente Integration

The domain context for integrating Bellamente as an optional memory provider in Vivary workspaces. This context exists because Bellamente plays a different role than existing semantic-memory providers — it stores agent-usable durable facts beside the typed graph, not as a projection of it.

## Language

**Semantic memory**:
Optional recall capability that returns typed graph node candidates as leads for the agent to inspect. A sidecar over tropo — not a second source of truth. Provider state is rebuildable from the typed graph.
_Avoid_: long-term memory, agent memory (when referring to the Vivary capability)

**Agent LTM**:
Durable agent-usable facts, preferences, decisions-with-provenance, and cross-session lessons. Lives in Bellamente's own store, independent of tropo. Not rebuildable from the typed graph.
_Avoid_: semantic memory (when referring to Bellamente's store)

**Memory provider**:
A pluggable backend selectable via `--memory`. Providers are either tropo-backed recall sidecars (local, cognee) or independent agent LTM systems (bellamente). Same flag, different integration machinery.
_Avoid_: memory backend, memory system

**Tropo**:
The typed knowledge graph. Project truth: typed, checked, deterministic. The source of truth that semantic memory providers project, but that agent LTM sits beside.
_Avoid_: graph, knowledge base

**Greenfield workspace**:
A project at scaffold stage — just started, no real coding done, may have documents. The only workspace stage where Bellamente may be added in v1.
_Avoid_: new project, empty project

**Memory round-trip**:
The acceptance proof that Bellamente is usable, not just installed: write one durable fact, recall it, verify a trace or receipt exists. Uses the workspace's intended interface (Bellamente CLI or MCP), not a hidden test seam.
_Avoid_: smoke test, integration test
