---
project: Vivary
status: active
module_area: canonical project registry
contract_refs: [registry-contract, registry-transactions]
source_refs: [registry-model-code]
test_refs: [registry-model-tests]
evidence_refs: [registry-receipt]
module_refs: [root-observation]
---

# Project registry

## Outcome ownership

Outcome 03 owns stable project identity, registry state, and transaction rules.

## Caller-visible contract and errors

Callers reconcile observed checkouts into canonical project and checkout identities.
The transaction map defines allowed state changes, conflicts, and retry behavior so
callers do not infer identity from a mutable path.

## Hidden concerns

The executable model owns transition validation, conflict detection, deterministic
results, and transaction examples. Storage layout and provider selection remain
behind the eventual registry boundary.

## Dependencies

Registry reconciliation consumes [root observations](../root-observation/index.md).
Its two contracts, executable model, focused tests, and accepted transaction receipt
are linked as typed graph edges.

## Gaps

The JavaScript model proves the contract but is not production registry storage.
No durable storage adapter is implemented or claimed here.
