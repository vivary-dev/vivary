# Bellamente is agent LTM beside tropo, integrated via shell-out not adapter

The existing semantic-memory architecture (../SEMANTIC-MEMORY.md) defines all
memory providers as tropo-backed recall sidecars that consume typed graph nodes
and return RecallHit candidates mapped to tropo node ids. The Cognee adapter
(../../packages/memory-cognee) follows this pattern: a Python package that
imports Cognee, builds tropo snapshots, and maps recall hits back to tropo
node ids.

We chose a different shape for Bellamente: it enters a Vivary workspace as
independent agent LTM — durable agent-usable facts with provenance, stored in
Bellamente's own database, not derived from tropo. Tropo remains project truth;
Bellamente holds agent memory; neither silently rewrites the other. There is no
Vivary-owned adapter package. Vivary writes config, MCP wiring, and agent rules,
then shells out to the bella CLI (bella doctor, bella mcp) for verification and
runtime. Bellamente owns its store, MCP server, and runtime.

Considered options:
- A: tropo-backed recall provider (Cognee-shaped Python adapter) — underuses
  Bellamente's product and forces it into Cognee's job
- B: independent agent LTM beside tropo — chosen
- C: full Bellamente product drop-in — too fat for a scaffold option, dual-truth
  risk with Vivary's own MEMORY/STATE/tropo model

Consequences: `--memory bellamente` and `--memory cognee` share a flag but use
different machinery. Cognee means "use this tropo-backed recall provider via a
Python adapter." Bellamente means "wire this workspace with an agent LTM system
via config, MCP, and shell-out." The RecallProvider/MemoryProvider protocol from
../SEMANTIC-MEMORY.md does not apply to Bellamente. Doctor checks for Bellamente
shell out to `bella doctor`, not to a Python import check.
