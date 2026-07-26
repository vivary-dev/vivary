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
| **CandidateRecallProvider** | An optional source of normalized prior assertions for the `vivary-core` candidate-recall firewall. | Before core evaluation, normalization follows [SPEC §6.1](SPEC-bellamente-memory.md#61-normalized-input-boundary), including its defined known-ID-or-unresolved-marker boundary. The firewall, not similarity, governs whether a candidate can corroborate, challenge, or request review. |

The existing semantic `RecallHit` adapter protocol does **not** directly model
AgentLTM. If AgentLTM data crosses into Vivary, it crosses through a future
`CandidateRecallProvider` normalization boundary and the core firewall.

## Authority, privacy, and storage

- **Default is none.** Opt-in policy creation, permitted scaffold/adopt output, and
  prohibited automatic behavior are owned only by
  [SPEC §§3.1 and 4](SPEC-bellamente-memory.md#31-disabled-by-default).
- **No provider collision.** AgentLTM policy is separate from the `[memory]`
  semantic-provider slot. Bellamente is never selected as a semantic provider merely
  because its policy exists.
- **No shared physical store.** `.bellamente/data/` is workspace-local and ignored;
  only normalized IDs and evidence references may cross seams.
- **Fail closed before data leaves a seam.** The normative private-set list and
  enforcement boundary live only in [SPEC §3.3](SPEC-bellamente-memory.md#33-fail-closed-private-set);
  this ADR does not restate them. Current shipped semantic-adapter behavior and known
  limitations live in [Semantic Memory](../SEMANTIC-MEMORY.md#privacy-boundary).
- **No automatic promotion.** Truth and mutation outcomes are owned only by
  [SPEC §6.2](SPEC-bellamente-memory.md#62-required-distinct-results); this ADR fixes
  only the architectural rule that learned memory never silently replaces authored
  truth.

## Gates and observability

The normative gate matrix, capability/Doctor behavior, and release-dogfood boundary
live only in [SPEC §§4–7](SPEC-bellamente-memory.md#4-explicit-human-gates). This ADR
does not restate their actions, state vocabulary, or verification tiers.

## Consequences

A future integration may add a bridge, policy parser, capability entry, Doctor section,
or explicit MCP activation flow; this ADR does not preselect package placement or
claim any of those surfaces exist. Such work must implement the normalized outcomes
owned by [SPEC §6.2](SPEC-bellamente-memory.md#62-required-distinct-results).

## References

- [Bellamente predecessor specification](SPEC-bellamente-memory.md)
- [Bellamente terminology](CONTEXT.md)
- [Vivary architecture and `vivary-core`](../ARCHITECTURE.md)
- [Optional semantic-memory adapter contract](../SEMANTIC-MEMORY.md)
- [Public command contract](../COMMANDS.md)
- [#205 — governed candidate recall](https://github.com/vivary-dev/vivary/issues/205)
- [#207 — capability and Doctor wiring](https://github.com/vivary-dev/vivary/issues/207)
- [#217 — spec precedes implementation](https://github.com/vivary-dev/vivary/issues/217)
