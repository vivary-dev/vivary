# 03b: Execute the portable registry contract against a deterministic model
Type: packet
Parent: 03
Status: done
Depends-on: [03a, 10c]
Owner: registry implementation agent
Scope: Dependency-free reference evaluator and synthetic state-transition tests; no production registry or source import.
Verification-kind: runtime
Timebox: One context window; checkpoint after the evaluator and adversarial schedules are verified.
Evidence: [Model receipt](../receipts/03b-registry-contract-model.md)
Verification-result: passed

## Goal

Turn the reviewed registry rules into executable decisions and state assertions
without selecting a production database or claiming filesystem enforcement.

## Context

Read [the registry contract](../contracts/project-registry.md),
[its fixtures](../fixtures/project-registry.json), [03a](03a-project-registry-contract.md),
and the [actual 10c Habitat receipt](../receipts/10c-habitat-fallback-proof.md). The contract names the caller/adapter boundary,
validation order, every decision code, and permitted effects. The fixture inputs
are synthetic adapter observations, never caller authority assertions.

Preserve native action, session, connection, and task owners. The reference model
is verification tooling, not a production registry or a second service.

## Owned files

- Create `scripts/registry_contract_model.mjs`, exporting strict input validation,
  request digesting, decision evaluation, and an atomic in-memory transition model.
- Create `scripts/tests/test_registry_contract_model.mjs` with a fixture loader,
  exact output/record assertions, and contender/crash schedules.
- Create `docs/product/multi-project/receipts/03b-registry-contract-model.md`.
- Prepare packet 03c with exact existing native action/storage/root-adapter seams,
  implementation files, transaction requirements, and actual platform verification.

## Done condition

1. Every fixture produces its exact expected output, record changes, and allowed
   effects. Rejected operations leave all model state unchanged. No case-ID dispatch.
2. Strict parsing rejects duplicate keys, malformed JSON, invalid types, unsupported
   versions, unknown caller fields, invalid IDs/revisions, and unsafe relative paths.
   Export omits all injected local-state sentinels and round-trips portable content.
   Canonical request hashes cover Unicode labels and JSON control-character escapes.
3. Two requests with the same physical root and different operation IDs converge
   to one project/binding. A lost compare-and-set changes neither records nor receipt.
4. Two projects sharing a repository contend on the common key. Test both admission
   orders, disjoint repositories, overlapping no-VCS roots, an uncertain owner,
   stale fencing tokens, and a crash between intent and completion. No partial key
   acquisition, duplicate allocation, or presumed completion is accepted.
5. A repeated rebind returns only a still-current authorized result. Revocation,
   later relocation, missing records, changed request content, and an uncertain
   receipt produce their documented refusals without restoring old state.
6. Tests fail when deliberately changing the deduplication key to path text,
   dropping the common-repository key, exporting the whole trusted object, or
   accepting a stale fence. Record the observed failures and restored passing run.
7. The receipt names Habitat, tool versions, exact commands/results, and limits.
   Actual root detection, durable locks, process fencing, and file write-back remain
   unproved. Parent outcome 03 stays open until its production transaction mapping
   and owning adapter checks have evidence.

## Verify

Run inside the offline Habitat container established by 10c:

```console
node --test scripts/tests/test_registry_contract_model.mjs
node scripts/registry_contract_model.mjs --fixture docs/product/multi-project/fixtures/project-registry.json --check
```

The second command must be a read-only fixture evaluator. Its stdout reports
case IDs, decision matches, and aggregate status without raw local adapter facts.
Existing CI may provide additional regression coverage. CI is not evidence of the selected sandbox
configuration or BrowserPod compatibility. Authoring and inspection may proceed before boot, but this
runtime packet cannot close without the exact environment verification.

## Stop conditions

No real project mutations, database/provider selection, native CLI launch, copied
credentials, installation outside the verified pod, VCS initialization, source
import, or remote creation. If a fixture and rule disagree, repair the contract
and explain the affected case before changing the expected result. Do not make a
test pass by introducing case-specific behavior or bypassing authority checks.

## Log

- 2026-09-05: Prepared as 03a's executable successor. The selected BrowserPod toolchain is the named execution prerequisite. Production persistence and cross-process enforcement remain separate integration work.

- 2026-09-05: The owner authorized Habitat fallback; 10c passed its bounded toolchain probe. Claimed by the registry implementation agent for candidate model authoring, with sandbox execution and independent review owned by the integration agent. The 57 decisions remain unexecuted at this checkpoint.

- 2026-09-05: Completed reference-model verification in Habitat: 25 canonical tests, 57 exact fixture decisions, four deliberate CLI failures, and two independent regression probes. Independent review exposed and corrected authorization, parsing, collision, receipt, and revision-boundary gaps. Production enforcement remains unproved. Packet 03c maps native transactions; 02b is the lowest ready execution packet.
