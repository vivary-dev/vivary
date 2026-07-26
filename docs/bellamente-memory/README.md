# Bellamente AgentLTM predecessor contract

This folder is the authoritative predecessor contract for adding Bellamente as an
optional **AgentLTM** beside `tropo`. It is intentionally documentation-only:
there is no current Bellamente provider, adapter bridge, active MCP setup, install
flow, or public Bellamente command implied by these files. By
[#217](https://github.com/vivary-dev/vivary/issues/217), this contract lands before
and governs [#190](https://github.com/vivary-dev/vivary/pull/190).

## Read in this order

| File | Authority |
|---|---|
| [ADR-0001-bellamente-agent-ltm-beside-tropo.md](ADR-0001-bellamente-agent-ltm-beside-tropo.md) | The architectural decision and the three seam boundary. |
| [CONTEXT.md](CONTEXT.md) | Canonical vocabulary and routes to the owning contract sections. |
| [SPEC-bellamente-memory.md](SPEC-bellamente-memory.md) | The normative future implementation contract. |

## Contract routes

This page routes; it does not restate the normative requirements:

- [ADR decision — AgentLTM beside Tropo and the three seams](ADR-0001-bellamente-agent-ltm-beside-tropo.md#decision)
- [Canonical vocabulary and authority model](CONTEXT.md)
- [SPEC §3 — default policy, storage, and privacy](SPEC-bellamente-memory.md#3-default-policy-storage-and-privacy)
- [SPEC §4 — explicit human gates](SPEC-bellamente-memory.md#4-explicit-human-gates)
- [SPEC §5 — capability and Doctor requirements](SPEC-bellamente-memory.md#5-capability-and-doctor-requirements)
- [SPEC §6 — `CandidateRecallProvider` contract](SPEC-bellamente-memory.md#6-candidaterecallprovider-contract)
- [SPEC §7 — verification tiers](SPEC-bellamente-memory.md#7-verification-tiers)

## Canonical dependencies and decisions

- [Vivary architecture / `vivary-core`](../ARCHITECTURE.md)
- [Optional semantic-memory adapter contract](../SEMANTIC-MEMORY.md)
- [Public commands](../COMMANDS.md)
- [#205 — governed candidate recall](https://github.com/vivary-dev/vivary/issues/205)
- [#207 — capability and Doctor wiring](https://github.com/vivary-dev/vivary/issues/207)
- [#217 — the spec precedes implementation](https://github.com/vivary-dev/vivary/issues/217)
