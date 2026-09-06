# 02b: Implement and execute the synthetic restoration harness
Type: packet
Parent: 02
Status: done
Depends-on: [02a, 10c]
Owner: Codex restore_model, sole code writer; coordinating Codex owns review and receipt
Scope: Synthetic restoration in one disposable Habitat container root; no real source import.
Verification-kind: runtime
Evidence: [Restoration receipt](../receipts/02b-restoration-fixture.md)
Timebox: One context window; at most 90 minutes, then checkpoint incomplete work.

## Goal

Implement the reviewed preservation contract and prove all synthetic cases by
executing real file operations inside the selected environment.

## Context

Read [the manifest contract](../contracts/source-preservation.md),
[its fixtures](../fixtures/source-preservation.json), [02a](02a-source-preservation-fixture.md),
and the [actual 10c Habitat receipt](../receipts/10c-habitat-fallback-proof.md). Retain ordinary repository testing conventions.
The fixture inputs are synthetic. Existing files to read are listed above;
the script and tests below are outputs to create.

## Owned files

- Create `scripts/prove_multi_project_source_preservation.mjs`.
- Create `scripts/tests/test_prove_multi_project_source_preservation.mjs`.
- Create `docs/product/multi-project/receipts/02b-restoration-fixture.md`.

## Done condition

Every fixture has an executable assertion. Real restore and repeated restore
produce the exact expected bytes; sources remain unchanged. Rejected fixtures
write nothing. Interruption cannot produce a completed receipt. A changed
partial target is refused. Tests must catch a deliberate wrong-hash mutation.
The receipt identifies Habitat, versions, commands, results, and limits.

## Verify

Run inside the offline Habitat container proved by 10c:

```console
node --test scripts/tests/test_prove_multi_project_source_preservation.mjs
node scripts/prove_multi_project_source_preservation.mjs --fixture docs/product/multi-project/fixtures/source-preservation.json --check
```

Create both commands in this packet. The second command verifies a disposable
fixture and emits results; it must not claim real-source preservation or write
to source checkouts. CI can add regression coverage, but the Habitat execution receipt
is required for this packet. Habitat does not prove BrowserPod compatibility.

## Stop conditions

No private source, live credentials, source publication, overwrite, or retirement.
Do not substitute a host filesystem for a failed container operation. Record
the failure and continue only independent in-scope work.

## Log

- 2026-09-05: Prepared as 02a's executable successor. Source preservation and licenses remain open after fixture success.

- 2026-09-05: The owner authorized Habitat fallback and 10c passed the Node/fs/crypto probe. This packet is ready after the current 03b continuation; restore behavior must still be proved by its own real filesystem tests.

- 2026-09-05: Claimed after the owner requested implementation. The code writer owns the two scripts; the coordinator owns Habitat execution, independent review, receipt, and next packet.

- 2026-09-05: Completed in offline Habitat after independent QA corrections: 14 canonical tests, all 33 real-filesystem cases, 10 independent checks, and deliberate CLI failures. Parent outcome 02 remains open for selected real-source provenance, rights, history, and restore evidence. Packet 03c is the next ready task. BrowserPod is unavailable under the owner's latest answer.
