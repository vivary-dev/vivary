# 11e: Preview and debug a running project with the agent
Type: packet
GitHub-issue: https://github.com/vivary-dev/Vivary-New/issues/31
Parent: 11
Status: done
Depends-on: [04a]
Owner: Root-assigned project preview and Native browser-tool integrator
Scope: Connect a project's running page and supported browser debugging to its existing agent session.
Verification-kind: runtime
Evidence: [Live preview verification](../receipts/11e-live-project-preview.md)
Verification-result: passed
Timebox: One real preview, inspect, repair, and refresh loop using existing browser owners.

## Goal

The linked GitHub issue owns task scope and acceptance. This packet records
implementation boundaries. Work with the agent while seeing and debugging the
site or dashboard being built in the selected project.

## Implementation

The Workbench preview uses the authenticated Native owner action
`vivary-project-preview` for discovery, exact command review, start, status,
inspection, and owned-process stop. The action binds caller, project, folder,
manifest, launcher, and preview address. It rejects changed reviews and
coalesces retries of the same start request.

The live iframe uses credentialless storage, a restricted sandbox, and a
separate origin. Vivary rejects same-origin preview addresses and sends
anti-framing headers. Generated HTML previews keep their existing opaque sandbox.
Host-local embedding requires confirmation for the exact project, host, and URL.

The preview attaches context to the existing Code composer without replacing its
draft or sending a turn. The selected coding runtime owns inspection and repair.
Native's Codex adapter now projects real `imageView` events as `view_image`
transcript records. It does not create image pixels absent from the protocol.

The [Workbench reference](../../../../packages/workbench/README.md#projects-and-conversations)
owns the controls and behavior. The [verification receipt](../receipts/11e-live-project-preview.md) records
normal-app isolation, the real agent repair loop, and remaining platform limits.

## Context

Read the live GitHub issue, [the release snapshot](../desktop-release.md), and
[Native ownership](../native-owners.md). Preserve the existing architecture and
accepted evidence while implementing the issue's current requirements.

## Owned files

- Existing Workbench BrowserPreview and project-bound preview state.
- Supported Native browser tools and deterministic action adapters, when needed.
- Existing project execution/process controls for a configured development command.
- Desktop browser integration only where the existing shared surface is insufficient.
- Existing preview and project-scope tests.

## Implementation boundaries

Bind the development process, preview address, and debugging results to the selected
host and project session. Starting a command requires the existing execution authority.
Templates and preview URLs grant no extra permission. Stop only owned processes.

Expose supported page inspection, screenshots, console errors, and useful failed
request details through the real agent tools. Keep unsupported operations explicit.
Preview content must remain isolated from privileged app APIs, Node access, and
credentials. Do not borrow a personal browser profile or its cookies.

The shared surface must work at narrow widths. Packet 23d owns phone-to-host
connection and authenticated preview routing. This packet can implement and verify
the preview on the existing authorized host before the phone connection is accepted.
Final acceptance combines both. Do not introduce a duplicate browser automation layer.

## Done condition

The issue's acceptance passes through the normal app: run a small existing project,
inspect a visible/browser-reported failure, make an authorized correction, and see
the corrected live preview. Results stay in the owning project session. Switching
projects, unavailable previews, blocked embedding, and process shutdown are usable.
A basic iframe or fabricated browser result does not complete this feature.

## Verify

Use a bounded existing web fixture and supported browser tools. Exercise the useful
repair loop plus the affected project, process, isolation, and responsive UI cases.
Repeat failed journeys after repair. Preserve the existing test runners and limits.

```console
pnpm --dir packages/workbench test:shell
pnpm --dir packages/workbench exec tsc --noEmit -p tsconfig.json
```

## Stop conditions

Do not expose a service, bypass authentication, copy personal browser credentials,
or enable paid or scheduled work through this ticket. Preserve existing user
files, private state and historical evidence. Unsupported browser capabilities
remain unaccepted until demonstrated through a supported interface.

## Log

- 2026-09-13: Added from Jeff's live website/dashboard preview and debugging request.
  Existing iframe source is established. Integrated agent debugging is unimplemented.

- 2026-09-22: Claimed issue #31 after PR #81 merged. Added reviewed process
  ownership, isolated module-capable preview, and project-scoped Code context.
  The integrated and focused review browser journeys passed. Codex/Astra captured
  the failure, repaired the fixture, and verified its page. Independent review
  fixes passed. Image viewing and packaged platform limits remain explicit.
