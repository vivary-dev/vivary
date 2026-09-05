# 02b: Implement and execute the synthetic restoration harness
Type: packet
Parent: 02
Status: needs-info
Depends-on: [02a, 10b]
Owner: source preservation implementation agent
Scope: Synthetic restoration in one disposable BrowserPod root; no real source import.
Verification-kind: runtime
Timebox: One context window; at most 90 minutes, then checkpoint incomplete work.
Needs: Packet 10b must verify the user-scoped BrowserPod connection and Node filesystem/toolchain behavior. The integration owner must attach that receipt before execution.

## Goal

Implement the reviewed preservation contract and prove all synthetic cases by
executing real file operations inside the selected environment.

## Context

Read [the manifest contract](../contracts/source-preservation.md),
[its fixtures](../fixtures/source-preservation.json), [02a](02a-source-preservation-fixture.md),
and the actual 10b receipt. Retain ordinary repository testing conventions.
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
The receipt identifies BrowserPod, versions, commands, results, and limits.

## Verify

Run inside BrowserPod:

```console
node --test scripts/tests/test_prove_multi_project_source_preservation.mjs
node scripts/prove_multi_project_source_preservation.mjs --fixture docs/product/multi-project/fixtures/source-preservation.json --check
```

Create both commands in this packet. The second command verifies a disposable
fixture and emits results; it must not claim real-source preservation or write
to source checkouts. CI can add regression coverage, but the BrowserPod receipt
is required for this environment-dependent behavior.

## Stop conditions

No private source, live credentials, source publication, overwrite, or retirement.
Do not substitute a host filesystem for a failed BrowserPod operation. Record
the failure and continue only independent in-scope work.

## Log

- 2026-09-05: Prepared as 02a's executable successor. Source preservation and licenses remain open after fixture success.
