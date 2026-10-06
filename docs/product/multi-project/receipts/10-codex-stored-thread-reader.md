# Codex stored-thread details

Issue [#10](https://github.com/vivary-dev/vivary/issues/10) remains open. PR #198's
Claude reader merged at `df354d0` with passing postmerge CI; its accepted reader
and unchanged executor evidence remains in the [Claude receipt](10-claude-log-reader.md).
The Codex increment passes affected regressions, actual retained-thread inspection
and built desktop/narrow browser checks. Independent Spec and Standards reviews
accepted the corrected source. Final commit-bound publisher review, CI, owner
approval and current private packaged Windows acceptance remain pending; no
release or main promotion is authorized by this receipt.

## Supported provider boundary

Native's public `readCodexCodeSessionLog` uses the already installed Codex 0.160.0
app-server. The owner/org/project-scoped details action authorizes before any
launch. Native reads the retained run's thread ID and canonical cwd, initializes
the read-only connection, calls metadata-only `thread/read`, then requests one
newest-first page of at most 20 turns through `thread/turns/list` with
`itemsView: summary`. No client path/ID override, storage scan, custom raw-file
parser, thread/start, thread/resume, turn/start, tool execution or approval grant
is introduced. Unexpected server requests receive a protocol error and inspection
fails safely.

The [official app-server docs](https://learn.chatgpt.com/docs/app-server#list-thread-turns)
and pinned [ThreadReadParams](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/schema/typescript/v2/ThreadReadParams.ts),
[Thread](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/schema/typescript/v2/Thread.ts)
and [ThreadTurnsListParams](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/schema/typescript/v2/ThreadTurnsListParams.ts)
define the API. The pinned [upstream summary-view regression](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/tests/suite/v2/thread_read.rs#L469)
verifies retained user text and the last assistant message in summary mode.
The pinned [summary selector](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-protocol/src/protocol/turn_items_view.rs)
keeps the first user message and last assistant message per turn, regardless of
assistant phase. Middle user and assistant messages are omitted; the Session
details view states this subset explicitly. This is a bounded provider summary, not a complete transcript. Newest turns are displayed in
chronological order, with older-page availability reported as truncation.

Response ID/cwd/provider must match the retained identity. Canonical parent/link
checks refuse existing symlinks or alias paths; an absent retained cwd permits
history only when its surviving parents and response identity still agree. A
provider-reported storage path, when present, must be canonical and outside the
selected project. It is never returned to the client. Provider failures retain
the session ID/logical reference and do not prevent the separate Native transcript
read. Missing/unsupported/malformed/resource-limited results return explicit
statuses without raw provider errors or metadata. Missing classification requires
code `-32600`, the exact retained ID and the correct RPC: `thread not loaded: ID`
on metadata read or legacy listing, or `no rollout found for thread id ID` on
paginated listing. Generic invalid-request/params errors and mismatched IDs remain
unavailable; `-32601` remains unsupported. These errors are classified internally
and never returned as provider text.

## Limits and process ownership

Native bounds stdout/stderr together to 512 KiB, each complete protocol line to
128 KiB, 256 lines and nesting depth 32 before fatal UTF-8 decode/JSON parsing.
It bounds the page to 20 turns and 200 items and returns at most the latest 40
user/assistant messages. Only text user inputs and agent messages are selected.
A 10-second protocol deadline, one active inspection, four FIFO waiters and a
15-second admission deadline bound runtime work. Workbench supplies the trusted
fixed CLI launch and filtered environment, and retains process-tree custody
through existing `code-execution-host` stop and identity-check primitives.
Cleanup has its existing 15-second budget. Every result requires confirmed pipe
closure and a clean identity scan. Checkable cleanup failures retain their targets
and refuse subsequent spawns until new checks prove them clean. Plugin and action
module instances share one process-global reader registry. Normal host shutdown
closes reader admission first, including queued inspections, awaits active
process cleanup and pending opens, and propagates cleanup refusal. Repeated close
hooks share the same shutdown promise, including failure; admission stays closed.
Windows scans retain observed PID/creation identities while the reader is live,
including ancestry whose intermediate parent later exits. Close lets an in-flight
observation finish before termination, waiting at most three seconds and reserving
the rest of the same cleanup budget for tree stop, pipe closure and verification.
A pending scan that fails or times out, or a reader with no successful observation,
retains an uncheckable refusal. Later root-only scans cannot reconstruct the lost
ancestry and do not clear that refusal. A timed-out observation is aborted; its
bounded scanner settles before completion. Retained identities
and overflow survive unavailable scans; this periodic observation cannot prove
ancestry that was never observed and is not OS containment. The desktop parent's
existing Windows 15-second fallback remains unchanged. The host currently
supports this reader lifecycle on Linux and Windows; other platforms report
unavailable until descendant cleanup can be verified with an existing primitive.

Workbench shares the Claude reader's full credential/path redaction before any
per-message or aggregate shortening, retains the newest 20k excerpt and carries
Native's truncation flag. URLs and next-line text retain the PR #198 behavior;
filesystem paths consume ambiguous prose through their line end. UI source labels,
active-only polling, final/open refresh and manual Refresh remain unchanged.

Wire/page/time bounds do not bound the provider's internal storage-file parsing.
The app-server retains OS filesystem/subprocess/network rights; this is not an
OS sandbox or proof that initialization/hooks/MCP cannot execute. No new model
turn is needed for stored-thread inspection or acceptance. Codex's existing
Apache-2.0 notices and Core's MIT notices remain; no dependency or runtime is
added. See the [pinned Codex license](https://github.com/openai/codex/blob/rust-v0.160.0/LICENSE).

## Current evidence

Root observed the initial public-action tracer fail at `df354d0` with
`unsupported != available` (exit 1, one failed test, 9.97 seconds) before production
implementation. The fixture has since been corrected to sibling project/provider
directories and an outside-project metadata path; custody is not weakened to fit
it. The initial test/evidence remains preserved. The expanded maintained details
tests cover text, authorization before spawn, identity/store mismatch, protocol
status/resource/UTF-8 failures, privacy/truncation, concurrent reads, unexpected
requests, timeout, child cleanup and missing project history. Root applied the maintained Native patch through the supported resolver and
frozen offline install without dependency versions or edges changing. Root then
passed the tracer (13), focused suite (112 with one existing installed-policy
skip), redaction suite (36), desktop/package tests, typecheck and doctor.
Final lifecycle checks passed 67 tests with four native-Windows-only skips;
the details tracer passed 13, and typecheck and Doctor completed. The guarded
production build then caught five missing test-fixture environment-mutation
annotations. These were corrected using the existing guard convention without
changing behavior or disabling the guard; the pinned Node 24.19.0 build passed
in 67.6 seconds. The broader local maintained suite reached its 300-second wrapper
limit while progressing, so its partial result is incomplete, not a pass.
Remaining task-owned test processes were stopped; exact-head CI must complete the gate.

The three actual-reader Windows observation fixtures passed with simulated OS
output: delayed ancestry, malformed observation and timeout. They are Linux
regressions, not packaged Windows acceptance. After-authoring replay against the
prior reader failed the premature-stop assertion in two cases; the ancestry case
passed that replay and is not claimed to have demonstrated red. This replay is
separate from the original preimplementation tracer failure.

Read-only inspection through the public details action returned an available,
redacted 20,000-character summary from an actual retained Codex source-work
session in 1.889 seconds. A disposable Native reference selected that existing
session; this is not a new Vivary provider lifecycle journey or a performance
benchmark. The provider-file SHA-256 was identical before and after. No new model
turn was requested. Process tracing observed app-server startup helpers and
outbound connection attempts. Neither this API choice nor successful cleanup
establishes OS network, subprocess, hook or MCP containment; RPC payloads and
network payloads were not captured by that trace.

The built browser exercised two project-scoped disposable sessions through the
real server/action/reader with an external fixture CLI. Desktop 1440×1000 and
390×844 layouts passed, including the summary explanation, preserved web links,
credential/full-path redaction, omitted tool/reasoning metadata and crossed-project
404. Screenshots were inspected. The fixture RPC log contains metadata/turn reads
and no thread/start, thread/resume or turn/start. During a held details read,
normal host SIGTERM left neither the reader nor its ordinary child alive; the
request ended with ECONNRESET and cleanup completed in 0.157 seconds. Browser and
server stopped. Existing accepted refresh/provider journeys are reused.

Private evidence retains all failures, process receipts, raw traces, screenshots
and command results. Root updated these factual receipt paragraphs after the
captured source writer stopped; the root conversation is not claimed as locally
captured implementation history.

Existing real Codex continuity/stored-thread evidence is retained in the
[acceptance register](../desktop-acceptance-status.md); it is separate from this
new reader's completed retained-thread/browser checks and pending private packaged Windows acceptance.
