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

The existing owner-only `vivary-code-state` read action accepts a conversation
identity and a details flag, never a filesystem path. It authorizes the owner,
organization and project/run binding before reading the Native transcript. The
Session details view shows the provider ID, last-turn continuity and the next
turn's requested behavior. The logical Native log reference survives missing
transcript files. Its excerpt reads at most 64 KiB and returns at most 20,000
characters after credential redaction; symlinks and hardlinks are unavailable.
Provider-native log files retain their CLI storage owner and are unavailable in
this view. Credentials and provider storage directories are not relocated.

The inert Claude CLI fixture exercises the public Native executor and participant
for persistence, reference reload, Stop and resume, and refuses a mismatched
session without replacing the saved reference. Scoped action tests cover owner,
organization and project denial, missing logs, bounded output, redaction and
linked-file refusal. These fixtures do not establish real provider execution,
provider-native log placement, a full host restart, or packaged Windows behavior.
Those journeys remain required before issue #10 is accepted.

Init/result records require a valid UUID before output is consumed, including
when the field is missing, numeric, null or empty. Ordinary content/tool events
may omit an ID; explicitly supplied IDs still require validation. A rejected init
leaves resume requested, while a valid matching init remains a confirmation even
if a later result is rejected. The added malformed-identity and ID-less-event
regressions await the coordinator's frozen install and affected checks.

## Log

- 2026-09-13: Drafted. Provider-session persistence remains unimplemented.

## Shared desktop and web behavior

Provider processes, credentials, and log files remain on the connected backend host. Browser users inspect authorized log details through existing actions without requiring a local filesystem opener.
