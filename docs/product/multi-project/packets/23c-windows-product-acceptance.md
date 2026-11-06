# 23c: Deliver and accept the desktop and self-hosted web product
Type: packet
GitHub-issue: https://github.com/vivary-dev/Vivary-New/issues/23
Parent: 23
Status: needs-info
Depends-on: [06g, 06h, 04b, 04c, 17a, 18a, 07c, 08a, 11a, 11c, 09b, 09c, 23b, 23d, 11e]
Owner: Coordinating Codex, release integrator with an independent source reviewer
Scope: Prove the complete Windows artifact and responsive self-hosted browser product journeys.
Verification-kind: runtime
Needs: Every named dependency accepted, current hosted behavior exercised, and the matching Windows candidate prepared.
Timebox: One release-candidate acceptance pass. Repair only concrete failures in their owning slices.

## Goal

Deliver a versioned distributable containing Vivary.exe and its required siblings,
with checksums and licenses, that completes the Windows journey, plus the
responsive browser journey against the same selected self-hosted instance.

## Context

Read [the desktop release target](../desktop-release.md),
[ENGINEERING.md](../../../../ENGINEERING.md), and [desktop packaging](../../../../packages/desktop/README.md).
The executable may require sibling resources. This packet does not promise a single-file app.
Use existing owners. Build/help success alone is insufficient. Signing and publication need separate authority.

## Owned files

- `packages/desktop/package.json`, `package.mjs`, `windows-target.mjs`, and release instructions.
- Release version/source metadata and artifact checksums/licenses under the existing packaging owner.
- Owning tests for accepted Workbench, creator, Tropo and original-router behavior.
- This packet's acceptance record and outcome 23 release status. Fixes return to their source owners.

## Done condition

A versioned archive or installer includes Vivary.exe, required runtimes/resources,
licenses, checksum and exact source version. It excludes credentials and live user data.
Windows launch requires no Vivary account, Zo account, source tree or first-run dependency download.
Create a project, adopt an existing folder, choose built-in patterns and edit a source file.
Use existing conversation types within one project workspace, preserving Native
thread and coding-session identities with project-organized history. Find an old session by message content.
Record a sourced fact, restart, recall it in a fresh chat, correct it and remove it from active memory.
Search a large codebase, open a match and verify private exclusions and project isolation.
Provider sessions/log references stay outside project files. Drafts and chats survive restart.
Exercise create, adopt, doctor, capabilities, find, check, decide, review, impact and
control through their agreed GUI/agent flows and bundled CLI against the same project fixtures.
Stop active work, reopen and handle a missing folder without losing other projects. Failures block acceptance.

## Verify

Run affected existing suites on the exact release source, then build/package once
and perform the full Windows journey with that artifact after its hosted check.
Use only approved provider accounts and existing model budgets. Retain concise
results, useful screenshots and failures. Do not construct another proof framework.

```console
pnpm --dir packages/workbench build
npm --prefix packages/desktop run package -- --windows-x64
python3 -B packages/vivary/tests/test_command_surface_characterization.py
```

## Stop conditions

Do not label an incomplete candidate finished, hide skipped journeys, alter legacy
evidence, or publish/sign without the specific authority. Preserve user files and credentials.

## Log

- 2026-09-16: The private `26798df` Windows candidate passed focused extraction, launch, bundled-runtime, project, file, Claude Code, restart, second-instance, and cleanup checks. See the [desktop acceptance register](../desktop-acceptance-status.md). This does not close the live issue or establish public release readiness.
- 2026-09-18: Local candidate `43ae417` (merged dev after PR #66, not published) passed first launch, existing-folder registration, the 09a project-health step with output identical to headless Doctor, narrow layout at the 488 px frame floor, a real Claude Code tool turn, Stop from another project, restart persistence, second-instance reuse, and shutdown cleanup on the laptop. Approval and denial were not rerun on it; last proven on `98515c9` with Codex Normal mode. See the [desktop acceptance register](../desktop-acceptance-status.md). Issue #68 records the folder-picker timeout message.

- 2026-09-13: Drafted. No current artifact satisfies the complete Windows release target.

## Shared desktop and web behavior

Complete the real Windows artifact journey and the responsive browser journey, including a real phone connected to the selected private host. The integrated live project preview and supported agent debugging tools must work in the same project session. Keep platform results separate and preserve every original Windows acceptance requirement. Mac distribution is later work.
