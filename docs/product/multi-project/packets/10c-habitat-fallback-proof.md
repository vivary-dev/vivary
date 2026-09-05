# 10c: Prove the authorized Habitat fallback toolchain
Type: packet
Parent: 10
Status: done
Depends-on: [10a]
Owner: integration agent
Scope: One offline disposable Node toolchain probe; no app import or coding-runtime call.
Verification-kind: runtime
Timebox: One bounded probe and cleanup checkpoint.
Evidence: [Habitat receipt](../receipts/10c-habitat-fallback-proof.md)

## Goal

Establish the exact Node capabilities available for 03b after the owner authorized
Habitat fallback. Keep the BrowserPod-specific 10b proof open.

## Context

Read [the dated authority](../design.md#execution-decision-2026-09-05),
[10a](10a-browserpod-compatibility-preflight.md), and
[03b](03b-registry-contract-model.md). The fallback uses the existing image
without installing dependencies or transferring credentials.

## Owned files

- This packet and `receipts/10c-habitat-fallback-proof.md`.
- Update 03b's actual environment prerequisite and regenerate the graph.

## Done condition

Observe non-root Node, node:test, synthetic fixture reads, temporary file
round-trip, and SHA-256. Inspect the actual container restrictions and record
failed attempts and their correction. Do not treat loading 57 fixture records
as running 57 model tests.

## Verify

Create the probe from the receipt in the disposable container, then run:

```console
node --test /tmp/habitat-toolchain-proof.mjs
```

Run the receipt's probe inside the bounded Habitat container. Inspect its
configuration for disabled network, no host mounts, read-only root, dropped
capabilities, no-new-privileges, and explicit CPU/memory/process limits.

## Stop conditions

No installs, network, authentication transfer, real source/project mutation,
native coding-agent calls, or paid work. Stop only the task-owned container and
keepalive after the current verification session; preserve existing volumes.

## Log

- 2026-09-05: One toolchain test passed on Node v22.23.2 in the authorized Habitat fallback. The receipt records the limits. Packet 03b can use this environment; native runtime and BrowserPod proofs remain open.
