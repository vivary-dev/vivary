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
| [CONTEXT.md](CONTEXT.md) | Canonical vocabulary, authority rules, privacy, gates, and test-tier terms. |
| [SPEC-bellamente-memory.md](SPEC-bellamente-memory.md) | The normative future implementation contract. |

## Contract at a glance

- **Three seams:** `SemanticMemoryAdapter` is a privacy-filtered `tropo`
  projection; `AgentLTM` is Bellamente's independent store; and
  `CandidateRecallProvider` normalizes prior assertions for the `vivary-core`
  firewall.
- **Default none:** scaffold/adopt may write only disabled `[agent-ltm]` policy and
  inert instructions. It must not install, activate, create a live store, enable MCP,
  add generated `AGENTS.md` content, or mutate memory.
- **Separate stores:** AgentLTM data belongs only at `.bellamente/data/`. It never
  shares a physical store with `tropo`, semantic provider state, or Vivary core.
- **Fail closed:** `USER.md`, `MEMORY.md`, `memory/**`, `heartbeat-reports/**`, and
  `.strato/private/**` cannot enter indexing, ingest, AgentLTM, or normalized
  candidates.
- **Governed crossing:** Bellamente candidates need typed evidence/provenance and a
  known stable `tropo` node ID. Duplicate, corroboration, explicit correction,
  conflict/identity ambiguity, staleness, and degradation remain distinct outcomes;
  learned memory never replaces authored truth automatically.
- **Human gates:** installation, activation, MCP enablement, every write/correct/
  forget/ingest action, and the real write → recall → trace proof are separately
  approved. The proof is release dogfood, never an installer side effect or unit test.

## Current public surface

Use the existing command contract only:

```bash
create-vivary capabilities --json
create-vivary doctor <target> --json
```

Future capability discovery must declare `requires_external_executable: ["bella"]`
without probing or executing it; `installed`, if reported, means Vivary-side
policy/wiring only. Future Doctor behavior is likewise declarative and never calls the
external executable. Inert documentation may explain a future manual MCP decision,
but it must not create an active server configuration.

## Canonical dependencies and decisions

- [Vivary architecture / `vivary-core`](../ARCHITECTURE.md)
- [Optional semantic-memory adapter contract](../SEMANTIC-MEMORY.md)
- [Public commands](../COMMANDS.md)
- [#205 — governed candidate recall](https://github.com/vivary-dev/vivary/issues/205)
- [#207 — capability and Doctor wiring](https://github.com/vivary-dev/vivary/issues/207)
- [#217 — the spec precedes implementation](https://github.com/vivary-dev/vivary/issues/217)
