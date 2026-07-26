# Bellamente AgentLTM context

This glossary routes Bellamente vocabulary. The
[specification](SPEC-bellamente-memory.md) owns the predecessor contract; this file
does not describe a currently enabled provider, command, MCP server, or store.

## Terms

| Term | Meaning | Do not use it for |
|---|---|---|
| **`tropo` truth** | Typed, inspectable project truth with stable node IDs. | A cache, vector index, or learned assertion store. |
| **SemanticMemoryAdapter** | A local or Cognee projection over privacy-approved `tropo` nodes that returns typed `RecallHit` leads. | Bellamente or a durable independent store. |
| **AgentLTM** | Bellamente's independently stored, durable, agent-usable assertions and provenance, when explicitly enabled. | A semantic-memory provider or authored truth. |
| **CandidateRecallProvider** | A future optional source of normalized prior assertions for the `vivary-core` candidate-recall firewall. | A direct `RecallHit` adapter or an authority to write truth. |
| **Candidate assertion** | An evidence-bearing learned assertion normalized according to [SPEC §6.1](SPEC-bellamente-memory.md#61-normalized-input-boundary). | A graph node, automatically accepted fact, or source of authority. |
| **Authored truth** | Human-authored or otherwise authoritative project content in the typed graph. | Something learned memory may silently replace. |
| **Corroboration** | New independent evidence for a compatible assertion. | Automatic promotion to authored truth. |
| **Explicit correction** | A separately approved request to create or supersede a specifically identified assertion. | A similarity match or implicit overwrite. |
| **`review_required`** | The core decision defined by the result table in [SPEC §6.2](SPEC-bellamente-memory.md#62-required-distinct-results). | A successful correction or a dropped conflict. |
| **Provider degradation** | Missing, malformed, or failed optional recall input reported visibly to the caller. | Permission to bypass the firewall or degrade authority checks. |
| **Staleness** | A candidate, node, or evidence reference that is no longer current; do not promote or mutate until revalidated. | Provider degradation or permission to overwrite. |

## Contract routes

- Opt-in policy creation and defaults live only in
  [SPEC §3.1](SPEC-bellamente-memory.md#31-disabled-by-default); the complete human
  gate matrix lives in [SPEC §4](SPEC-bellamente-memory.md#4-explicit-human-gates).
- Physical-store and privacy boundaries live only in
  [SPEC §§3.2–3.3](SPEC-bellamente-memory.md#32-independent-physical-store).
  Current shipped semantic-adapter behavior and limitations live in
  [Semantic Memory](../SEMANTIC-MEMORY.md#privacy-boundary).
- Capability and Doctor requirements, including the complete state vocabulary, live
  only in [SPEC §5](SPEC-bellamente-memory.md#5-capability-and-doctor-requirements).
- Candidate normalization, unresolved identity, and every core result live only in
  [SPEC §6](SPEC-bellamente-memory.md#6-candidaterecallprovider-contract).

## Gate language

Use the gate matrix and Doctor state names exactly as defined in
[SPEC §§4–5](SPEC-bellamente-memory.md#4-explicit-human-gates); this glossary defines
no variants or additional implications.

## Verification language

The authoritative contract-test, scaffold/Doctor-test, and release-dogfood tiers live
only in [SPEC §7](SPEC-bellamente-memory.md#7-verification-tiers). This glossary does
not restate their required outcomes.

See the [specification](SPEC-bellamente-memory.md),
[ADR](ADR-0001-bellamente-agent-ltm-beside-tropo.md),
[semantic-memory contract](../SEMANTIC-MEMORY.md), and
[`vivary-core` architecture](../ARCHITECTURE.md).
