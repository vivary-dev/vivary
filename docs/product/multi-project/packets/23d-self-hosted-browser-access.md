# 23d: Connect a responsive browser to a self-hosted Vivary instance
Type: packet
GitHub-issue: https://github.com/vivary-dev/Vivary-New/issues/30
Parent: 23
Status: ready-for-human
Depends-on: [06g, 04a, 17a]
Owner: Root-assigned shared client and host-access integrator
Scope: Connect desktop and phone browsers to one explicitly selected user-controlled Vivary host.
Verification-kind: runtime
Needs: Owner review and authorization for source delivery, merge and issue closure. Human Entire trail approval before merge.
Timebox: One host connection and responsive-client increment using existing Native owners.

## Goal

The linked GitHub issue owns task scope and acceptance. This packet identifies
implementation boundaries and evidence. Open the same project and conversation
from a phone browser while agents and files remain on the selected host.

## Context

Read the live GitHub issue, [the release snapshot](../desktop-release.md), and
[Native ownership](../native-owners.md). Preserve the existing architecture and
accepted evidence while implementing the issue's current requirements.

## Owned files

- Existing Workbench shell, project/session navigation, composer, and settings.
- Existing startup and local-access owners only for the explicit remote access mode.
- Existing Native session/state/action adapters and focused tests.
- Host setup instructions and the accepted connection's browser-facing routes.

## Implementation boundaries

Local desktop remains account-free and loopback-only by default. Remote browser
access is explicit, authenticated, and revocable. Preserve the private Zo owner
boundary. Do not treat this feature request as permission to expose a live service.
Use one host identity and its existing Native records. Agents, provider credentials,
files, logs, and history remain there. Browser folder selection refers to that host,
not the phone. No managed cloud account, native phone app, or second sync store.

The shared shell must work with touch, a narrow viewport, and an on-screen keyboard.
Keep project identity, composer, Stop, history, settings, and errors reachable.
Reconnection must preserve drafts without automatically sending or changing hosts.
Resolve live-preview links through this selected host's authenticated access path.
A loopback address on the host must not accidentally target the phone.

## Done condition

The live issue's acceptance passes against the actual selected private instance.
A desktop browser and real phone browser open and continue the same authorized
project conversation. Revoked and unauthenticated clients cannot read records or
invoke actions. Unavailable-host and interrupted-connection states recover honestly.

## Verify

Use existing tests for access and state boundaries. Exercise the real shared UI
at desktop and phone widths, then the actual phone connection, without creating
another browser test framework. Keep desktop artifact acceptance separate.

```console
pnpm --dir packages/workbench exec tsx --test tests/local-access.test.ts
pnpm --dir packages/workbench typecheck
```

## Stop conditions

Do not expose a service, bypass authentication, copy personal browser credentials,
or enable paid or scheduled work through this ticket. Preserve existing user
files, private state and historical evidence. Unsupported browser capabilities
remain unaccepted until demonstrated through a supported interface.

## Log

- 2026-09-13: Added from Jeff's explicit self-hosted mobile-browser requirement.
  The first host is a user-controlled computer. A suitable Linux server can use
  the same client contract. No remote service was exposed or tested by this plan.

### First source slice, 2026-09-30

The desktop adds optional device pairing through a dedicated loopback ingress and
local IPC approval. Grants and explicit configuration persist across restart. The
outer admission boundary protects Native authentication, and revocation ends the
device's responses without ending unrelated host work. Settings and connection UI
identify the host and expose failure/retry states. The Workbench README owns setup
and focused test commands. This is source implementation, not full issue acceptance.
Protected transport setup, isolated remote previews, an exact Windows package and
the actual phone journey remain outstanding.

### Isolated preview source candidate

The next source slice adds embedded-only remote preview through a separate HTTPS
port and loopback listener. It retains existing project command review/start/stop
and requires a verified owned connection, a preview-only grant and credentialless
framing. One preview identity per app document requires a guarded real refresh
for another project or launch. Unknown socket ownership and unsupported browsers
remain denied. Transport stays off until explicitly configured. Focused source
checks do not establish Windows, actual-phone or live transport acceptance.

### Candidate acceptance update, September 30

The earlier source entries remain historical. GitHub issue #30 remains open and
owns current acceptance and delivery. This update records the demonstrated gates
for each named candidate, without claiming a full #23 desktop release.

The unpublished `0c552b88` Windows candidate passed core Windows and physical
Android access over approved private HTTPS. Pairing, two-project selection,
refresh, host restart, keyboard and Send passed. An authorized Codex CLI file-tool
turn ran on the selected host. Work continued during a connection outage. An
unsent draft survived without a run or transcript change. Revocation denied access
after refresh while the host remained reachable.

`efcc6fc7` corrected access-ended and network-failure messages. Component and real
HTTPS Chromium checks passed. Windows startup restored the project, conversation
and draft. Corrected physical-phone wording was not separately reported.

The unpublished `4d565337` package passed local preview review, start, JavaScript,
live updates and Stop with process and listener cleanup. The owner reported both
projects' phone previews and draft preservation after project-switch refresh.
Host inspection independently identified the second project's preview. Revocation
stopped phone live updates. Desktop state and host inspection confirmed revocation.
The final phone screen after refresh was not reported. `73debced` passed affected
startup and local preview checks after the wording correction.

Seventeen real HTTPS Chromium checks passed at `357695f7`, covering navigation,
storage isolation, credential stripping, drafts, project selection, stream
termination and sizing. Actual BFCache was not reached. The persisted-event guard
was simulated. Twelve built-app UI checks passed at `ce5abf7a`, covering pointer
and keyboard resizing, full-page state, narrow viewports and visible Stop failures
with setup scrolled. Its Windows replay passed those affected interactions.

One initial `ce5abf7a` run lost its backend and left the preview process alive.
The surviving process was stopped. The cause remains unknown. A temporary
diagnostic replay and dependency-free comparisons did not reproduce a native
crash. Diagnostic output remains separate from source and package acceptance.

Clean `12a013af` pins Node 24.19.0, retains ABI 137 and the existing SQLite asset,
and preserves exact build-marker validation. Tagged Node source includes the
[upstream Windows initialization fix](https://github.com/libuv/libuv/commit/aabb7651de).
It addresses that known defect independently of the unattributed Vivary crash.
Its matching Zo build, admission check and Windows packaging passed. Bundled Node
matched its official checksum. Windows native SQLite loading passed with Node
24.19.0, ABI 137 and SQLite 3.53.2. The Windows app ran for more than fifteen
minutes, with its fixture running for more than eleven, without a backend crash.
Resizing, Full page and return retained the counter and live updates. A later
unattributed page reload prevents a continuous-state claim for the entire run.
UI Stop and normal File menu Exit removed owned processes and listeners. Its
grip appearance and outer workspace scrolling were rejected.

The unpublished `ca3281a9` candidate uses a 3px by 28px vertical grip and a 1px
divider within a 14px transparent pointer target across Details, Files, Search
and Preview. Pointer and keyboard resizing retain their existing owner. Project
details now contains absolute screen-reader labels within its own scrolling
region. Three actual-browser viewport checks at 1785 by 930, 1440 by 744 and
390 by 600 kept the main area's client and scroll heights equal. Focusing the
bottom Details control scrolled Details without moving the header or outer
panels. All four work-panel grip geometries and twelve preview UI checks passed.
The checks cover iframe state, full-page entry and return, narrow layouts,
visible Stop failures and successful Stop. These are simulated viewports.

Windows testing of `ca3281a9` found that Full page and Back restored the last
pointer width instead of a later keyboard resize. Counter and live updates
survived. The `77282275` replacement saves the authoritative callback layout
while retaining guards against programmatic, full-page and narrow-layout sizing.
Its built-browser check restored the keyboard-selected pane width exactly,
including its ARIA value. Saved width survived narrow layouts and desktop return.
The same twelve UI checks and three containment checks passed on the replacement.

`77282275` rebuilt Workbench with verified Node 24.19.0 and passed built-app
admission and Windows packaging. Archive SHA-256 is
`e4acad051ea96c708f39726b86f053d0677b06bfaf7932351a6453f34fed1f8f`.
ZIP CRC, official Node and pinned SQLite hashes, and source manifests passed.
Native Windows testing independently matched the candidate and archive checksum.
The shared divider styling is unchanged from `ca3281a9`. Native checks confirmed
the slim divider and contained workspace. A keyboard resize
changed the separator value from 56.058 to 51.058. Full page and Back restored
51.058 exactly. Native before-and-after images showed the same divider position.
Counter 1 remained intact while live updates advanced through both transitions.
The images remain private and are not part of this source documentation.

Fresh Zo CI at `ca3281a9`, running the existing sequential runtime command under
isolated Node 24.19.0, passed 455 tests with one existing legacy-Codex-flags skip.
Credential redaction passed 36 tests and browser access passed 18. The replacement
changes only resize preference state and its design review. Its affected type
checking, 36 shell tests, 16 site tests and HLDD checks passed. The full runtime CI
counts retain their `ca3281a9` attribution. Earlier checks retain their recorded
commits. Zo results remain separate from unrun GitHub Actions.

Windows metadata retains `workbenchOutput.sourceCommitVerified=false` alongside
separate clean-build records. Earlier feature commits retain their recorded
Entire evidence. Later controller-applied changes have no new local
agent checkpoint claim. Human Entire trail approval remains required before merge.

The selected Windows and Android checks do not establish every browser,
separate Linux-server installation, macOS preview or full #23 release acceptance.
Corrected phone denial wording after the final preview refresh was not reported.
UI Stop removed the owned fixture process and listener. Normal desktop titlebar
close then removed all candidate processes and task listeners. Cleanup after an
already-exited launcher remains separately untested.
Public delivery, merge and issue closure remain owner decisions.
