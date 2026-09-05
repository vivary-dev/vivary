# 10b: Prove the first BrowserPod toolchain on a disposable fixture
Type: packet
Parent: 10
Status: needs-info
Depends-on: [10a]
Owner: runtime integration agent
Scope: One BrowserPod session and a synthetic fixture; no product-source import.
Verification-kind: runtime
Timebox: One context window and one pod session; checkpoint without repeated boots.
Needs: A usable user-scoped BrowserPod connection on an approved probe origin, obtained through the existing connection workflow. Do not ask for a key in chat or copy host credentials.

## Goal

Produce direct BrowserPod evidence for file operations, process execution,
dependency installation, preview, cancellation, and persistent reopening.

## Context

Read [10a's evidence](../receipts/10a-browserpod-preflight.md), the current
[boot API](https://browserpod.io/docs/reference/BrowserPod/boot), and the
[native dependency guide](https://browserpod.io/docs/guides/working-around-native-npm-dependencies).
Retain the exact Core version and source manifest from the preflight.

Prepare the probe source and fixtures while the connection is missing. Only the
actual boot and usage require the connection. Do not install or execute anything
in Habitat or WSL. Existing repository CI checks are regression evidence, not
BrowserPod acceptance.

## Owned files

- Create `experiments/browserpod-proof/README.md`, `package.json`, and `src/probe.mjs`.
- Create `experiments/browserpod-proof/fixtures/roundtrip.mjs` and `expected.json`.
- Create `docs/product/multi-project/receipts/10b-browserpod-toolchain.md`.
- Select and record the SDK's exact version from official metadata before dependency installation. These paths are deliverables, not pre-existing prerequisites.

## Done condition

1. One actual pod writes, reads, and removes its own synthetic file; the exported
   receipt contains hashes and no credentials.
2. Record `node --version`, `npm --version`, `git --version`, `python3 --version`,
   and `pnpm --version`, including unavailable tools. An unavailable required
   tool keeps the affected capability unresolved.
3. Run a pinned pure-JS fixture with an assertion that fails on wrong output.
   Probe required native dependencies individually; retain exact failures.
4. Start one preview through the supported portal, verify the served fixture,
   cancel the process, and verify that the process and preview stop.
5. Reopen using the same scoped storage key and recover the expected file. A
   different synthetic identity cannot select that key through the app bridge.
6. Produce a go/no-go table for each capability. Do not mark the whole native
   runtime or app runnable after only the pure-JS fixture passes.

## Verify

Run these inside BrowserPod only after the connection is ready:

```console
node --version
npm --version
git --version
python3 --version
pnpm --version
node fixtures/roundtrip.mjs
```

The fixture must exit nonzero for mismatched readback or output. Inspect the
portal in the browser, stop it, reload, and compare exported evidence. Record
the actual selected origin, SDK version, observed commands, and account usage
privately; publish only sanitized facts. Runtime/model probes follow as separate
bounded packets once the required tools pass.

## Stop conditions

No payment, new account, allowance increase, credential transfer, global header
change, or replacement environment. If the approved connection cannot boot,
record the exact failure and leave this packet open. Continue 02a/03a and probe
source preparation. Stop after one session's checks; do not churn pod boots.

## Log

- 2026-09-05: Prepared from primary BrowserPod docs and current source observations. The user-scoped connection has not been verified. No commands above have been run in BrowserPod.
