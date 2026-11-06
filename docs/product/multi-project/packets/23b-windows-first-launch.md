# 23b: Make the packaged application start on Windows
Type: packet
GitHub-issue: https://github.com/vivary-dev/Vivary-New/issues/8
Parent: 23
Status: done
Depends-on: [23a]
Owner: Root-assigned Windows desktop integration owner
Scope: Validate and fix first launch, local dependencies, provider setup and shutdown on Windows.
Verification-kind: runtime
Evidence: [Windows desktop first-launch verification](../receipts/23b-windows-desktop-acceptance.md)
Verification-result: passed
Timebox: One Windows first-launch increment after the hosted application check.

## Goal

Extract the Windows package, open Vivary.exe from Explorer, connect a
folder and use a configured coding runtime without installing the app's dependencies.

## Context

Read [the desktop release target](../desktop-release.md),
[ENGINEERING.md](../../../../ENGINEERING.md), and [desktop packaging](../../../../packages/desktop/README.md).
The unpublished `df4aedc` Windows candidate passed a fresh application-profile
launch under the existing Windows account, bundled-runtime use, missing-CLI
and login guidance, native Unicode folder selection, reviewed existing-folder
setup, real Codex/Astra file tools, project preview, second-instance reuse,
Stop, restart, and idle and active shutdown. See the
[desktop acceptance register](../desktop-acceptance-status.md) and the
[Windows receipt](../receipts/23b-windows-desktop-acceptance.md).
Earlier Explorer extraction and launch checks remain evidence for their named
candidates. This candidate
is not the public prerelease, and the full product journey remains under #23.

## Owned files

- `packages/desktop/main.mjs`, `package.mjs`, `windows-target.mjs`, and README.
- `packages/workbench/bin/start.mjs`, `desktop-server.mjs`, and `server/desktop-host.ts`.
- `packages/workbench/server/local-runtime-setup.ts` and native setup UI only as needed.
- Existing desktop `main.test.mjs`, Workbench `startup.test.mjs`, `desktop-host.test.ts` and runtime tests.

## Done condition

A clean Windows profile opens the packaged executable with required siblings intact.
Bundled Node/Python/native modules work without global Node, Python or a source checkout.
Vivary opens without signup. Missing model CLIs or login show accurate setup guidance.
Folder selection works with spaces and Unicode, and files resolve to the selected project.
One authorized model request shows real tool output through the normal packaged UI.
A second application launch preserves the existing instance and its data.
Closing during idle and active work stops owned children while preserving files and history.
Unexpected Open With prompts are launcher defects. Do not change file associations.

## Verify

Use Explorer launch and the real system folder dialog on Windows after hosted checks.
Inspect local app data and provider setup, run one bounded authorized file-tool turn,
close/reopen and confirm port release and child cleanup. Use existing model limits.
Run relevant existing tests on the target platform. Record failures separately from build success.

```console
node --test packages/desktop/tests/main.test.mjs
node --test packages/workbench/tests/startup.test.mjs
pnpm --dir packages/workbench typecheck
```

## Stop conditions

Do not disable Defender, add exclusions, alter file associations, bundle provider
credentials, or claim Windows support from a Linux cross-build. Signing and publication are separate.

## Log

- 2026-09-23: The `df4aedc` package completed the current Windows first-launch
  journey with fresh same-account application data. The receipt separates actual
  packaged behavior from Zo source checks and earlier Explorer evidence.
  Independent review accepted this candidate. Issues #14, #15, and #23 retain
  their separate acceptance.

- 2026-09-16: The private `26798df` Windows candidate passed focused extraction, launch, bundled-runtime, project, file, Claude Code, restart, second-instance, and cleanup checks. See the [desktop acceptance register](../desktop-acceptance-status.md). This does not close the live issue or establish public release readiness.

- 2026-09-13: Drafted. The existing Windows portable artifact has no accepted runtime journey.
