---
project: Vivary
status: active
module_area: bounded checkout observation
contract_refs: [root-observation-contract]
source_refs: [checkout-observer-code]
test_refs: [checkout-observer-tests]
evidence_refs: [observation-receipt]
---

# Root observation

## Outcome ownership

Outcome [12](../../../tickets/12-implement-vcs-identity-adapters.md) owns VCS
observation and mutation-owner adapters. Packet 12a established this bounded
observer contract and its continuation guidance.

## Caller-visible contract and errors

Given an explicit allowlist of roots, observation returns normalized checkout facts
and preserves per-root failures as observations. A caller can distinguish an absent,
inaccessible, invalid, or non-repository root without losing successful siblings.

## Hidden concerns

Core owns bounded path normalization, Git topology probing, stable ordering, and
error capture. Its existing graph identities derive from paths and topology; they do
not satisfy 12a's trusted directory-incarnation identity or mutation reservation.

## Dependencies

This module supplies observed identities to the [project registry](../project-registry/index.md).
Its contract, Core implementation, focused tests, and accepted receipt are linked as
typed graph edges.

## Gaps

The current Core observer accepts configured roots, but it does not implement the
trusted physical-root and VCS observation contract required for mutation admission.
That adapter remains proposed and absent, including for explicitly configured roots.
