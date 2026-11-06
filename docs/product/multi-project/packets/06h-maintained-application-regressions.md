# 06h: Make the maintained application regression checks reliable
Type: packet
GitHub-issue: https://github.com/vivary-dev/Vivary-New/issues/22
Parent: 06
Status: done
Depends-on: [03c]
Owner: Coordinating Codex, sole existing-test maintenance writer
Scope: Correct named obsolete fixture assumptions and environment setup in the maintained application checks.
Verification-kind: runtime
Evidence: [Maintained regression checks verification](../receipts/06h-maintained-application-regressions.md)
Verification-result: passed
Timebox: One focused test-maintenance change with no new proof framework.

## Goal

Run the application's supported regression checks with meaningful failures,
without depending on retired proof scratch or a particular agent's machine.

## Context

Read [the desktop target](../desktop-release.md) and the precise failures in
[the salvage receipt](../receipts/salvage-handoff-2026-09-12.md).
CI passes but the broad Zo run did not. Keep those statements distinct.
The temporary runner omitted the two mutation suites' heap arguments. A GUI
fixture references retired scratch. Registry metadata assumes no actions folder.
Core permission fixtures and creator timestamp failures need separate diagnosis.

## Owned files

- Existing Workbench tests, package scripts, and their small shared setup helpers.
- Creator legacy Doctor snapshot tests only for a reproduced timestamp issue.
- Core permission fixtures only for a supported non-root test environment.

## Done condition

Every maintained check has a documented ordinary command and cleans up its
children. Correct the metadata assertion to inspect the private registry actions,
not the absence of unrelated app actions. Supply existing required test options.
Historical proof-only tests stay reachable as history and leave the product
regression command through an explicit source disposition.
Permission tests run where permissions are enforced. Unsupported environments
are identified without changing refusal behavior or masking product failures.

## Verify

Run the affected existing suites after each correction. Preserve original logs.
Run the final maintained command once in its supported environment. Do not replay
old C5 campaigns or make all historical experiments part of every feature test.

```console
pnpm --dir packages/workbench test:registry-actions
pnpm --dir packages/workbench test:registry
pnpm --dir packages/workbench test:shell
git diff --check
```

## Stop conditions

Do not weaken filesystem, privacy, or authorization assertions to make a host
pass. A test removal needs a named obsolete assumption and replacement coverage.
Do not build a new verifier, evidence archive system, or test runner product.

## Log

- 2026-09-13: Converted named recovery-test failures into bounded maintenance.
  Existing application checks and historical evidence remain unchanged.
- 2026-09-18: Corrected the registry-actions metadata assertion, the stale
  project-services gate expectation, the chat-title bootstrap teardown, and
  the Doctor snapshot timestamp settle; supplied default proof roots and the
  Core manifest; identified root and noexec hosts in the Core permission
  proofs; documented `pnpm test:maintained`.
- 2026-09-18 source disposition: `packages/workbench/tests/gui-zo-runner.test.mjs`
  removed. Obsolete assumption: it statically imported
  `docs/product/multi-project/fixtures/05b/gui_zo_runner.mjs`, deleted with the
  05b Zo GUI-proof harness in the 2026-09-12 salvage, so the file failed at
  load and no case ran. What it asserted (proof-token authorization, read-only
  mount verification, source manifest validation, owned-child cleanup) were
  contracts of that retired harness, not of product code. Replacement
  coverage for the product behavior it drove: the title route in
  `tests/chat-title.test.mjs`; worker-child cleanup in the maintained registry
  and mutation suites; history and navigation in the real-application
  journeys. The harness and test remain readable on
  `salvage/handoff-2026-09-12`.
- 2026-09-18: Accepted by Jeff after end-to-end verification of merged dev;
  evidence in the linked receipt.

## Shared desktop and web behavior

Use the existing runners for focused shared-UI checks at desktop and phone widths. Add connection interruption cases only where behavior is affected. Keep one heavy runtime job at a time and avoid another verification framework.
