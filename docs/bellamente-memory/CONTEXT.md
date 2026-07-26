# Bellamente AgentLTM context

This glossary governs the predecessor contract for Bellamente beside `tropo`. It
uses the canonical semantic-memory and core contracts; it does not describe a
currently enabled provider, command, MCP server, or store.

## Terms

| Term | Meaning | Do not use it for |
|---|---|---|
| **`tropo` truth** | Typed, inspectable project truth with stable node IDs. | A cache, vector index, or learned assertion store. |
| **SemanticMemoryAdapter** | A local or Cognee projection over privacy-approved `tropo` nodes that returns typed `RecallHit` leads. | Bellamente or a durable independent store. |
| **AgentLTM** | Bellamente's independently stored, durable, agent-usable assertions and provenance, when explicitly enabled. | A semantic-memory provider or authored truth. |
| **CandidateRecallProvider** | A future optional source of normalized prior assertions for the `vivary-core` candidate-recall firewall. | A direct `RecallHit` adapter or an authority to write truth. |
| **Candidate assertion** | A normalized, evidence-bearing learned assertion that names a known stable `tropo` node ID before core evaluation. | A graph node, automatically accepted fact, or source of authority. |
| **Authored truth** | Human-authored or otherwise authoritative project content in the typed graph. | Something learned memory may silently replace. |
| **Corroboration** | New independent evidence for a compatible assertion. | Automatic promotion to authored truth. |
| **Explicit correction** | A separately approved request to create or supersede a specifically identified assertion. | A similarity match or implicit overwrite. |
| **`review_required`** | The visible result for unresolved identity or incompatible values; both sides remain preserved. | A successful correction or a dropped conflict. |
| **Provider degradation** | Missing, malformed, or failed optional recall input reported visibly to the caller. | Permission to bypass the firewall or degrade authority checks. |
| **Staleness** | A candidate, node, or evidence reference that is no longer current; do not promote or mutate until revalidated. | Provider degradation or permission to overwrite. |

## Non-negotiable boundaries

- The default is **no AgentLTM**. A scaffold or adopt surface leaves
  `[agent-ltm].enabled = false`, writes the `.bellamente/` runtime-data ignore entry,
  and provides only inert guidance.
- AgentLTM data is workspace-local at `.bellamente/data/`; no semantic adapter,
  core store, or other workspace shares that physical store.
- The normative private-set list and enforcement boundary live only in
  [SPEC §3.3](SPEC-bellamente-memory.md#33-fail-closed-private-set). Current shipped
  adapter behavior and known limitations live in
  [Semantic Memory](../SEMANTIC-MEMORY.md#privacy-boundary); this glossary does not
  restate either contract.
- Candidate normalization and unresolved-identity handling live only in
  [SPEC §6](SPEC-bellamente-memory.md#6-candidaterecallprovider-contract).
- No learned assertion silently promotes to authored truth. Duplicate preserves;
  corroboration adds evidence; ambiguity or conflict preserves both and requests
  review.

## Gate language

**Policy-present** means disabled policy exists; it does not mean installed,
activated, reachable, or healthy. **Activated** means a human separately approved
changing the disabled policy. **Enabled MCP** means a distinct human approval; setup
text alone never enables it. Every write, correct, forget, ingest, and real live proof
requires its own human approval.

A capability declaration may name `bella` as an external executable requirement, but
it is declarative only: neither capability discovery nor Doctor may locate or execute
it. Capability discovery reports `installed: false`; Doctor reports namespaced
AgentLTM policy states, not external-runtime health.

## Verification language

**Contract tests** cover normalized candidate inputs and the distinct duplicate,
corroboration, correction, conflict, identity, stale, and degraded outcomes without
an external store. **Scaffold/Doctor tests** prove disabled, inert behavior without
probing an executable. **Release dogfood** is the separately approved real
write → recall → trace demonstration; it is not an installation effect or a unit test.

See the [specification](SPEC-bellamente-memory.md),
[ADR](ADR-0001-bellamente-agent-ltm-beside-tropo.md),
[semantic-memory contract](../SEMANTIC-MEMORY.md), and
[`vivary-core` architecture](../ARCHITECTURE.md).
