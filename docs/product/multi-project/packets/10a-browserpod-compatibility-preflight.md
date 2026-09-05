# 10a: Establish the BrowserPod compatibility boundary
Type: packet
Parent: 10
Status: done
Depends-on: []
Owner: integration agent
Scope: Source and primary-document inspection; no pod boot or model call.
Verification-kind: inspection
Timebox: One context window; end with the reviewed capability boundary.
Evidence: [Preflight receipt](../receipts/10a-browserpod-preflight.md)

## Goal

Identify the exact prerequisites and incompatible assumptions before any application import or execution adapter is committed.

## Context

Read [the execution decision](../design.md#execution-decision-2026-09-05),
[source boundaries](../receipts/01-migration-boundaries.md), and the current
BrowserPod API and native-dependency guidance linked in the receipt below.
Inspect the preserved Littleagent `apps/workbench/package.json`,
`apps/workbench/server/agent-runtime-host.ts`, its host tests, and root lockfile.
Do not copy private credentials or source into this public receipt.

This packet is independent of source import and registry implementation. It
does not complete outcome 10 or prove that any runtime runs in BrowserPod.

## Owned files

- Create `docs/product/multi-project/receipts/10a-browserpod-preflight.md`.
- Update this packet and the graph with evidence and the next executable unit.
- Prepare `packets/10b-browserpod-toolchain-proof.md` with precise live checks.

## Done condition

1. The receipt separates documented capability, source observations, inference,
   configured connection, and observed execution.
2. It classifies native dependencies, Python CLI availability, BrowserPod
   persistence, authentication, and cross-origin requirements without inventing
   a replacement for an incompatible dependency.
3. It records the existing native state owners and the missing BrowserPod bridge.
4. The next packet names the smallest actual connection prerequisite and does
   not block independent contracts, source preservation, or UI preparation.

## Verify

Open every primary source link, compare the dependency rows with the selected
source manifest, and have a second reader verify the inference labels. Run the
repository documentation guard through CI. Check that there is no pod/model
execution receipt and that the packet does not claim one.

```console
git diff --check
gh pr checks 328 --repo vivary-dev/vivary
```

## Stop conditions

Stop before booting a pod, enrolling an account, copying credentials, changing
dependencies, or selecting an alternate execution environment. A live connection
belongs to 10b. Finish the read-only receipt even when that connection is missing.

## Log

- 2026-09-05: Integration agent claimed this independent preflight while repairing the planning frontier. Official BrowserPod guidance and preserved package manifests are being checked. No execution environment was started.

- 2026-09-05: Source and primary-document inspection completed. A second scope reviewer confirmed the native-dependency and persistence risks. The receipt separates documented, observed, and unproved facts. No pod or model run occurred; 10b owns live verification.
