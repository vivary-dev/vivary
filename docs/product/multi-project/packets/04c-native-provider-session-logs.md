# 04c: Retain provider sessions outside project folders
Type: packet
GitHub-issue: https://github.com/vivary-dev/Vivary-New/issues/10
Parent: 04
Status: needs-info
Depends-on: [04a]
Owner: Root-assigned Native runtime adapter integrator
Scope: Bind provider session and log references to existing Native runs while preserving provider ownership.
Verification-kind: runtime
Needs: 04a accepted and a supported pinned-Native seam verified for provider persistence and resume.
Timebox: One provider-session integration with focused lifecycle checks and bounded provider journeys.

## Goal

A project chat can identify and resume its provider session, with runtime logs
stored outside the user's project and visible through safe app references.

## Context

Read [the desktop release target](../desktop-release.md),
[ENGINEERING.md](../../../../ENGINEERING.md), and [Native owners](../native-owners.md).
Native Code already saves run JSON and transcript JSONL in private app data.
The maintained pinned Claude executor now passes the participant persistence
option, records the init-event UUID on the existing Native run, and requests
resume from that reference. Legacy runs without a validated provider ID still
reconstruct bounded transcript context. A requested resume is distinguished from
a provider-confirmed resume. Do not mistake Native replay for provider resume.

## Owned files

- `packages/workbench/server/local-code-agent.ts` and `code-execution-worker.ts`.
- `packages/workbench/server/code-execution-protocol.ts` and host code only where required.
- `packages/workbench/bin/start.mjs` for explicit runtime-storage configuration.
- A small session-details view and scoped action referencing 04a session identities.
- Existing `code-execution-host.test.ts`, `code-host-lifecycle.test.ts`, and `local-code-agent.test.ts`.

## Done condition

Each supported provider invocation records its native session identifier when
available and states whether a follow-up resumes it or reconstructs context.
Use a supported Native API. Unsupported persistence is reported without a false resume claim.
Provider logs default outside selected projects. Native stores session/log references
in app data. Provider-native files and Native transcripts retain their existing owners.
Do not repoint an entire provider credential directory merely to relocate logs.
The user can open relevant log details without exposing credentials or arbitrary paths.
Restart, Stop and interrupted runs preserve references without attaching another session.
Claude Code and Codex each pass session/log checks. An unresolved provider remains unaccepted.

## Verify

Use focused lifecycle fixtures for references, missing logs and denied projects.
Then run the minimum already-authorized provider journeys: start, follow up, stop,
restart and resume. Inspect writes in disposable project and app-data directories.
No additional model budget or account operation is granted by this packet.

```console
node --test packages/desktop/tests/main.test.mjs
pnpm --dir packages/workbench typecheck
git diff --check
```

## Stop conditions

Do not patch node_modules, install another executor, duplicate credentials, or
claim provider continuity from a matching title. Escalate a missing supported Native seam.

## Implemented source boundary and remaining acceptance

The owner-only `vivary-code-state` details action authorizes owner, organization
and project/run before reading. It accepts no filesystem path. Native transcript
reads remain bounded to 64 KiB and 20,000 redacted output characters. Provider ID,
last-turn continuity and logical references survive missing logs.

Native's public Claude reader derives only the documented short default path
from retained canonical cwd/UUID. It refuses links, hardlinks, changed files and
identity mismatch, bounds the whole input before JSON parsing, and uses the
official SDK's read-only SessionStore semantics. Custom/hashed locations are
unsupported. The worker limits resources and clears its environment but is not
an OS sandbox. Workbench redacts user/assistant text before truncation and labels
provider/Native sources separately. Credentials and provider storage stay in place.

The [reader receipt](../receipts/10-claude-log-reader.md) records passing installed
regressions, typecheck/build, desktop/narrow browser and actual isolated production
output. Retained real-log inspection preserved file bytes and made no provider
call. The unchanged executor retains PR #197's real four-turn, 137-second Claude
Stop/restart/resume acceptance. Init/result UUID validation and ID-less ordinary
content behavior remain covered by the maintained continuity tests.

PR #198's Claude increment merged at `df354d0` with passing postmerge CI.
Issue #10 remains open. Native's read-only Codex stored-thread reader and the
existing scoped details integration are now implemented in source; the
[Codex receipt](../receipts/10-codex-stored-thread-reader.md) records the supported
summary API, limits and validation. The initial unsupported-status tracer failed
before implementation. Corrected lifecycle/detail regressions, actual retained-thread
read, guarded build and desktop/narrow built-browser checks pass; independent Spec
and Standards source reviews pass. The local maintained suite timed out at its
wrapper limit and remains incomplete. Private packaged Windows acceptance,
commit-bound publisher review, exact-head CI, Entire verification and owner approval
remain required. Existing real provider journeys are reused without another model
turn; no release or main promotion is accepted.

## Log

- 2026-09-13: Drafted. Provider-session persistence remains unimplemented.

## Shared desktop and web behavior

Provider processes, credentials, and log files remain on the connected backend host. Browser users inspect authorized log details through existing actions without requiring a local filesystem opener.
