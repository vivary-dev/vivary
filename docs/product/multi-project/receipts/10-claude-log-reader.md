# Issue #10 Claude provider log reader

2026-10-06. Verified working-tree increment on `fix/provider-log-details`, based
on `5e2642e80020266e5c57cc875a1be471b0f73a3b`. The forthcoming PR will identify
the reviewed commit. Issue #10 remains open; this receipt accepts the described
Claude read behavior, not a new release or the whole issue.

## Implemented contract

The owner/org/project-scoped details action calls Native's public
`readClaudeCodeSessionLog` with the retained run. No client path or arbitrary
provider ID is accepted. Native derives the documented default Claude log from
canonical cwd and UUID without scanning. Custom storage and encoded names over
200 characters are unsupported. A private store inside the selected project,
linked parents/files, hardlinks and changed file snapshots are refused. Matching
session and source cwd metadata prevent authorization by lossy directory encoding.
An absent project folder permits authorized retained history; existing project
components still require canonical identity and link checks.

The complete input is bounded to 256 KiB, 2,048 complete lines, 32 KiB per line
and JSON nesting depth 32 before parsing. Invalid UTF-8, incomplete/malformed
entries, identity mismatch, cyclic parent graphs and oversized identifiers fail
safely. The official SDK 0.3.288 `getSessionInfo` and `getSessionMessages` interpret
opaque entries through a read-only custom SessionStore. No query, start, resume
or provider turn is invoked. See the [official session API](https://code.claude.com/docs/en/agent-sdk/sessions)
and [default transcript location](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored).

One terminable Node worker bounds semantic processing to three seconds, with
64 MiB old heap and 16 MiB young heap. Its empty environment removes inherited
environment values; it is **not an OS sandbox** and retains filesystem,
subprocess and network rights. The [runtime boundary receipt](runtime-sandbox-coverage-2026-10-06.md)
records an actual harmless canary with the same settings. That canary does not
establish SDK malicious-code or hook containment.

Only allowlisted user/assistant text is returned. Workbench redacts complete text
before limiting it to 1,500 characters per message, 40 messages and 20,000 excerpt
characters; tools, thinking, authentication metadata and host paths are omitted.
The UI labels provider and Native sources separately. Missing, malformed,
unsupported, unavailable and resource-limited provider logs keep the session ID
and Native transcript available.

## Verified evidence

| Check | Observed result |
| --- | --- |
| Preflight and dependencies | 9/9 pass; frozen install passes. Only Agent SDK 0.3.288 and API SDK 0.93.0 are new versions; Core retains API 0.90.0. Eight optional platform executors are excluded. |
| Maintained focused suite | 50 pass, one existing installed-policy skip (`focused-final.log`). |
| Redaction, public details and desktop host | 36, 15 and 20 pass respectively (`redaction-final.log`, `details-final-guardfix.log`, `desktop-main-tests.log`). |
| Typecheck and production build | Pass; final build 65.6 seconds, with the doctor enforced. |
| Built browser | Desktop and 390-pixel layout pass; Alpha/Beta/Alpha switching, cross-project 404, redaction and missing/malformed states pass (`browser-results.json`). |
| Installed Native real-log reader | Retained 58,859-byte Claude log yields eight text messages; file hash unchanged (`native-reader-probe.json`). Controller syscall observation found Node only and no provider execution/network; this is an observation, not OS denial. |
| Isolated copied production output | Outside the source checkout, readiness, owner action and browser pass at 18:40:34 UTC; 2,949-character excerpt, same session ID and unchanged SHA-256, zero provider calls (`standalone-real-browser-results.json`). SDK notice is present and optional executors absent (`standalone-package-composition.json`). |

Browser/server processes were stopped after acceptance. Tests use the installed
official semantic helper, not a mocked parser. Regressions cover scope denial,
ID/cwd mismatch, encoded-path collision, malformed/incomplete/oversized/deep/cyclic
input, bounds, unsupported settings, missing logs, missing project with intact
log and link refusal. Deterministic in-flight file-mutation and forced worker-timeout
regressions remain unrun; snapshot checks and termination limits are implemented,
but no observed test result is claimed for those two paths. Redaction includes a delimited unknown token
and a held synthetic credential concatenated across the truncation boundary.
The earlier unknown-token fixture assumed pattern matching inside a longer word;
that assumption was invalid under the existing redactor contract. No production
privacy regression or runtime red-before-green result is claimed for that fixture
or the missing-project correction.

## Packaging and license

Core declares the official SDK as a peer. Workbench pins Agent SDK 0.3.288,
API SDK 0.93.0 and MCP SDK 1.30.0; root Zod 4.5.4 satisfies the remaining peer.
Core keeps its API 0.90.0. Supported pnpm configuration excludes exactly eight
SDK platform executors; installed package files are not edited.

The worker's opaque import needs an explicit production trace seed.
`nitro.config.ts` uses Nitro's supported `traceOpts.hooks.traceStart` and
full-package `traceDeps` for **only** Agent SDK, preserving its resources/notices
and existing Core/app peer bundling. Tracing every peer can mix installed versions;
the isolated output check guards the actual portable result. No custom copier is
used.

The SDK is proprietary. Its [README license and terms](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/README.md#license-and-terms)
and [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms)
cover normal customer-product integration. Preserve the license and notices;
this is not an MIT or unrestricted relicensing grant. No additional vendor
approval gate has been established for this integration. Existing release
acceptance and publication approval still apply.

## Remaining acceptance

PR #197 merged before this increment. Its actual four-turn, 137-second Claude
Stop/restart/resume journey remains accepted for the unchanged executor; these
read checks required no additional provider turns. Existing Codex continuity and
stored-thread RPC evidence is retained, but current details return unsupported
for Codex provider logs. A bounded stored-thread view remains necessary to close
issue #10. The current Windows candidate is unrun and no fresh release is claimed.

Final independent review, reviewed commit, required CI at that commit, Entire
capture/delivery verification and owner approval remain pending. This Claude PR
increment can proceed through those existing gates while issue #10 stays open.
