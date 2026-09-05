# 02a: Define the preservation manifest and restore acceptance fixtures
Type: packet
Parent: 02
Status: in-progress
Depends-on: []
Owner: integration agent
Scope: Synthetic manifest and restore test cases; no real source import or deletion.
Verification-kind: inspection
Timebox: One context window; end after the manifest and failure cases are reviewed.

## Goal

Give the preservation implementation a precise manifest and adversarial test
oracle without waiting for permission to publish private source.

## Context

Read [the preservation map](../migration.md), [source boundaries](../receipts/01-migration-boundaries.md),
and the preservation requirements in `CONTRIBUTING.md`. The original working
copies remain authoritative until a later restore proof and import decision.
This packet uses synthetic data, with no real private paths or credentials.

## Owned files

- Create `docs/product/multi-project/contracts/source-preservation.md`.
- Create `docs/product/multi-project/fixtures/source-preservation.json`.
- Create `docs/product/multi-project/receipts/02a-preservation-contract.md`.
- Prepare packet 02b for the executable restore harness in BrowserPod.

## Done condition

1. The manifest records selected relative paths, byte hashes, source class,
   history/attribution method, dirty-file classification, license disposition,
   owner, and destination policy. Private coordinates stay in private evidence.
2. Expected cases cover successful restoration, unchanged source, repeated
   operation, missing source, wrong hash, duplicate destination, path traversal,
   symlink escape, case collision, and a changed destination.
3. Distinguish tracked history, dirty tracked files, untracked files, ignored
   user-authored resources, hosted issues/assets, and runtime state. A Git bundle
   alone cannot claim to preserve all of them.
4. Define interruption recovery and the no-overwrite rule before implementation.
5. A second reader traces every expected result to a manifest rule. The receipt
   states that restoration and source preservation remain unproved.

## Verify

Review each synthetic case against the manifest and `CONTRIBUTING.md`. Check
paths and privacy through the documentation guard in CI. Packet 02b must later
execute byte comparisons inside BrowserPod; this packet cannot satisfy that
behavioral requirement or close outcome 02.

```console
git diff --check
git diff -- docs/product/multi-project/contracts/source-preservation.md docs/product/multi-project/fixtures/source-preservation.json
gh pr checks 328 --repo vivary-dev/vivary
```

## Stop conditions

No real-source publication, import, history rewrite, overwrite, or retirement.
Do not block synthetic fixture work on a later license or account decision.
Name those limits in the receipt and prepare the executable successor.

## Log

- 2026-09-05: Prepared as independent source-preservation contract work. Planned output files are deliverables. Actual restoration and imported-source licenses remain outcome 02 acceptance work.

- 2026-09-05: Integration agent claimed this first independent packet and created the manifest contract and 13 synthetic acceptance cases. Second-reader review and CI are pending. Outcome 02 remains incomplete.
