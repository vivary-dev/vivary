# 03: Define project registry and authority contracts
Type: outcome
Status: in-progress
Blocked-by: [01]
Unlocks: [04, 05, 06, 07, 08, 12, 14, 18]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Define portable project identity, machine-local bindings, authority, idempotency, and serialization for a collection of independent project roots.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own the application contract under the proposed Vivary app package and canonical architecture docs named by `design.md`. Read `design.md`, `CONTEXT.md`, `evidence.md`, and the existing thin workspace schema in `packages/create-vivary/create_vivary.py`. Do not use the existing graph `project` type as an app registry.

## Done condition

Contract fixtures cover external roots, no-VCS folders, Git worktrees, monorepos, path moves, missing roots, duplicate registration, shared repository identity, and concurrent mutation ownership.

## Verify

Run contract tests that round-trip portable identity separately from local paths and secrets. Prove duplicate operations converge and shared repository mutations serialize.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Next packet

[03b](../packets/03b-registry-contract-model.md) completed executable reference-model verification in the authorized Habitat fallback. [03c](../packets/03c-registry-transaction-mapping.md) completed the native transaction and adapter mapping. [12a](../packets/12a-root-vcs-observation-contract.md) is ready to define the missing trusted root/VCS observation boundary. [03a](../receipts/03a-registry-contract.md) records the completed contract inspection. Production integration and full parent acceptance remain separate work.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.

- 2026-09-05: Packet 03a started contract inspection. Executable contract and serialization proof remain open.

- 2026-09-05: Inspection packet 03a completed the portable registry contract and synthetic acceptance oracle. [03b](../packets/03b-registry-contract-model.md) owns executable state/concurrency tests after the BrowserPod proof. Production transactions and adapter enforcement remain unproved.

- 2026-09-05: Packet 03b completed its sandboxed reference-model checks after independent QA corrections. Outcome 03 remains in progress: transaction mapping and owning production adapters still need evidence.

- 2026-09-05: Packet 03c completed source mapping and independent oracle tracing. Outcome 03 remains in progress: configured database transactions, strict JSON transport, trusted root identity, and enforceable filesystem boundaries still need implementation evidence.
