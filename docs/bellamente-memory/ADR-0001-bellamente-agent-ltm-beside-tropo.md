# ADR-0001: Bellamente Agent LTM beside tropo under governed recall

**Status:** approved predecessor contract. Per [#217](https://github.com/vivary-dev/vivary/issues/217), this contract lands before and governs [#190](https://github.com/vivary-dev/vivary/pull/190); it describes required future behavior, not a shipped Bellamente integration.

## Decision

Bellamente, when a person explicitly enables it, is an **AgentLTM**: a durable,
workspace-local, independent store for agent-usable assertions and their provenance.
`tropo` remains typed project truth. Learned memory never silently becomes or replaces
authored truth.

This decision creates three distinct seams:

| Seam | Responsibility | Boundary |
|---|---|---|
| **SemanticMemoryAdapter** | A local or Cognee projection of privacy-approved typed `tropo` nodes for semantic retrieval. | It owns its privacy filtering and returns typed `RecallHit` candidates. Its state is rebuildable from graph truth. |
| **AgentLTM** | Bellamente's independent durable store for approved agent memory. | Its data lives only at `.bellamente/data/`; it is not a `tropo` projection and never shares a physical store with semantic memory or Vivary core. |
| **CandidateRecallProvider** | An optional source of normalized prior assertions for the `vivary-core` candidate-recall firewall. | Before core evaluation, every Bellamente candidate must carry typed evidence/provenance and a known stable `tropo` node ID. The firewall, not similarity, governs whether it can corroborate, challenge, or request review. |

The existing semantic `RecallHit` adapter protocol does **not** directly model
AgentLTM. If AgentLTM data crosses into Vivary, it crosses through a future
`CandidateRecallProvider` normalization boundary and the core firewall.

## Authority, privacy, and storage

- **Default is none.** Scaffold and adopt may create only disabled AgentLTM policy,
  inert setup documentation, and the `.bellamente/` runtime-data ignore entry. They
  do not activate Bellamente, install anything, create a live store, configure MCP,
  or mutate memory.
- **No provider collision.** AgentLTM policy is separate from the `[memory]`
  semantic-provider slot. Bellamente is never selected as a semantic provider merely
  because its policy exists.
- **No shared physical store.** `.bellamente/data/` is workspace-local and ignored;
  only normalized IDs and evidence references may cross seams.
- **Fail closed before data leaves a seam.** The required private set is exactly
  `USER.md`, `MEMORY.md`, `memory/**`, `heartbeat-reports/**`, and
  `.strato/private/**`. Today semantic adapters receive that full set from generated
  policy and `.gitignore`; their built-in floor does not yet include
  `.strato/private/**`. Future implementation must make the full set an
  adapter-internal floor and keep it out of indexing, recall, AgentLTM writes, ingest,
  and candidate emission.
- **No automatic promotion.** Exact duplicates preserve the prior assertion;
  corroboration records evidence rather than truth; conflict or identity ambiguity
  preserves both sides and returns `review_required`. An explicit correction remains
  an explicit, approved operation and never automatically overwrites authored truth.

## Gates and observability

External installation, activation, MCP enablement, and each write, correct, forget,
ingest, and live proof require separate human approval. Generated `AGENTS.md` content
is out of scope; MCP material is inert setup guidance only, never an active server
configuration.

Future capability discovery remains declarative: it advertises disabled AgentLTM
policy without probing or executing Bellamente and must report `installed: false`.
A separately approved runtime diagnostic may report external readiness under a
differently named field. Future Doctor behavior is likewise declarative and uses
namespaced states (`agent-ltm-disabled`, `agent-ltm-policy-present`,
`agent-ltm-misconfigured`) rather than probing or calling the external runtime.

The real write → recall → trace demonstration is release dogfood after its own human
gate. It is neither an installer side effect nor a unit-test substitute.

## Consequences

A future integration may add a bridge, policy parser, capability entry, Doctor section,
or explicit MCP activation flow; this ADR does not preselect package placement or
claim any of those surfaces exist. Such work must satisfy the normalized outcomes in
[#205](https://github.com/vivary-dev/vivary/issues/205): duplicate, corroboration,
explicit correction, unresolved identity, incompatible value, staleness, and provider
degradation remain distinct and visible.

## References

- [Bellamente predecessor specification](SPEC-bellamente-memory.md)
- [Bellamente terminology](CONTEXT.md)
- [Vivary architecture and `vivary-core`](../ARCHITECTURE.md)
- [Optional semantic-memory adapter contract](../SEMANTIC-MEMORY.md)
- [Public command contract](../COMMANDS.md)
- [#205 — governed candidate recall](https://github.com/vivary-dev/vivary/issues/205)
- [#207 — capability and Doctor wiring](https://github.com/vivary-dev/vivary/issues/207)
- [#217 — spec precedes implementation](https://github.com/vivary-dev/vivary/issues/217)
