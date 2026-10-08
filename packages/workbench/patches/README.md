# Maintained Native chat patch

Jeff approved this dependency patch on September 15, 2026, for
[project conversations, issue #6](https://github.com/vivary-dev/Vivary-New/issues/6).
This approval supersedes the earlier restriction against patching Core for those
defects. Later feature work extends the same maintained patch as described below.
Native still owns conversations, storage, requests, and execution.

`pnpm-workspace.yaml` applies `@agent-native__core@0.176.5.patch` to the pinned
Core package. Issue #9 also applies `@agent-native__toolkit@0.19.3.patch` to the
pinned Toolkit package. The lockfile records both patch hashes. Install with
`pnpm install --frozen-lockfile` from `packages/workbench`.

## Claude provider session continuity

Issue [#10](https://github.com/vivary-dev/vivary/issues/10) connects the pinned
Core Claude participant's existing session options to the Native Code executor.
The executor enables persistence and records a validated UUID from the init event
on the existing Native run, before Stop can interrupt it. Later turns request
resume with that UUID. A different or invalid event session stops the turn and
leaves the recorded reference intact. Init and result records require a valid
UUID even when their identity is missing, numeric, null or empty. Ordinary
content/tool events may omit it; any explicitly supplied identity is checked
before its output is attached. A failed request remains `resume-requested` until
a matching valid init confirms the same session. Rejecting a later result does
not erase that earlier confirmation; transcript replay never confirms resume.
Codex retains its app-server owner and thread validation and records the same
continuity vocabulary.

Runs without a validated provider ID reconstruct bounded Native transcript
context. Valid IDs support later native resume. Provider files and credentials
retain their runtime owner and location. The scoped Workbench details action adds
a separately labeled Claude excerpt through Native's public
`readClaudeCodeSessionLog`. The [reader receipt](../../../docs/product/multi-project/receipts/10-claude-log-reader.md)
records passing installed checks, browser acceptance and isolated copied-output
acceptance without a provider call.

Only the documented short default cwd/UUID location is supported, without scans
or client paths. SDK-compatible provider key and cwd metadata normalization is
NFC on Darwin only; filesystem canonical-path/link checks retain their original
spelling and Linux NFC/NFD identities remain distinct. The public Unicode
regression passes installed Linux checks; native macOS acceptance remains unrun.
Input caps are 256 KiB, 2,048 complete lines, 32 KiB per line and
nesting depth 32 before JSON parsing. Links, hardlinks, changed snapshots, identity
mismatch and cyclic parents fail safely. The official SDK interprets opaque
entries via a read-only store in a terminable worker with a three-second deadline
and bounded heap. A bounded FIFO admits one active inspection and four waiters,
with a 15-second wait limit and unavailable status for overload/expiry; every
outcome releases admission. Workbench redacts allowlisted user/assistant text
before per-message limits and keeps the newest 20,000 aggregate characters.
The worker clears its environment but retains OS filesystem,
subprocess and network rights; it is not an OS sandbox. Missing canonical project
folders permit retained history; existing linked project paths remain refused.
Session details polls only its selected active run, refreshes once when that run
settles while open, and offers manual Refresh. Parent host/status queries are
unchanged. New concurrent-read, overload, queued-origin and newest-excerpt
regressions pass after the updated frozen install. The reader receipt records
the affected built-browser polling and held-response acceptance, with synthetic
activity transitions distinguished from real provider execution.

`packageExtensions` declares Agent SDK 0.3.288 as a Native peer. Workbench pins
that SDK, API SDK 0.93.0 and MCP SDK 1.30.0; Core retains API 0.90.0 and root Zod
4.5.4 satisfies its reader peer. Exactly eight optional SDK executors are excluded
through `ignoredOptionalDependencies`. The frozen install and dependency audit
passed; installed package files are not edited.

The production `nitro.config.ts` seeds the resolved SDK worker entry through
Nitro's supported `traceOpts.hooks.traceStart` and traces only its full package
through `traceDeps`, retaining resources and notices. This covers the opaque
worker import while preserving Core/app peer bundling; full peer tracing can mix
installed versions. Existing worker chunk emission is preserved and no custom
copier is used. The isolated server's readiness, scoped action and browser passed,
with the SDK notice present and no optional executors.

Preserve the proprietary SDK license and notices. The
[official README](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/README.md#license-and-terms)
and [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) cover
normal customer-product integration; no additional vendor approval gate has been
established. This grants no MIT or unrestricted relicensing rights. Existing
release acceptance and publication approval remain required.

Run `pnpm --dir packages/workbench exec tsx --test --test-concurrency=1
tests/claude-session-continuity.test.mjs tests/code-session-details.test.ts
tests/local-code-agent.test.ts tests/codex-executor.test.mjs`. The Claude fixture
uses the public executor, real participant and Native store with an inert CLI on
its PATH, including malformed init/result identities, explicit invalid content
identities and compatible ID-less content/tool events. Its executable fixture is
POSIX-only. These checks make no provider calls and do not replace real provider
or packaged Windows acceptance. Remove the
executor hunks when a pinned upstream Core version preserves and validates
Claude session references and passes these regressions without the patch.

## Codex stored-thread details

Issue #10 adds Native's public `readCodexCodeSessionLog`, separate from the
executing app-server entry. It uses the pinned provider's metadata read and one
bounded descending summary page, with canonical identity/store guards and raw
byte/UTF-8/depth/time/queue limits. Workbench retains launch and verified tree
cleanup through a narrow lifecycle callback and shares the Claude redaction path.
No dependency or provider turn is added. The [Codex receipt](../../../docs/product/multi-project/receipts/10-codex-stored-thread-reader.md)
records the API, summary semantics, runtime limits and pending installed/browser/
private Windows validation. Preserve all previous patch hunks; regenerate the
Core patch hash through supported pnpm resolution before frozen install. Installed
regressions must use the resulting patched dependency, not a source-only import.

## Email BCC delivery

Issue [#112](https://github.com/vivary-dev/vivary/issues/112) fixes an email action
that claimed a blind copy was sent after dropping its address. The action now
passes its trimmed, nonempty `bcc` to `sendEmail`. `SendEmailArgs` accepts one
address or an address list. Resend receives `bcc` as an address array. SendGrid
receives `personalizations[0].bcc` as an array of `{ email }` objects. BCC does not
enter the visible To, Cc, headers or message content. Empty action input omits BCC.

A provider error remains an action error. Without a provider, a BCC request fails
even in development, where the existing no-BCC logging fallback stays available.
Provider selection, credentials and the unattended automation tool allowlist are
unchanged. The fake HTTP transport tests exercise the installed action, Markdown
renderer and email transport together. They send no email.

Run `pnpm --dir packages/workbench test:email`. The maintained CI suite includes
this command. Remove the three email patch hunks when a pinned upstream Core
version preserves BCC in both transports, refuses unsupported delivery honestly,
and passes these tests without the patch.

## Raw SQL inspection

The maintained Core patch gives the raw database tools one SQL tokenizer.
It separates string values, quoted identifiers, comments, parameters, and SQL
keywords. Comments remain whitespace. Their contents never change a string
value or join two keywords. Token offsets refer to the SQL that executes.

The tokenizer follows SQLite quoting, including doubled single quotes, double
quotes, backticks, and bracket identifiers. SQLite's legacy single-quoted table
names remain visible to the table checks. The installed SQLite build disables
double-quoted string literals. Both database paths use this inspection. Each PostgreSQL transaction sets
standard string escaping before scoped-view setup or user SQL.

| Inspection | Treatment |
| --- | --- |
| `db-query` prefix, protected tables, and schema references | Check the input token stream, including qualified tables in comma lists and parenthesized groups. Read queries require a complete allowed keyword. WITH and EXPLAIN cannot wrap writes. PRAGMA accepts the listed read operations only. |
| `db-query` LIMIT | Find a top-level keyword and insert a requested limit before a terminator or trailing comment. String values, identifiers, and nested queries do not suppress it. |
| `db-exec` prefix and statement count | Remove real comments as whitespace and accept one statement per batch entry. Quoted punctuation remains data. |
| Protected and access-control names | Inspect decoded identifiers and parsed write targets and columns. The extensions route keeps its separate, longer protected-table list. |
| Write ownership and SQLite scope predicates | Parse supported targets, column lists, and top-level clauses. Insert trusted ownership values at parsed offsets and scope only the actual WHERE expression. Caller-supplied organization ownership is refused. |
| `db-patch` WHERE | Inspect tokens for statement chaining, real comments, forbidden keywords, protected tables, and qualified table references. Table and column arguments still require plain identifiers. |
| Extensions query, destructive, and positional-insert gates | Inspect the same tokens before delegating to the Core scripts. Quoted values do not become policy keywords. |
| PostgreSQL parameter conversion and RETURNING detection | Convert only parameter tokens and detect only a top-level RETURNING clause. |
| Write result hints | The hint reads an already validated statement prefix. It changes output only and cannot authorize or change a write. |

Supported writes are a single INSERT with explicit columns and one VALUES tuple,
UPDATE with individual column assignments, and DELETE FROM. RETURNING and INSERT
conflict actions other than REPLACE remain supported. Replacement conflicts are
refused because a base-table conflict can affect a row outside the caller's view.
Unsupported forms return an error before opening the database. That includes
tuple assignments, UPDATE FROM, positional or multi-row inserts, INSERT SELECT,
and upsert suffixes.

The shared syntax excludes prefixed quotes, dollar-quoted strings, and nested
comments. CR-only line comments are refused too. Those forms return an error rather than receiving a different
interpretation on PostgreSQL. Use bind parameters for values. This is a bounded
SQL inspector, not a complete SQL grammar or a database permission system.
The existing owner and organization views still control row visibility.

Verification from the repository root:

```sh
node --test packages/workbench/tests/sql-inspection.test.mjs packages/workbench/tests/sql-postgres-inspection.test.mjs packages/workbench/tests/cli-bridge-arguments.test.mjs
```

The tests use production mode, a disposable SQLite database, Core's registered
tools, and the extensions HTTP handlers. Refusal cases first require the query
tool to return an owner-scoped control row. Three mocked PostgreSQL tests check transaction ordering and synthetic results.
They do not establish execution against a PostgreSQL server. Test-only SQL stays
in the tests.

Remove this section and these patch hunks when a pinned upstream Core release
uses equivalent token inspection and scoped write handling at every listed
site, and these tests pass against that release without the hunks.

## Behavior

Each saved conversation repository has a server-owned `_vivaryHeadRevision`.
Legacy repositories start at zero. Changing the selected message increments the
revision. Saving more content under the same selected message does not.

A browser snapshot supplies the revision it observed. Native merges its message
content, but accepts a different selected message only when that revision still
matches. This preserves replies after a delayed save while allowing an intentional
branch change from the current revision. A stale branch selection must reopen
the current conversation before retrying. Clients that omit the revision can
still save content, but cannot move the saved selection.

The check runs inside the existing database compare-and-swap retry, so another
writer cannot bypass it between reading and saving. The server ignores any
revision embedded in the incoming repository. Invalid snapshots fail before a
write. No database table or separate history store is added.

The browser queues snapshots by endpoint, scope, and thread. Each snapshot keeps
the observation from which it was made. Acknowledgements can advance that same
observation. A later import or remounted conversation has its own observation.

The multi-tab wrapper also honors the host's disabled-composer setting. Existing
server checks still refuse execution against unavailable projects.

## Verification

From the repository root, run:

```sh
node --test packages/workbench/tests/native-thread-save*.test.mjs
pnpm --dir packages/workbench exec tsc --noEmit -p tsconfig.json
```

The tests cover stale and concurrent writes, deliberate branch changes, retained
messages, invalid input, save order, and observation changes across remounts.
The SQLite test uses a disposable database. CI runs these tests against the
installed package, so an unapplied patch fails the checks.

Before accepting a patch revision, build the application and exercise two
projects plus Personal workspace. Reopen and continue their Native chats,
replay an older snapshot, and confirm that an unavailable project's history
remains readable while its composer is disabled. Use the existing isolated
responder for deterministic tests. Keep those results separate from real
provider execution and Windows acceptance.

## Removal and rollback

Remove the patch only after an upstream release passes the same regression and
application checks. Remove its `patchedDependencies` entry, update the pinned
Core version and lockfile, and keep the regression coverage for the replacement
behavior. Do not edit files in an installed dependency directory.

Rolling back this patch restores the known save-order and composer defects.
The extra repository field requires no schema migration. Keep the private
preview's prior build available until its replacement passes verification.

## Chosen Native model default

Issue #50 changes Core's model picker. Core added the current model to its
provider's picker group only when that group had no built-in models, and a new
chat took the first model of the first configured group. A custom model, such
as an OpenRouter id saved in Settings, was never offered, and a new chat could
run on another, possibly paid, model.

`list-agent-engines.js` now reports `current.chosen`. It is true when a stored
setting or an app default chose the current model, and false when Core detected
the engine or fell back to an engine's default model. Both chat surfaces pass it
to `buildChatModelGroups` in `chat-model-groups.js`. When the chosen provider is
configured, its group is listed first with the chosen model first, added when
the built-in list lacks it. The multi-tab chat that Vivary uses then selects it
for a new chat. A detected engine, or a chosen one without a key, keeps Core's
order, and a model is never added to a group without a key. With the Builder
gateway lane, Builder models stay first and the chosen model is only listed.

`MultiTabAssistantChat.js` stores a project's composer pick with the Settings
choice that was current when it was picked. When the chosen engine or model in
Settings changes, a pick stored under an earlier choice, or under none, is
cleared, so new chats follow Settings. Every open chat that was following the
pick, including the routed active chat, is pinned to it first, so it keeps its
model for the rest of the session. Pins live in memory, so after a reload an
open chat follows Settings. Another window on the same project pins its own open
chats to the removed pick, drops it, and refreshes when it sees the clear. Two
clears happen without a model change in Settings: the first load after this
patch, when a pick from before it has no Settings stamp, and a key save that
makes a saved but unusable choice usable. Core's `useChatModels` hook keeps its
own selection rules. Vivary does not use it.

`chosenSettingsKey` and `storedPickYieldsToSettings` in `chat-model-groups.js`
hold the rule, so it is tested without React. Run
`node --test packages/workbench/tests/chat-model-groups.test.mjs`. The packaged
Windows journey for #50 checks the React wiring.

## Replayed tool-call ids

Issue #50 changes `dist/client/agent-chat-adapter.js`. When a Native chat sends
a follow-up, Core replays the earlier turns and gives every earlier tool call a
new id, `history_tc_<n>` for history and `continuation_tc_<n>` for a continued
run. Some providers reached through OpenRouter keep only the first nine
characters of a tool-call id. `history_tc_1` and `history_tc_2` then collide,
and the provider ends the stream with `provider_unavailable`. On the packaged
Windows app with `stealth/space-bunny-alpha`, every follow-up after a turn with
several tool calls failed this way, while ids that differ within nine
characters passed.

`replayToolCallId` now makes each replayed id a one-letter prefix, `h` or `c`,
and eight base-36 digits, such as `h00000001`. The ids are nine alphanumeric
characters, which also meets the strictest known rule, and the prefix keeps
history and continuation ids apart. `assistantUiMessagesToStructuredHistory` is
exported so the test can replay a turn. Run
`node --test packages/workbench/tests/replay-tool-call-ids.test.mjs`.

## Server-replayed tool-call ids

Issue #107 changes `dist/agent/thread-data-builder.js`. Two server paths resume
a run from saved thread data with its tool calls: the chained background
continuation in `agent/production-agent.js` and a sub-agent's continue mode in
`server/agent-teams.js`. Both call `threadDataToEngineMessages` with
`includeToolCalls`, which copied each saved tool-call id into the replayed call
and its result. A call saved without a provider id is stored as
`<runId>:tc_<n>`, and run ids created within about a day share their first
nine characters, so these replays met the collision in the previous section.

The replay now gives each call a new id, the prefix `r` and eight base-36
digits from one counter for the whole replay, and the call's result carries the
same id. Two turns that saved the same id replay with two ids.

No code on either path matches a replayed id back to a saved one. The seeding helpers pair
a call with its result inside the replayed messages and match earlier work by
tool name and input. Saved thread data keeps its ids, because the browser
matches a reconnecting stream's `tc_<n>` against the saved `<runId>:tc_<n>`.
`thread-data-builder.js` keeps its own copy of the one-line
`replayToolCallId`, because importing the client adapter into server code would
load its browser dependencies. The same test file covers this replay.

## Native stream errors

Issue #101. OpenRouter reports a provider failure inside the stream as an error
chunk, `{"error":{"code":502,"message":"...","metadata":{...}}}`. The AI SDK
turns it into an `error` part followed by a `finish` part with no text. Core's
engine kept the last stop it saw, so the provider's text was dropped and the
chat showed only "Engine stream error", with Dismiss and Copy and no Retry.

The patch changes these files:

- `agent/engine/ai-sdk-engine.js` keeps the first error stop that carries a
  code. An error stop with no code stays when the later stop is also an error
  with no code. A chunk that fails the provider's schema has no code, so a
  stream that goes on to a normal finish still ends the turn normally, and a
  provider error after it still shows its message and code.
- `agent/engine/translate-ai-sdk.js` turns a provider's plain-object error into
  its message, its code, and the upstream provider's name, for example
  "Provider returned error (code 502, from Google)", with the error code
  `provider_stream_error`. An error chunk that fails the provider's schema,
  such as one with no message, still holds the object and is read the same
  way. Any other chunk that fails to parse reads "The model provider sent a
  response that could not be read", never shows the chunk, and offers no
  Retry, because the turn may have finished normally after it.
- `agent/production-agent.js`, `agent/thread-data-builder.js`, and
  `client/sse-event-processor.js` treat `provider_stream_error` as final.
- `client/chat/run-recovery.js` and `client/chat/message-components.js` offer
  Retry for `provider_stream_error`.

The translation reads only these fields of the provider's object: `message`,
`code`, `type` when there is no code, `metadata.provider_name` when it starts
with a letter and holds at most 64 letters, spaces, periods, and hyphens, and
a numeric `statusCode` and a boolean `isRetryable` on the object, which
OpenAI's Responses stream sets. The translation cannot tell a status an SDK
derived from one the provider sent, so a numeric `statusCode` on any provider
object classifies as that status. The name holds no digits, because the client reads the
shown text for statuses, and a name such as "401 unauthorized" would swap the
error card for the provider setup card. A name with a digit is left out, and
the text keeps the message and code. The rest of `metadata` can hold the
upstream provider's raw response, so it is never shown and never classified.
`classifyProviderError` sees the message, the code, and that status. A
classification it finds, such as `http_429` for an in-stream `"code":429` or
`http_<status>` for a derived status, still replaces the code. An upstream
body that says "overloaded" or "timed out" no longer does.

The code is final in every check that reads an error's message: the engine
retry (`isRetryableError`), the in-process resume of a main chat turn
(`isResumableEngineError`), the background continuation
(`isRecoverableContinuationError`), the turn the server saves
(`isInternalContinuationError`), and the client's automatic continuation
(`isAutoRecoverableError`). Each returns on the code before any text match,
because a provider's message can name 502, a timeout, a closed stream, or an
unavailable service. Before this, the server retried the turn three more times
over about 15 seconds, the client then continued it on its own, and a turn that
the server saved, for example after a reload, kept no error, or no reply when
no text had streamed.

Retry shows on the error card and on the inline notice under the last failed
message, which is what remains after Dismiss. Each Retry takes one click per
error. A second click on the card or the notice before the chat re-renders
does nothing, and a different error gets a fresh Retry. Retry calls
`retryAfterRunError` in
`AssistantChat.js`, the same retry the credential card uses. It adds a visible
user turn, "Retry the previous request from a clean approach...", followed by
the last user message's text, and keeps the failed turn and the rest of
history. It is not a verbatim resend.

The in-stream code is not read as an HTTP status, because `http_502` would buy
the same silent retries and automatic continuation. Whether a transient
in-stream 502 should retry on its own is a separate decision.

These limits were declined in review:

- An in-stream 401, 402, or 403 gets a Retry that repeats the failure, and a
  rejected key is not recorded, because the object carries no HTTP status.
  OpenRouter sends those as HTTP statuses before the stream, which take the
  classified path.
- An in-stream rate-limit phrase from another AI SDK provider, such as
  "Rate limit reached" with no status and no 429, no longer retries on its own.
  Those normally arrive as HTTP 429 before the stream.
- A message queued during the failed run is sent first when the run ends. The
  failed turn is then no longer the last message and keeps no Retry. This is
  upstream behavior.

The run manager already sends the engine's `errorCode` on the run's `error`
event, and the redaction hook already covers that event, so the provider's text
reaches the screen with held credentials replaced.

Run `pnpm --dir packages/workbench test:native-chat`.
`tests/native-stream-errors.test.ts` runs Core's OpenRouter engine against a
loopback fake. One table checks the engine's final stop for an OpenRouter
error chunk, one with no message, OpenRouter's documented mid-stream shape, an
error with a type and no code, provider names that are not plain or are too
long, an unknown chunk followed by a normal finish, an unknown chunk and the
provider's error chunk in both orders, and a last chunk that fails its schema
or is not JSON. No metadata or raw chunk may reach the stream. The
error chunk then runs through `startRun` with Vivary's redactor and a held
synthetic value in the provider message. A second table runs six turns through
`startRun`, with and without streamed text, with messages that name a closed
stream or an unavailable service, and with metadata that names an overload or
a timeout. Each must keep `provider_stream_error` after one provider request,
save a turn that keeps the error, and neither continue nor resume. A last case
checks that an error with its own HTTP status keeps `http_<status>`.
`tests/native-chat-components.test.mjs` passes an error event through
`processEvent` into `RunErrorRecoveryCard`. The turn must end instead of
continuing, the card must show the message and a Retry that reaches the retry
handler once for a double click, and an unclassified code must still get no
Retry. The inline notice must offer Retry for this code on the last message
only, and reach the handler once for a double click. A provider name of "401
unauthorized" must be left out of the text, and the card must stay the error
card with its Retry. Before the first review round, every case that round
added failed except the documented shape, the provider name cases, and the
status case, which already held. Before the second, the unknown chunk ahead of
the provider's error, the status-like name, and the inline double click failed.

Upstream could take these changes as they are. Remove this part of the patch
only when an upstream release shows an in-stream provider error with its
message and a Retry, and passes the same tests.

## Send button name

Issue #102. The Toolkit composer's Send button holds only an arrow icon. Its
label lived only in the hover tooltip, so the accessibility tree showed an
unnamed button, and screen readers and automation could not identify it. The
Toolkit patch adds `aria-label: sendButtonTooltip` to the button in
`dist/composer/TiptapComposer.js`. `sendButtonTooltip` already reads "Send
message", or "Queue message" when `willQueue` is set, through the composer's
translation adapter, so the name matches the tooltip in each state. The Stop
button is Core's and already has a name.

Run `pnpm --dir packages/workbench test:native-chat`.
`tests/native-chat-components.test.mjs` renders the Toolkit composer, with the
real Tiptap editor, inside the assistant runtime and tooltip providers. It
reads the send button's accessible name, "Send message" and then "Queue
message" with `willQueue`. linkedom has no text selection, computed style, or
viewport size, so the test supplies an empty selection, an empty style, and a
fixed size. The name was empty on the previous patch. In the packaged Windows
app, the accessibility tree showed an unnamed button after "Use microphone" on
build `d5c960ce` and "Send message" on build `32f02b54`. The queue state was
not reached there, so the test covers it.

Upstream could take this change as it is. Remove this part of the patch when
an upstream Toolkit release names the button and passes the same test.

## Native usage cost

Issue #103. Core priced every Native turn from its own table. A model the table
did not know matched a catch-all entry and was priced at Sonnet's $3 input and
$15 output per million tokens. In the packaged run for #50,
`stealth/space-bunny-alpha`, which OpenRouter lists at $0, recorded 48.31¢.
OpenRouter reports each call's cost in its last stream chunk, and the AI SDK
passes it on the step's `finish-step` part, but Core read usage only from the
`finish` part and dropped the cost.

The patch changes these files:

- `agent/engine/ai-sdk-engine.js` reads OpenRouter's
  `providerMetadata.openrouter.usage.cost` from the step's `finish-step` part
  and adds it to the step's `usage` event as `costUsd`, including 0. A missing,
  negative, or non-numeric cost adds nothing. `agent/engine/types.d.ts`
  declares the field.
- `agent/production-agent.js` passes `costUsd` from the agent loop to
  `onUsage`, and the loop calls the new `onModelCall` as each model call
  starts, with `retry` set when the call retries a failed attempt. The new
  `createTurnUsage` sums a turn's usage over its model calls and internal
  continuations. A retry replaces the attempt it retries, so a rate-limited
  attempt adds no call. The turn records the sum as a reported cost, in
  centicents rounded as `calculateCost` rounds, only when every call it counts
  reported a cost. Otherwise the turn passes no cost and the store decides.
- `usage/store.js` gives Sonnet ids their own price entry and removes the
  catch-all. `recordUsage` records `cost_source = 'unavailable'` with a cost of
  0 when the caller passed no cost and the table has no price for the model.
  `calculateCost` returns 0 for such a model, because traces and integration
  budgets also call it, and the new `hasTablePrice` says whether the table
  prices a model. The table setup, which runs once per process, also converts
  the old guesses. It sets every `estimated` row whose model the table does not
  price to `unavailable` with a cost of 0, so the #50 turns read Unknown after
  the upgrade. It changes no other row, and a second run changes nothing. A
  failed conversion, such as one by a database role without UPDATE on the
  table, logs a warning and lets setup finish, so usage still records. The
  next process start tries again.
- `usage/metrics-store.js` counts the calls whose cost is unknown, as
  `unknownCostCalls`, in the Usage tab's totals, today's figure, the daily
  figures, and the workflow and model rows. Recent rows carry `costSource`. A
  workflow or model row with calls of unknown cost sorts before the others, so
  the row limit does not drop it while the totals count its calls.
- `usage/alerts-store.js` counts the calls of unknown cost in each alert
  rule's window, as `unknownCostCalls`.
- `client/settings/UsageSection.js` shows a figure whose calls all have an
  unknown cost as "Unknown". A figure with both shows the known amount and the
  count, for example "12.30¢ + 1 unknown". Every figure adds only known costs.
  A cost alert shows its count the same way, for example "$0.00 + 1 unknown of
  $5.00". A token alert does not, because every call's tokens are known.
- `integrations/webhook-handler.js` sums an integration run's usage with
  `createTurnUsage`. The handler settles a run after it delivers the reply, or
  in its catch path when delivery fails, and both points call one step. Once
  the run started a model call, whether its agent loop finished or threw, that
  step passes the run's usage record to the new exported
  `recordAndSettleIntegrationUsage`, which writes the usage row and settles the
  run's budget reservations from that one record. A run that failed before its
  first model call, such as one whose engine did not resolve, settles nothing,
  and the handler releases its reservations. The settlement runs in a
  `finally` block, so a row that fails to write is logged and the reservations
  still settle. The row takes the reported
  cost by the chat turn's rule, so a free model's integration run on
  OpenRouter records $0 as reported. Without a reported cost the row keeps the
  table price or Unknown. Its tokens are the sum of the run's usage events, as
  a chat turn counts them, so a run whose agent loop failed after it used
  tokens now records a row too. The budget settles by three rules. A run whose
  calls all reported a cost settles at that cost, so a free model on
  OpenRouter settles at 0. A run with no reported cost settles at its table
  cost for a priced model, and at 0 when it used no tokens. A run that used
  tokens of an unpriced model and has no reported cost settles at its budget
  reservation, `INTEGRATION_RUN_RESERVATION_MICROS` or $5 by default, so a
  budget cap still fills. The function is exported so the test can call it as
  the handler does.

These limits remain:

- Only the main chat turn and an integration run record a reported cost in
  the usage table. Custom agent calls, background automations, and agent teams
  still record without one, so a free model on those paths shows Unknown
  rather than $0.
- A turn passes no cost when any call it counts reported no cost. A call cut
  off by Stop, by a dropped connection, or by an in-stream provider error
  after text reports none, and so does a call whose stream ends with no usage
  chunk. The table prices that turn, or it shows as Unknown.
- A retry replaces the attempt it retries. OpenRouter can bill output that an
  attempt streamed before it failed, and a turn whose retry reports a cost
  leaves that output out.
- An integration run of an unpriced model whose provider reports no cost,
  such as a model reached through a provider other than OpenRouter, fills a
  budget cap at the $5 reservation per run, however little it cost.
- The engine reads `usage.cost` only. OpenRouter reports the upstream charge
  for a request made with the owner's own provider key separately, in
  `cost_details.upstream_inference_cost`, and that charge is not added.
- Engine models that the table never priced lost the Sonnet estimate and
  record Unknown when the provider reports no cost. They include Cohere's
  default `command-r-plus-08-2024` and `command-r`, Ollama's default
  `llama3.1` and its other local ids, and Builder's `auto`, whose credit figure
  also reads Unknown.
- Traces price spans with `calculateCost`, so an unpriced model's span shows 0
  rather than Unknown. The daily trend chart plots known costs only.
- Usage alerts sum known costs, so an unknown cost never triggers a spend
  alert. The alert row shows how many calls it left out.
- The model list shows four rows. When more than four models have calls of
  unknown cost, it still shows four.
- The conversion reads the distinct models of `estimated` rows at every
  process start, one extra query on a large hosted table.

Run `pnpm --dir packages/workbench test:native-chat`.
`tests/native-usage-cost.test.ts` runs Core's OpenRouter engine against a
loopback fake whose last chunk reports usage with a cost of 0, a positive cost,
or no cost, and the engine's usage event must carry that cost. Nine turns run
through the agent loop and `createTurnUsage` into the usage table. A reported 0
records 0 as reported, a reported positive cost records it, a reported cost wins
over the table's Sonnet price, an unpriced model with no reported cost records
an unknown cost, and Sonnet with no reported cost keeps its $3 and $15 price. A
rate-limited first attempt followed by a retry that reports 0 records 0 as
reported. Three turns whose first call reports a cost record an unknown cost,
because the second call is stopped, cut off by an in-stream provider error
after text, or ends with no usage chunk. The Usage tab's metrics must count the
unknown call in every figure and leave it out of the known cost, and an
unpriced model must keep its row among six models. A second run of the table
setup over old rows must mark only the unpriced model's estimate unknown. When
a database trigger refuses the conversion, setup must log it and usage must
still record, and the next start must convert the row. A daily cost alert must
count the unknown call. Six integration runs go through the agent loop and
`createTurnUsage` into `recordAndSettleIntegrationUsage`, as the handler wires
them, and each must settle its budget and write its usage row from the same
record. A reported cost of 1.23¢ or 0 settles at that cost and records it as
reported, whether or not the table prices the model. Sonnet with no reported
cost settles at 6,000 currency micros and records its table price. An unpriced
run with zero tokens settles at 0 and writes no row, and an unpriced run with
tokens settles at its $5 reservation and records an unknown cost. When a
database trigger refuses the usage row, the failure must be logged and the
budget must still settle. Three claimed integration tasks run through
`processIntegrationTask`. In two of them the agent loop's first call reports
usage and an in-stream provider error cuts off its second call, so the loop
throws. Whether the fallback reply is delivered or its delivery fails, the
task must record Sonnet's table price in its row and settle at 6,000 currency
micros. The third task's engine does not resolve, and it must complete with
no row and no charge.
`tests/native-chat-components.test.mjs` renders the Settings Usage tab and must
show "12.30¢ + 1 unknown" for the total, "Unknown" for the unpriced model, and
"$0.00 + 1 unknown of $5.00" for a cost alert.

On the first patch for #103 every case of that round failed except the engine
case with no reported cost, and the turn cases failed because
`createTurnUsage` did not exist yet. On the second patch, the retried and
stopped turns, the model list, the old rows, both alert cases, and the budget
case failed. The budget case failed because the settlement function was not
exported. On the third patch, the two cut turns recorded the first call's cost
as reported, the refused conversion stopped usage from recording, and the
budget settled every unpriced run at its reservation and ignored a reported
cost. On the fourth patch, the six integration run cases failed because
`recordAndSettleIntegrationUsage` did not exist yet. On the fifth patch, the
handler's catch path wrote no row and settled nothing after a loop that threw,
and the task whose engine did not resolve ended as delivery-pending, because
the handler read the run's usage record, which the run never created. The refused
row case already passed, because the row writer logged its own failure.

Upstream could take these changes as they are. Remove this part of the patch
when an upstream release records a provider's reported cost and an unknown cost
for an unpriced model, and passes the same tests.

## Stopped replies

Issue #106. In the packaged run for #50, a Stop during a long turn looked late,
and the stopped reply carried no stopped label. The investigation found that
Stop already reaches the model request and Vivary's tools within milliseconds.
The run route calls `abortRunDurably`, which aborts the run's signal, and the
signal reaches `streamText` and each tool step's `ctx.signal`. The #50 click
most likely landed late, because the test harness read the accessibility tree
for seconds before each click. No record of the click time exists. The label
was missing for two reasons. The server's saved turn ignored the run's
terminal `{ type: "done", reason: "user" }` event, and the client showed the
stopped notice only under the last reply and only when it had no text.

The patch changes these files:

- `agent/thread-data-builder.js` sets `custom.userStopped` in
  `buildAssistantMessage` when the run ends with `done` and reason `user`, as
  the live client's `processEvent` does. The run store emits that event when
  the owner stops a run. That covers Stop in the chat, the stuck banner's
  Cancel and Retry (`user_stuck_cancel` and `user_stuck_retry`), and the stop
  of an agent team's background run. `foldAssistantTurn` already merges
  `custom`, so the flag also reaches a turn the client saved first. A later
  run that folds onto the same turn keeps the flag only when it was stopped
  too.
- The same file carries `userStopped` over in a client save, as it carries the
  run duration. The merge keeps one copy of a turn whole, usually the client's
  heavier copy. When assistant-ui cancels a stopped run, the client's copy can
  lose the flag, and the #50 turn's saved copy had none. The flag carries over
  only between copies of the same run, so a copy of a later run in the same
  turn does not take it.
- The same file saves a turn that the owner stopped before any text,
  reasoning, or tool call, with no content and the flag. `buildAssistantMessage`
  no longer drops it as empty, and a client save keeps an empty reply that
  carries the flag while it still drops other empty replies. The next
  request's history leaves the empty reply out, as the live chat's history
  does.
- `client/chat/repo-helpers.js` keeps such a reply when the chat loads a saved
  thread. `dropEmptyAssistantMessages` dropped every empty reply.
- `client/chat/message-components.js` shows "The agent stopped before
  finishing" under every stopped reply, with or without text and after later
  turns. It reuses the `agentChat.error.stopped` string, so no locale file
  changes. A missing-response warning inside a stopped reply is hidden, and
  the stopped notice shows under the reply in its place. Once its run has
  ended, a stopped reply with no content shows the notice alone, where the
  message view rendered nothing for a reply without content.
- `client/AssistantChat.js` keeps a list of the runs the owner stopped in the
  chat, by run id and turn id, and the message view reads it. Sending the next
  message clears the older stop marker but not this list. assistant-ui writes
  a cancelled run back over the live reply without the flag, so in the live
  chat the notice rests on this list. When both the stop and a reply know a
  run id, the run ids decide. Stop flags only the stopped run's own reply, and
  nothing when that reply is not among the chat's messages yet.
- `agent/run-manager.js` gives a run that a newer turn displaces in memory
  the reason `displaced`, which ends it with `done` and no reason, so its
  reply is not labeled.

These limits remain:

- A turn saved before this patch, such as the #50 turn, keeps no label. Its
  client copy has the status `incomplete` with the reason `cancelled`, which
  assistant-ui also sets for other cancels, so the patch does not read it as a
  Stop.
- A reply stopped before any content shows no footer, so it has no timestamp
  or Regenerate button. The owner sends the question again instead.
- A Stop sent before the client knows the run id goes to the turn route, which
  only writes a turn marker. The running run finds it on its next check, which
  can take about 3 seconds. The investigation measured 1,979 ms.
- A tool that ignores its signal keeps running after Stop, although the loop
  stops waiting for it at once.
- While a reloaded chat follows a run, the run's reply is not among the
  chat's messages, so a Stop labels nothing in the live chat. The saved turn
  carries the flag, and the notice shows after a reload.

Run `pnpm --dir packages/workbench test:native-chat`.
`tests/native-stop.test.ts` starts a turn through `startRun` and the agent
loop against a loopback fake OpenRouter and presses Stop with
`abortRunDurably(runId, "user")`, the run route's own call. While the model
streams its reply, the run must end and the model connection must close
within 500 ms, with one provider request and one terminal event, `done` with
reason `user`. In 13 runs on Zo the run ended 68 to 206 ms and the connection
closed 85 to 216 ms after Stop, most of it while the engine's AI SDK stream
settled, and the time grows with host load. During a tool step that honors
its signal, the signal must fire within 50 ms and the run must end within
500 ms. In the same runs they took 0 to 1 ms and 2 to 8 ms. The saved turn
must keep its text or its tool call and set `userStopped`, and a client save
of a heavier copy without the flag must keep the flag and the client's
content. A later run that finishes the same turn must drop the flag, and a
client copy of that run must not take it. A run that a newer turn displaces
must end with `done` and no reason and save no flag. A Stop while OpenRouter
sends only its keep-alive comments must end the run within 500 ms, and the
saved turn must hold no content and set `userStopped`. A client save of the
empty cancelled copy after the server's save, and of the flagged copy before
it, must keep the question and the stopped reply, and the next request's
history must leave the empty reply out. Each test that waits for
a run to end fails after 10 seconds when the run never ends. The script's
`--test-force-exit` then ends the file, which the run's own timers would keep
open. `tests/native-chat-components.test.mjs` renders Core's assistant
message for a reloaded thread with two stopped replies that have text and a
finished reply between them, and the notice must show under both stopped
replies only. A stopped reply that holds a missing-response warning must show
the notice instead of the warning. The test also mounts Core's whole chat
against a fake chat server. After a Stop on a live reply with text and the
next message, the notice must stay under the stopped reply. After a Stop
while the chat follows a run, the previous finished reply must stay
unlabeled. The test builds a thread whose second turn the owner stopped before
any content, with Core's builder and client-save merge, and reloads it in the
whole chat. The earlier turn and the question must show, followed by the
notice. On the first patch for #106 the timing cases passed and the label
cases failed, and with only its first and third changes the client save case
still failed. On the patch before these review fixes, the live reply, the
reply with the warning, the finished reply before a followed run, the later
run in the same turn, and the displaced run failed. On the patch before the
Codex review fixes, the turn stopped before any content was not saved, both
client saves kept only the question, and the reload showed no notice. A patch
without the load change, or without the view change, still showed no notice
after the reload.

Upstream could take these changes as they are. Remove this part of the patch
when an upstream release labels every stopped reply after a reload and passes
the same tests.

## In-process Run now

Issue #51 changes how Core starts Automations > Manage > Run now.
`queueAutomationRunNow` in `dist/jobs/run-now.js` writes a `running` history
row and then sends an HTTP request back to the app's own process-run route. In
production, that self-dispatch needs an app URL and an `A2A_SECRET` to sign the
request. The packaged app has no app URL in local mode and no `A2A_SECRET` in
hosted mode. Every Run now click therefore failed and left an unclaimed
`running` row. The 30-second queued-run sweep then retried that row forever
with "Could not redeliver queued run". Scheduled runs were not affected,
because the in-process recurring-jobs timer starts them.

`run-now.js` now exports `setInProcessAutomationRunner`. When a runner is
registered, Run now calls it without waiting for the run and returns its
receipt. Without a runner, Core keeps the self-dispatch, so development,
Netlify, and other serverless hosts behave as before. `agent-chat-plugin.js`
lifts the process-run route's worker into `runQueuedAutomationRun`. It
registers that function only in the branch that starts the in-process
recurring-jobs timer. The route and the runner both reach
`runQueuedAutomation`, whose claim in `run-history.js` lets only one delivery
of a row run. A failed run is recorded on its row and logged once, by
`runQueuedAutomationRun`. It never becomes an unhandled rejection.

The plugin registers the runner with its `appId`. The runner takes only rows
of that app and legacy rows with no app, which are the rows
`runQueuedAutomation` accepts. Another app's rows that share the database keep
self-dispatch, and this process does not end them late.

The runner registers after several awaits in the plugin's init, but no Run now
can arrive before it. The plugin passes its init promise to `trackPluginInit`
with the `/_agent-native/actions`, agent-chat, A2A, and MCP paths, and the
readiness gate in `framework-request-handler.js` holds requests on those paths
until that promise settles. In a live check on Zo, a Run now sent the moment
the restarted server accepted a connection returned HTTP 200 and ran in
process. That check cannot tell the gate from an init that had already
finished.

With a runner registered, the sweep passes a queued row of the runner's app
to the runner only while the row is younger than the claim lease. The lease
is 1.5 times the background run's hard timeout: 15 minutes by default, or 1.5
times `AGENT_BACKGROUND_RUN_HARD_TIMEOUT_MS`. A queued row can therefore still
start up to the claim lease after the click. The sweep claims an older row and
ends it as an error instead of running it. Only a process with a registered
runner ends old rows, and only rows of its app. Elsewhere the sweep keeps
redelivering them. An unclaimed row gets the error code
`automation_run_not_started` and a message that says it did not start and why.
A row that a worker claimed and then lost keeps the interruption message.

That interruption message told desktop users that a serverless worker may have
timed out. It now reads "The run stopped before it recorded a result, for
example because the app quit or its worker restarted. No delivery was
confirmed." `run-history.js` owns the text and `scheduler.js` imports it.
History rows also report `claimedAt`.

Run `node --test packages/workbench/tests/automation-run-now.test.mjs`. The test
uses a disposable SQLite database with `NODE_ENV=production` and no app URL or
`A2A_SECRET`. It checks that Run now reaches a registered runner, that Run now
still fails without one, and that the sweep ends old rows instead of running
them. It also checks that another app's row is neither run nor ended, that a
failed run is not logged a second time, that a second delivery of a claimed
row returns `skipped` and leaves the row unchanged, and that a failure inside
the real `runQueuedAutomation` lands on the row as an error. A source pin
checks that the installed plugin registers the runner once, with its app id,
in the branch that starts the in-process timer, and that `trackPluginInit`
holds the actions and agent-chat paths.

Upstream can take this change without Vivary-specific edits for a process that
serves one app. It adds exports and changes behavior only on hosts that start
the in-process timer. A process holds one runner, so a process that mounts the
agent-chat plugin for two apps keeps only the last registration, and the other
app's Run now falls back to self-dispatch. Upstream would need one runner per
app for that case, and may prefer to pass the runner through the plugin options
instead of a module registry. Remove this part of the patch after an upstream
release passes the same test and a packaged Run now check.

## In-process webhook automations

Issue #113 makes webhook automations work in the packaged app, as the owner
decided on 2026-09-27. A call to `/_agent-native/automations/webhook/<token>`
is stored in `integration_pending_tasks`, and Core then sent the task to its own
process-task route over HTTP. That needs an app URL in local mode and an
`A2A_SECRET` in hosted mode, and the packaged app has neither. The caller still
got HTTP 202, the task never ran, and the retry sweep sent it again about every
90 seconds without end.

`integration-durable-dispatch.js` now exports
`setInProcessIntegrationTaskRunner(runner, { platforms, appId })`, a sibling of
the Run now registry. When a runner is registered for the task's platform,
`dispatchPendingIntegrationTask` records the dispatch as `in-process`, starts
the runner without waiting, and returns `in-process`. The webhook route and the
retry sweep both call that function, so both reach the runner. Without a
runner, Core keeps the self-dispatch.

The webhook branch of the process-task route is lifted into
`dist/integrations/automation-webhook-task.js`.
`runClaimedAutomationWebhookTask` runs a claimed task, marks it completed,
retryable, or failed, logs a failure, and dispatches the next queued call for
the same automation. The route and `runAutomationWebhookTaskInProcess` both use
it. The in-process runner claims the task first with `claimPendingTask`, so a
second delivery returns `skipped`. It leaves a task of another app that shares
the database pending, unclaimed, for that app's own process.

`agent-chat-plugin.js` registers the runner only where it starts the in-process
recurring-jobs timer, and only after `initTriggerDispatcher`, because the
dispatcher's dependencies are null before then. The plugin's `trackPluginInit`
paths now include `/_agent-native/automations/webhook`, so the readiness gate
holds a webhook call until the runner is registered.

The retry sweep reset a `processing` task after 5 minutes, while a background
run can last 10. An `in-process` task now gets the Run now claim lease as its
cutoff: 1.5 times `AGENT_BACKGROUND_RUN_HARD_TIMEOUT_MS`, 15 minutes by
default, and never less than the 5-minute default. A live run is not reset,
and a task whose process was killed mid-run is reset and delivered again
after the lease, about 15 minutes after its claim. A pending task, accepted
before a quit and never started, runs at the sweep's first pass at least 90
seconds after the quit. The first pass comes 10 seconds after startup and later
passes every 60 seconds, so for a start more than about 80 seconds after the
quit that is about 10 seconds after the start, and for a sooner start 70 to 130
seconds after it. A normal quit returns a task whose run it interrupted to
pending (see "Automation runs at quit"), so that task runs the same way. Either
way the call runs once to completion. A run cut off by a quit or a kill leaves its history row reading
that the run stopped before it recorded a result, so one call can show two
history rows. The rerun starts from the
beginning, so it can repeat a local step the cut-off run already took, such as
a memory write. Until the rerun, later calls for the same automation wait
behind it, because tasks of one automation run in order. A prompt reset at
startup is not safe here: the automation's own "running" status also holds a
rerun back until the hard timeout passes, and a second server on the same data
folder could still own the claim.

A pending task older than 24 hours is expired instead of run, so a build that
starts after a long gap, or after an older build left calls pending, does not
replay old payloads. The sweep fails the task and writes an errored history row
with the code `automation_webhook_expired`. An automation with 20 calls waiting
or running answers new calls with HTTP 429 and `Retry-After: 60`, so a caller in
a loop cannot queue unlimited runs. A repeated event id still gets its 200
duplicate. The count is not atomic with the insert, so the cap can pass by a
call or two. The registry's optional `acceptsTask`, `expireTask`, and
`maxTaskAgeMs` carry the app check and the expiry to the sweep, which also
leaves another app's task untouched instead of moving its `updated_at`. Those
untouched rows stay first in the sweep's `updated_at` order, so when a full
page held any, the sweep reads the next page, up to 10 pages a pass. The expiry
fails a task only if its `updated_at` still matches what the sweep read, so a
task claimed in between runs instead of expiring.

`dispatchAutomationWebhookTask` in `triggers/dispatcher.js` required a stored
API key for the active engine setting before every webhook run. Scheduled runs
have no such check. The key feeds only the condition classifier, so the check
now applies only to an automation with a condition. Before, a webhook run
failed with "No API key is available for this automation." for an owner whose
key came from the launch environment under another engine, a Builder gateway,
or a keyless local model. Event automations follow the same rule, described
in "Event automation conditions" below.

The condition classifier calls Anthropic's API directly with a small Claude
model, whatever provider runs the automation, and it sends the webhook payload
there. It now takes only an Anthropic key, from the owner's settings or the
launch environment. Before, it took the active provider's key, so an
OpenRouter key was sent to Anthropic, rejected, and the call skipped without a
word. Without an Anthropic key, or when Anthropic rejects it with 401 or 403,
the call fails at once instead of retrying three times. The automation's
history gets an errored row, with the code `automation_condition_key_missing`
or `automation_condition_key_rejected` and a message that names the cause, and
its last status reads as an error. A network error or other answer is retried
as before. A call that fails all three attempts for another reason also gets an
errored history row, `automation_webhook_failed`. Defining a condition is not
refused, so an owner without an Anthropic key learns of the problem from the
first call's history row.

The Automations details dialog showed only the path. `AgentJobsTab.js` now
shows the full URL with the page's origin, from `automationWebhookUrl` in
`client/integrations/webhook-url.js`, and a "Who can call it" line. The page
origin cannot tell a local server from an owner-only proxy, so
`dist/shared/automation-webhook-reach.js` holds the reach that the host sets,
and the page config carries it to the browser, like the Builder offers switch.
Vivary's `server/plugins/00-webhook-reach.ts` sets it from the access mode.
Local mode reads "Reachable only from this computer while Vivary is open."
Private-proxy mode reads "Reachable only through your private Zo access."
Hosted mode reads "Anyone with this URL can start this automation." Without a
host setting, `isLoopbackWebhookUrl` picks the local or the public wording,
because `isNonPublicWebhookUrl` also counts LAN and plain HTTP hosts, which
other computers can reach.

The token is an app secret. Credential redaction holds every stored secret, so
the token becomes a placeholder in tool results, threads, logs, and run events.
The agent therefore cannot show the URL, and the owner copies it from the
details dialog. The payload still reaches the run fenced as untrusted data, and
the run gets the local-only surface described below.

Run `node --test packages/workbench/tests/automation-webhook.test.mjs`. It uses
a disposable SQLite database with `NODE_ENV=production`, no app URL,
`A2A_SECRET`, or provider key, a fake engine, and Core's automations handler on
a loopback port. It checks that an accepted call runs once with one history
row and its thread, that a wrong token gets 404 and queues nothing, that a
repeated event id runs once and gets a 200 duplicate, that a task left pending
by a quit runs once through the sweep, that a 6-minute-old `in-process` task is
not reset while one past the lease is recovered and runs once, that a claimed
task is skipped, that another app's task stays pending, that a condition still
needs a key, the URL helpers, and a source pin on the registration. It failed
10 of 10 on the previous patch. Review fixes add cases for a condition with only
an OpenRouter key and one whose Anthropic key is rejected, each failing at once
with an errored history row and a stubbed Anthropic endpoint, a 25-hour-old
call expired without a run, the 429 cap with its duplicate answer, another
app's task left untouched by the sweep, and the reach in the page config. Those
7 cases fail on the first version of this patch.

A live check on Zo ran `bin/start.mjs` in local mode with a fake Builder
gateway, no stored provider key, and a 40-second hard timeout. A call to a new
webhook automation got 202 and ran once, with one history row and its thread.
Its model request carried the fenced payload and the 11-tool local-only
surface. The same event id got a 200 duplicate and no run, and a wrong token got
404. A call whose run was cut off by stopping the server ran once more after the
restart, when the sweep passed the 5-minute floor, and its first history row
reads as interrupted. The token appeared in no server output, provider log, or
data file.

Upstream could take the registry as it is, because nothing changes until a
host registers a runner. The same limits as Run now apply: one runner per
process.

## Event automation conditions

Issue #135. An event automation with a condition had the defect that #113
fixed for webhook calls. `handleEvent` in `triggers/dispatcher.js` checked the
condition with `getOwnerActiveApiKey`, the key of whatever provider the
`agent-engine` setting names. With OpenRouter active, the OpenRouter key went
to Anthropic's API, Anthropic rejected it, and the event was skipped with no
reason. The same lookup refused every event automation with "No API key is
available for this automation" when the active provider had no stored key,
although the key feeds only the condition check.

`handleEvent` now applies the webhook rule. It looks up a key only for an
automation with a condition, and only an Anthropic key, from the owner's
settings or the launch environment. An automation without a condition starts
its run, which resolves its engine and credential as a scheduled run does.
Without an Anthropic key, the event starts no run and no request reaches
Anthropic. When Anthropic rejects the key with 401 or 403, the event starts no
run either. In both cases the automation's history gets an errored row with the
code `automation_condition_key_missing` or `automation_condition_key_rejected`
and a message that names the cause and ends with "The event did not start a
run.", and its last status reads as an error. Each such event adds its own row,
as each refused webhook call does, so a frequent event such as
`agent.turn.completed` can add many. Another failure of the check, such as a
network error, is logged and still records a plain skip with no history row,
as before, because an event has no queue to retry it from.

A refused event records its history row and last status but emits no
`automation.run.finished`, because nothing ran. That event's registered
description says it fires after a run records a terminal status.
`finishAutomationRun` takes `{ emitFinished: false }` for this, and
`recordAutomationFailure` passes it only from `handleEvent`. Without it, an
automation subscribed to `automation.run.finished`, with a condition and no
Anthropic key, refused the event, wrote its row, received the event that row
emitted, and refused again without end. Two such automations retriggered each
other, and a rejected key looped with one Anthropic call per turn. The local
SQLite driver answers synchronously, so the loop ran on microtasks alone, and
in the test no timer fired until the process was killed. A webhook refusal
still emits the event, because an external call starts each one, so it cannot
loop. The section "Event automation loops" says which finished runs emit it.

`conditionKeyMissingMessage` and `conditionKeyRejectedMessage` build the
wording for both triggers, and the webhook messages are unchanged.
`recordAutomationWebhookFailure` is now `recordAutomationFailure`. It takes the
automation's owner, path, and resource id, which a queued webhook payload and
an event's resource both supply, and `integrations/automation-webhook-task.js`
calls it by the new name.

Run `node --test packages/workbench/tests/automation-event-condition.test.mjs`.
It uses a disposable SQLite database with `NODE_ENV=production`, a fake
engine, random fake keys in the environment, and a stub for Anthropic's API
that accepts only the Anthropic key. It emits each automation's event through
Core's event bus. With OpenRouter active and only an OpenRouter key, nothing
reaches Anthropic and the history gets an `automation_condition_key_missing`
row. A rejected Anthropic key gets an `automation_condition_key_rejected` row
and no run. With both keys and OpenRouter active, only the Anthropic key
reaches Anthropic and the run starts. An automation without a condition runs
with no stored key. These four cases failed on the previous patch. Two more
cases emit one `automation.run.finished` for another automation's path. One
subscribed automation with a condition and no Anthropic key gets exactly one
refusal row and sends nothing to Anthropic, and two such automations get one
row each. A listener drops every listener for that event after 50 events, so a
loop fails the case instead of hanging it. On the first version of this fix,
each automation wrote 50 rows.

Upstream could take this change as it is. Remove it when an upstream release
checks event conditions with an Anthropic key only, records a missing or
rejected key in the automation's history, and passes the same test.

## Event automation loops

Issue #110. Every finished automation run emitted `automation.run.finished`,
and the trigger dispatcher starts each enabled event automation subscribed to
that event. The only guard skipped an automation whose last status still read
"running". That guard stops an overlap, not a sequential loop. A
self-subscribed automation started again from its own finished run whenever
its earlier run had settled first. Two subscribed automations traded runs
without end, whether their runs succeeded, failed, or failed with
`missing_credentials` for want of a provider key. The #135 change covered only
refused conditions.

Two rules now hold.

A run that a bus event started finishes silently. `dispatchAgentic` in
`triggers/dispatcher.js` takes a `startedBy` value, and both of its callers
pass one. `handleEvent` passes `"event"`, and `dispatchAutomationWebhookTask`
passes `"webhook"`. On every dispatch, `dispatchAgenticRun` gives the runner
`emitFinished: startedBy === "webhook"`. The file is plain JavaScript, so
nothing checks the value, and a missing value is silent, which fails toward no
loop. `jobs/background-automation-runner.js` takes the new `emitFinished`
option and passes it to `finishAutomationRun` on the success path and on the
error and interrupted path. Unset emits, so the scheduler and Run now still
emit. Remote execution never calls the runner. `jobs/remote-execution.js`
finishes its rows with `finishAutomationRun` and no option, so they emit too.

For an automation created through the service, every `automation.run.finished`
now comes from a run that a schedule, Run now, or a webhook call started, or
from a refused, failed, or expired webhook call. That includes a scheduled run
on a paired execution host. `recordAutomationFailure` records each refused,
failed, or expired call as an errored row, and that row emits as before. The
restart paragraph below names the exception for a hand-written automation
file. No cycle of runs inside Vivary can pass through that event, whatever
other event closes the cycle. The rule closes the cycle because a run cannot
start a scheduled, Run now, or webhook run, which the section "Local-only
automation runs" enforces. In a run, `manage-automations` refuses `run-now`,
`fire-test`, and every change to an automation, `manage-jobs` and `resources`
refuse writes under `jobs/`, and no web tool exists that could call a webhook
URL. The rule covers runs that any event started, not only those that
`automation.run.finished` started. A run can send an inbox notification, and
an automation on `notification.sent` would otherwise restart the first
automation through its own finish.

An automation never starts from its own run. `handleEvent` skips an
`automation.run.finished` event whose payload names the subscriber's path and
the owner on the subscriber's history rows. `isOwnAutomationRun` derives that
owner with `automationHistoryOwner` in `jobs/run-history.js`, so an
organization automation does not take its creator's personal automation at the
same path for itself. The background runner, remote execution, and
`recordAutomationFailure` in `triggers/dispatcher.js` record their history
owners with that function. Run now writes its queued row in `jobs/run-now.js`
with the automation's resource owner instead, and that owner equals the
history owner for every automation Run now can target. Run now looks a
personal automation up under the caller's email, and `automationHistoryOwner`
returns a personal automation's resource owner unchanged, because its
execution identity carries no organization. It looks an organization
automation up under `organizationResourceOwner(orgId)`, which is the owner
`automationHistoryOwner` returns for that organization. It never looks under
`__shared__`, so a legacy shared automation cannot be its target.

One limit follows from the shared history owner. `manage-jobs` creates a
shared job by default, and a shared job with no organization records its
history under its creator. That creator's personal event automation at the
same path takes the shared job's finished runs for its own and skips them.
Their history rows already collided the same way before this change.

The check runs after the identity and owner checks and before the condition,
so a skipped event costs no classifier call. For an event automation created
through the service, which has no schedule, its only own runs are Run now
runs. A Run now finish often meets the "running" guard first, because the row
emits before the scheduler records the automation's last status. The check
covers the rest, such as a queued Run now row that ends late without running.

A skipped event writes no history row, no last status, and no
`recordTriggerSkip`. A skip record would write "skipped" over the status of
the run that just finished. A silent finish is not a skip. It records its
history row and the automation's last status as before, and leaves out only
the event.

The silent finish holds across a restart for an event automation created
through the service, which the Settings page and the agent's
`manage-automations` action both use, because a row that an event started has
no other finisher. `automations/service.js` gives every event automation an
empty schedule, and an update cannot add one. Execution hosts take only
scheduled automations. The stale-row sweep in `jobs/scheduler.js` skips
automations without a schedule. `listUnclaimedAutomationRuns` reads only rows
that Run now queued. So the runner and `recordAutomationFailure` are the only
finishers of such a row. A row that a crash leaves running reads as
interrupted and emits nothing. The scheduler checks `enabled` and `schedule`,
not the trigger type. So a hand-written `jobs/` file with `triggerType: event`
and a schedule is both scheduled and event-triggered. After a crash, the
stale-row sweep finishes that automation's latest running row with an emit,
even when an event started the row. That is one event for each stale row, not
a loop.

The owner sees each real run in history with its own status. After one
scheduled run with two subscribed automations, each subscriber shows one run.
An automation on `automation.run.finished` no longer hears about runs that
events started, including their failures. Settings still shows those failures.
The registered description of `automation.run.finished`, which the agent reads
before it defines an automation, now says which runs fire it and that an
automation is never started by its own runs.

Two kinds of loop stay open. The silent finish covers only the event at the
end of a run, so any event that a run emits while it runs can still carry a
loop. Today those events are `notification.sent`, which an inbox notification
emits, and `run.progress.started` and `run.progress.updated`, which
`manage-progress` emits. Two automations on one of them can alternate, for
example two automations on `notification.sent` whose runs each send an inbox
notification. That loop has no `automation.run.finished` edge, and closing it
needs causation carried on the events a run emits. A program outside Vivary
can also close a loop. If it calls a webhook automation in response to a reply
that a run delivered, each call starts a root run, and that run emits. One
visibility gap stays open too. An organization automation's finished run
reaches no subscriber, because its event owner is the organization owner and
`automationMatchesEventOwner` compares the creator's email. This change adds
no column, migration, or payload field. If a second subscriber of
`automation.run.finished` or a "started by" history view arrives, store the
origin on the row with a named migration and add an optional payload key.

Run `node --test packages/workbench/tests/automation-event-loop.test.mjs`. It
uses a disposable SQLite database, a fake engine, and a closed network. It
clears 16 names that Core's engine code read on 2026-10-01. Three decide which
engines a run can use: `AGENT_ENGINE`, `AGENT_BUILT_IN_ENGINES`, and
`AGENT_NATIVE_BUILD_ENGINE_PACKAGES`. The others are the seven provider key
names in `agent/engine/provider-env-vars.js`, the four Builder credential
names in `agent/engine/builtin.js`, and the `OLLAMA_BASE_URL` and
`OPENAI_BASE_URL` endpoints. A listener counts `automation.run.finished`
events and drops every listener after 30, so a loop fails a case instead of
hanging it. A self-subscribed automation run twice with Run now, through the
in-process runner, gets no extra run. A queued Run now row of a
self-subscribed automation that ends late starts nothing. One outside run
starts each of two subscribed automations once, whether they succeed, fail, or
lack a credential, and only the outside run emits the event. A run that
another event started emits nothing and starts no subscriber. A
self-subscribed automation with a condition and no Anthropic key skips its own
finished runs with no refusal and no request. A webhook call, queued as the
route queues it and run by the in-process runner, starts a subscriber once,
and that subscriber's finish emits nothing. Unit cases check
`isOwnAutomationRun` for a personal, an organization, and a legacy
`__shared__` automation. Removing each part of the fix fails at least one
case. Without the own-run check, the late Run now case and the condition case
fail. The two Run now runs still pass then, because on SQLite the "running"
guard drops their finishes, and they fail when both are gone.

Upstream could take this change as it is. Remove it when an upstream release
keeps runs that events started and an automation's own runs from starting
`automation.run.finished` subscribers, and passes the same test.

## Builder.io offers in local mode

Issue #104. The owner decided on 2026-09-27 that the local app offers no
Builder.io: no free credits and no Connect Builder.io button. Owners use their
own provider keys. Self-hosted mode keeps Core's offers for now. Core has no
option for this, so the patch adds one switch.

`dist/shared/builder-offers.js` exports `setBuilderOffersEnabled` and
`builderOffersEnabled`, and the `./server` entry re-exports both. Offers are on
unless a host turns them off. The server keeps the value on `globalThis`,
because Core can load twice. `resolvePublicAppOriginConfig` adds
`builderOffers: false` to the page config that every document carries, so the
browser reads the same value without a request. It is the same for every
visitor, which the cached page shell requires. Each surface reads the switch
when it renders or builds text, never at module load, because the host sets it
after Core loads. Vivary's `server/plugins/00-builder-offers.ts` turns the
offers off when `VIVARY_ACCESS_MODE` is `local`.

With the switch off:

- The chat's missing-access card reads "Connect AI. Add your own provider
  keys." and shows the provider-key form at once, with no Builder.io button
  and no toggle. A rejected Builder credential shows the same key form instead
  of Reconnect Builder.io.
- `BuilderConnectPopover` and `BuilderConnectCard` render nothing, which
  removes every connect button built on them, in the chat, Settings,
  Connections, and voice setup. `FileStorageSetupCard` keeps its "Use custom
  storage keys" path, which the upload instructions send the model to, and
  drops only its Builder part.
- Settings drops the Builder.io card from the LLM, hosting, database, uploads,
  and authentication rows, and hides Browser Automation and Background Agent,
  which hold only that card. The LLM summary reads "Add your own provider
  keys." Voice settings drop the Builder Gemini option and the Builder wording.
- First-run onboarding goes from the intro to the key form.
- The code-access panel drops its "Use Builder" link. The code-required
  dialog drops its Builder.io agent and connect options and keeps Desktop.
- The remaining Builder wording goes too: the `FeatureNotConfiguredError`
  default message, the background agent and file upload errors in
  `core-routes-plugin.js`, and the editor image upload error.
- Core's composer adapters pass `builder.offersEnabled` to Toolkit. The
  Toolkit patch adds it with a default of true. The model picker keeps its
  add-keys action and drops Connect Builder.io, and voice mode setup drops its
  Builder.io button and says to add your own keys.
- The server surfaces are listed in the next paragraph.

The model and the server drop Builder too. `connect-builder` and
`activate-browser` are not registered, and `get-framework-context` loses its
`builder` and `browser` topics. The framework prompts replace the Builder code
handoff with a sentence that source edits belong to a coding agent, and leave
Builder tools out of the plan-mode list. The web search, upload-image, and
file-storage card descriptions name only provider keys and custom storage.
Missing-provider, web search, upload, transcription, and realtime voice errors
point to the owner's own keys. `llmMissingCredentialsMessage()` returns "No LLM
provider is connected. Add your own provider key in Settings.", which keeps the
prefix that the chat's recovery card matches. Its callers in the run store, the
production agent, the engines, and the run manager call it when they report
the error. Core builds its tool list and prompts when the agent-chat plugin
starts, so Vivary's plugin sets the switch when its module loads.

Run `node --test packages/workbench/tests/builder-offers.test.mjs
packages/workbench/tests/builder-offers-component.test.mjs`. The component test
bundles Core's `run-recovery.js` and `FileStorageSetupCard.js` with esbuild,
with Core's real provider-key form, and renders them with the local page
config. The missing-access card shows no Builder text or button and shows the
key field. The storage card shows its custom-key path and no Builder text.
Control renders with offers on show Builder text. The unit test checks the switch, the page config, and each server
surface with the switch off and on, and pins the client and Toolkit call sites.

Upstream could take the switch as an option, because nothing changes until a
host turns it off. Remove this part of the patch only when an upstream release
offers the same option and passes the same tests.

## Local-only automation runs

The owner decided on 2026-09-26 (issue #51) that unattended automation runs are
local by default. That covers scheduled runs, event and webhook triggers, and Run now.
Issue #108 adds exact owner approval for explicitly declared configured MCP calls.
Interactive chats keep their existing registry. Automation threads cannot enter it.

Before this change, every run got the background surface that
`getBackgroundActionEntries` in `dist/server/agent-chat-plugin.js` builds. It
held the template actions, `web-request`, `web-search`, `core-send-email`,
`call-agent`, the 36 add-on actions, and the MCP tools an automation listed.
Nobody is present during a run to approve or deny a step, so a model-chosen
outward call ran unreviewed.

`dist/jobs/unattended-surface.js` is new. Its `restrictActionsForUnattendedRun`
keeps 12 tools and wraps each one with a refusal check:

- `resources`, `save-memory`, `delete-memory`, `chat-history`
- `manage-progress`, `manage-notifications`, `manage-jobs`, `manage-automations`
- `docs-search`, `framework-search`, `source-search`, `get-framework-context`

The four lookups read files bundled with Core only. The list is an allowlist,
not a denylist, so a tool that a later Core release adds stays out of runs until
someone reviews it. Both background entry points, the recurring-jobs scheduler
and the event and webhook dispatcher, use `getBackgroundActionEntries`, and Run
now reuses the scheduler's dependencies.

Some kept tools refuse part of their work in a run:

- `manage-jobs` lists only. Create, update, and delete are refused.
- `manage-automations` runs `list`, `list-events`, and `list-hosts` only.
  `define`, `update`, `delete`, `fire-test`, and `run-now` are refused.
  `fire-test` would emit `test.event.fired`, which fires event automations. This
  replaces the narrower "an automation cannot run another automation" check.
- `resources` refuses `read`, `effective`, `write`, `promote`, and `delete` on
  the paths Core reads as configuration. The scheduler and the dispatcher load automations from `jobs/`.
  Custom agent profiles under `agents/` set a model and tools. Remote agent
  manifests under `remote-agents/`, and legacy `agents/*.json`, hold the URLs
  that `call-agent` reaches from an interactive chat. In local file mode, the
  workspace control files `agent-native.json`, `mcp.config.json`, and
  `.mcp.json` set the data mode and the MCP servers. The check ignores case and
  a leading slash. Other resources stay writable, including `AGENTS.md`,
  `instructions/`, `skills/`, `LEARNINGS.md`, and `memory/` in the run owner's
  personal scope. Core loads those into prompts as text, so a run's write to
  one of them waits for the owner's review, as "Automation-written
  instruction files" below describes.
- `manage-notifications` sends to the in-app inbox only. The webhook, Slack, and
  email channels take a model-supplied `webhookUrl` or `emailRecipients`.
- `chat-history` refuses only `open`, which drives the app window. Search,
  rename, pin, unpin, and archive stay allowed because they change local
  thread metadata only.
- `save-memory` and `delete-memory` refuse a name that holds `/`, `\`, or `..`,
  because the scripts build `memory/<name>.md` from the name as given.
- Reads count too. `mcp.config.json`, `.mcp.json`, `agents/`, and
  `remote-agents/` can hold server headers or tokens that a run could copy into
  memory.

The wrapper forces `caller: "automation"` into the tool context. `resources`,
`chat-history`, `save-memory`, `delete-memory`, `manage-jobs`,
`manage-automations`, and `manage-notifications` also check that caller
themselves (`server/agent-chat/script-entries.js`, `jobs/tools.js`,
`triggers/actions.js`, and `notifications/actions.js`), so a call that reaches
them some other way gets the same limits. `docs-search`, `framework-search`,
and `source-search` rely on the run surface. On any other path, the CLI
bridge's declared-name check refuses an unsafe name with its own text.
`manage-progress` and `get-framework-context` have no limit beyond the run
surface's argument checks.

An automation may list exact configured `mcpTools`. Each declared tool must be
available in the current Native MCP registry and visible to this owner and org.
An unavailable or hidden declaration refuses the run before model work, with
`automation_mcp_tools_refused`. The plugin adds only those entries to the default
twelve. Each MCP entry has mandatory approval and `allowPersistentApproval: false`.
The existing local refusal checks stay in place. There is no interactive registry
fallback or tool search. The legacy surface without a configured manager still
refuses every MCP declaration. `backgroundMcpTools` does not grant a capability.

A review of the first version found a bypass. The CLI bridge in
`server/agent-chat/script-entries.js` turned each argument into a
`--name value` pair, and `scripts/parse-args.js` reads `--name=value` and lets
a later flag win. A run could call `resources` with `path: "notes/ok.md"` and
an extra argument named `path=jobs/x.md`. The refusal checked `notes/ok.md`,
and the write script received `jobs/x.md`. A value that starts with `--` could
do the same. The run surface now refuses an argument that the tool's input
schema does not declare, and every kept tool refuses an argument name that
holds `=` or starts with `-`. The bridge itself now passes each value inline as
`--name=value` and refuses an undeclared name for every caller, chats included,
as "CLI bridge arguments" below describes.

The run surface is built from Core's own tool groups only, so a template or
tool action that reuses a kept name cannot replace Core's checked entry.

A run's system prompt is the framework prompt filtered by
`filterFrameworkPromptToSurface` to the 12 tools, plus a two-line note that the
run has restricted local tools and gates every declared MCP call. It no longer
carries the template action list, so the model
is not told about tools it lacks. Its resources block also leaves out the
workspace apps list, which tells the model to use `call-agent`. Both dependency
blocks drop
`getInitialToolNames`, so all 12 tools load up front and no `tool-search` is
attached.

The Run now confirmation, Automations summary, tool labels and the automation
and recurring-job tool descriptions explain the same restricted surface.
`mcpTools` accepts exact configured names. Listing a tool does not approve a call.
Settings automation history owns inspection and the decision described below.

Two outward paths stay, and the owner configures both:

- Reply delivery. When an automation has `deliveryPlatform` and
  `deliveryDestination`, `background-automation-runner.js` sends the final
  reply there.
- A paired execution host. When an automation has `executionHostId`,
  `scheduler.js` queues the run on that host instead of running it here.

Only an interactive chat or the app can set either field, and a run can no
longer change automations. An inbox notification still emits
`notification.sent`, which can fire an event automation the owner defined.
That run keeps the same restrictions too.

Run `node --test packages/workbench/tests/automation-local-only.test.mjs`. It
uses a disposable SQLite database. It checks the exact 12 keys against stand-ins
for every dropped tool, a future tool, and an MCP tool. It also checks the MCP
refusal, the `manage-automations`, `manage-jobs`, `resources`, and
`chat-history` refusals with no `jobs/` write, `fire-test` emitting nothing,
notifications reaching the inbox and no registered channel, and a source pin on
the plugin. Later cases cover the crafted argument names on `resources`,
`save-memory`, `delete-memory`, and `manage-automations`, a value that starts
with `--`, `JOBS/` and `./jobs/` paths, unsafe memory names, and a read of
`mcp.config.json`, refused for a run and allowed for a chat. The resources
cases read back the stored path and content.

A live check on Zo ran `bin/start.mjs` in local mode against a fake Builder
gateway, with no real provider key. The Run now request offered 11 tools, the
allowlist without `source-search`, which Core registers only when its source
corpus is bundled. The run's scripted `web-request` call got "Unknown tool"
and never reached the fake server. Its `manage-automations` define and its
`jobs/` write were refused, and no automation was added. Run now on an
automation that lists an MCP tool ended with the named error and made no model
request. An ordinary chat still received `web-request`, `call-agent`, and
`resources`, and defined that MCP automation.

Upstream could take this as an opt-in plugin option, because its hosted
templates rely on email, web, and MCP tools in automations. It would also need
a way to approve an MCP step before a run starts. Remove this part of the patch
only when an upstream release offers a local-only mode that passes the same
test.

## CLI bridge arguments

Issue #111. Core's CLI bridge, `wrapCliScript` in
`server/agent-chat/script-entries.js`, turned each argument of a chat's tool
call into a `--name value` pair. The scripts read argv with `parseArgs` in
`scripts/parse-args.js`, which reads a value that starts with `--` as the next
flag, splits `--name=value` at the first `=`, and lets a later flag win. A
chat's `resources` write of Markdown front matter stored `true`. An argument
named `path=notes/x.md` replaced the `path` that the dispatcher had checked. A
`db-query` with `limit` set to `--db=<file>` read another SQLite file past the
`allowedArgs` check that refused a `db` name, and in plan mode it created that
file. Plan mode approved a read of one resource while the script read another.
Issue #51 had fixed this for automation runs only.

Two rules now hold for every caller of the bridge: a chat, A2A, a sub-agent,
and an automation run.

One encoding. `formatArgs` in `scripts/parse-args.js` turns an object into
argv, one `--name=value` token per argument. A string passes as given, an
object or array as JSON, and any other value through `String`. `null` and
`undefined` emit nothing, as an absent argument does. It throws for a name that
`isUnsafeArgumentName` flags: one that holds `=`, starts with `-`, or is
`__proto__`, which `parseArgs` drops. Every token starts with `--`, and a safe
name holds no `=`, so `parseArgs` reads each token alone and splits it at the
`=` that `formatArgs` inserted. For an object with no unsafe name,
`parseArgs(formatArgs(a))` gives back `a` without its `null` and `undefined`
entries and with each value in that string form. Plan mode checks the object
that `run` receives, so it now approves the names and values that the script
reads, and `agent/production-agent.js` does not change. `isUnsafeArgumentName`
moved here from `jobs/unattended-surface.js`, which imports it, so the
automation refusal names `__proto__` too.

One name rule. A tool's input schema is its allowlist. `wrapCliScript` refuses
a name that its schema does not declare before the script runs. The `resources`
and `chat-history` dispatchers check their own schemas after their automation
check and before they pick a script. The `resources` write branch adds
`createdBy`, `scope`, `visibility`, and `threadId` after that check, so a chat
cannot set `created-by`, `createdBy`, or `threadId`. The refusal goes through
`fail()`, which gives it the error code `unknown_argument`. `runToolCall` in
`agent/production-agent.js` adds the tool name and appends the code, so a chat
model reads:

```text
Error running resources: Unknown argument "created-by". This tool takes only: action, path, content, scope, prefix, mime, format, visibility, includeAgentScratch. (errorCode: unknown_argument)
```

An unsafe name is never declared, so this check refuses it first, and the throw
in `formatArgs` is a backstop. `resources`, `chat-history`, `save-memory`, and
`delete-memory` check an automation caller before the bridge runs, through the
dispatchers' automation checks and `refuseForAutomationCaller`, so an
automation caller still gets the #51 text from them. The three lookups,
`docs-search`, `framework-search`, and `source-search`, rely on the run
surface, which refuses an undeclared or unsafe name with its own text before
the bridge sees it. A direct automation caller that skips the run surface gets
the bridge's `Unknown argument` text from a lookup. Nothing in Core or Vivary
makes that call.

`wrapCliScript` lost its automation-only branch and its `allowedArgs` option,
where `db-schema` and `db-query` listed their names. `db-exec` and `db-patch`,
which Vivary does not register, listed none, and they now refuse `db` too. The
dispatchers' inner entries became `cliScriptRunner` closures with no tool
object and no check of their own. Each dispatcher's schema moved to a module
constant, `resourcesParameters` or `chatHistoryParameters`, that the tool and
the check share. The registration lines keep the shapes that
`nativeFrameworkActions` in `tests/native-chat-project.test.ts` reads.

`framework-search` also reads an undeclared `query` alias. The alias serves
someone who runs the script from a shell, as
`pnpm action framework-search --query <text>`. The tool's schema declares
`pattern` only. So does the `framework-search` that `cli/agent.js` builds for
the terminal command `agent-native agent`, though that one does not refuse an
undeclared `query`, and this change leaves it alone. The script's help text,
which it prints when a call sets neither `pattern` nor `list`, lists `--query`.
A chat that reads it and tries `query` gets the refusal, which names `pattern`,
so the chat recovers in one more call. Core's comment above `allowedArgs` said
that some MCP hosts send undeclared keys. Such a host now gets a refusal.
Vivary turns MCP off.

The extensions SQL route uses the same encoder. `handleSqlQuery` and
`handleSqlExec` in `extensions/routes.js` answer `sql/query` and `sql/exec`
under `/_agent-native/extensions` and its `/tools` alias for any signed-in
session. They built `--name value` pairs too, so a body `limit` of
`--db=<file>` parsed as `limit: "true"` and `db: "<file>"`, and the query
script read that file. They keep every check in its order, including the
`args must be an array` refusal, and then build argv with `formatArgs` from
fixed names: `sql`, `format`, `limit` for a query, and `args`. A `limit` of
`--db=<file>` now reaches the script as the `limit` value, and the query runs
against the app database. The handlers are not exported and sit behind the
session check, so CI pins the route by its source: each handler makes exactly
one `formatArgs({` call and holds no `.push(` and no string literal, in any
quote style, that starts with `--`. A built-app journey on Zo checks the route
itself. Its run on 2026-10-02 posted `limit: "--db=<other.sqlite>"` to
`/_agent-native/extensions/sql/query` as the signed-in owner and got
`{"output": "Error: no such table: secret"}`.

Four other places build argv, and this change leaves them alone:

- `server/action-discovery.js` `wrapDefaultExport` wraps an action whose
  default export is a function. Every Vivary action uses `defineAction`, so
  none reaches it.
- `scripts/dev/index.js` builds the dev registry, which the packaged app never
  creates.
- `cli/agent.js` `cliArgsFromToolArgs` serves the terminal command
  `agent-native agent`.
- The dev shell fallback in `server/agent-chat-plugin.js` runs `pnpm action`
  through bash in dev mode only.

None of them is reachable in the packaged app. In dev mode a chat model does
call the dev registry's `db-query`, which keeps the two-token form, with values
it chose. That model already has `bash` there, so the bug adds no reach.
Upstream can swap each to `formatArgs`.

From the repository root, run:

```sh
node --test packages/workbench/tests/cli-bridge-arguments.test.mjs packages/workbench/tests/automation-local-only.test.mjs
pnpm --dir packages/workbench exec tsx --test tests/native-chat-project.test.ts
```

The first file uses a disposable SQLite database and calls the installed Core's
entries as a chat. It covers front matter, a value that reads like a flag,
declared values that differ from the path's defaults and that the stored row
keeps, a boolean that lists agent scratch files, six refused names on a write,
`db-query` with `limit` set to `--db=<file>` and with a `db` name, plan mode
with the result of each planned call, the round trip of `formatArgs` and
`parseArgs` over values and names that broke the old form, an undeclared name
on every script tool a chat can reach, the error code `unknown_argument` and
status 400 on the thrown refusal of a `resources` write and a `db-query` call,
a `chat-history` search, and a source pin on the bridge and the extensions SQL
route. Removing each part of the fix fails at least one case.

Remove this part of the patch only when an upstream release builds every
script's argv with one lossless encoder, refuses undeclared names at the tool
boundary, and passes `tests/cli-bridge-arguments.test.mjs`.

## Settings automation status

Issue #115. Settings > Agent > Automations is Core's page. Its Details dialog
showed LAST CHECKED as a dash while the scheduler checked every minute, and it
offered Open thread on some past runs, which did nothing in Vivary.

LAST CHECKED read the automation's `lastCheck` front matter field. The scheduler
writes that field only when an identity check skips the automation, and the
event and webhook dispatcher writes it only when it declines a call or an event,
so a healthy automation kept it empty. The scheduler records its own check in
`automation_scheduler_health`: every tick that holds the scheduler lease writes
the app's `<appId>:global` row before it scans. `list-automations.js` and
`list-recurring-jobs.js` now read that row once per call through
`getAutomationSchedulerHealth`. For an enabled entry with a valid schedule, they
report the later of its stored `lastCheck` and the row's `last_checked_at`.
Event, webhook, and paused entries keep their stored value, because the
scheduler does not check them. A heartbeat from before the entry's resource was
created, its `created_at`, does not count, so a new entry keeps its stored
value, usually empty, until the next check. Pausing and resuming keep the
created time, so a resumed automation shows the last check at once, although
that check read it while it was paused and skipped it. Checks run about once a
minute, so that value is at most about a minute older than the resume. The field
keeps its name and ISO format, so the client is unchanged. A heartbeat whose row
records an error in `last_error` is not a check, so the lists ignore it: a sweep
writes that error in its `finally` when its scan failed. The value is
informative only, so a failed read of the row is logged and each entry keeps its
stored value instead of failing the list. Only the lease holder writes the
heartbeat, so LAST CHECKED stops advancing while a process that died during its
scan still holds the lease, for up to 10 minutes. Since issue #139 it keeps
advancing while a scheduled run is in progress, because a sweep releases the
lease when its scan ends, before its runs start, and writes no heartbeat when
they end. See "Scheduler lease per scan".

Issue #141. The Details dialog showed the list entry captured when it opened,
and nothing refreshed the lists while the Automations tab stayed open, so LAST
CHECKED, NEXT RUN, LAST RUN, and LAST STATUS in Details could be minutes old.
The packaged check on the unpublished `9e921ca0` package saw this right after a
tick. `AgentJobsTab.js` now keeps the key of the open entry, its kind and
resource id, which is also its row key. Each render looks the key up in the
current lists, so Details shows what the lists hold now and closes when its
entry leaves them. An effect then clears the key, so the same entry coming
back does not reopen Details. A resource id is the primary key of the `resources` table,
so the key is unique across both scopes. Every Details control opens the dialog
through one function that also refetches the list that holds the entry, so
Details opens on current values. In `use-jobs.js`, `useRecurringJobs`,
`useAutomations`, and `useAutomationRuns` refetch every 30 seconds. The
scheduler heartbeat moves every 60 seconds, so LAST CHECKED in Details trails
it by at most about 30 seconds while the window is visible.
`useAutomationRuns` runs only while Details is open. The lists and Past runs
refresh on separate timers, so Past runs stays within 30 seconds of LAST RUN.
React Query skips an interval refetch while the page is hidden. The three
hooks set `refetchOnWindowFocus: true`, so a return to the page refetches data
older than its 5 second stale time. Core's house client turns that option off
because `useDbSync` refetches on its own, and Vivary does not mount
`useDbSync`. The three hooks also set `networkMode: "always"`, so they keep
fetching while the browser reports no network. That option also turns off
React Query's refetch on reconnect, so the hooks set `refetchOnReconnect:
true` to keep it. The desktop window's server runs on the same computer, and a
server that cannot be reached then fails and shows a refresh note instead of
pausing with no message. `useManageRecurringJob`, `useManageAutomation`, and
`useRunAutomationNow` set `networkMode: "always"` too, but only on a page
whose hostname is `localhost`, `127.0.0.1`, or `[::1]`, as the desktop
window's page (`http://127.0.0.1:<port>`) is. There, with no network, a pause,
resume, edit, delete, or Run now is sent at once instead of waiting for the
connection, and a server that cannot be reached fails it at once. A pause,
resume, edit, or delete then rolls its list back and shows its error in the
page's error line. Run now writes nothing before the answer, so it has nothing
to roll back, and shows its error in its dialog and in the page's error line.
A page opened from another device through browser access keeps React Query's
default for its changes. While that device reports no network, a change waits,
and React Query sends it when the network returns. Until then the change stays
pending, so every switch and control on the page stays disabled, and a
confirmed Run now keeps its dialog open, until the device is online and the
page is visible again. Dev behaved the same way before #141. A failed read
there still shows the refresh note. A failed refresh keeps the last answer. Past runs
keeps its list, and a section shows "Could not load all automations." only for
a list with no answer, the rule `useScheduledTriggerState` already follows.
The 30 second refresh also retries a list or a run history that never
answered. React Query clears its error while each retry runs. It also keeps
the query and its failures for five minutes, its default cache time, after
Details closes or the tab is left. So two helpers in `use-jobs.js` count a
query with no answer as failed once a fetch since it mounted has finished
(`isFetchedAfterMount`), and as loading before that. The sections and Past
runs both use them. Each keeps its load error during a retry instead of
showing "Loading…", and a list or Past runs reopened after a failed load shows
"Loading…" during its own fetch instead of the old error. A refresh that fails
after an answer shows a quiet note instead, from React Query's
`isRefetchError`, and the next successful refresh clears it. The section shows
"Could not refresh automations. The values shown may be out of date." Details
shows "Could not refresh. These values may be out of date." above its fields
when the list that holds its entry failed to refresh. Past runs shows "Could
not refresh run history." under its heading when its own refresh failed. A
refresh that keeps failing keeps the note up while the values age. A pause,
resume, edit, or delete from the page writes the list through its optimistic
update or its rollback, which clears the list's error, so its note hides until
the next refresh fails. That is about 30 seconds later, or about 90 seconds
when the server accepts requests and never answers, because Core's action
requests time out after 60 seconds. With the note shown, a LAST CHECKED far
older than 90 seconds is the last value Settings received, because the latest
refresh failed. Vivary's server may be down, unreachable, or failing. The
hooks run only while the Automations tab is mounted. While the tab is visible
it sends four list GETs every 30 seconds and a fifth while Details is open,
and each list GET reads the owner's job rows. A refresh that lands while a
pause, resume, edit, or delete is saving can show the old value until that
change's own refetch, one round trip later, with or without a network. For an
edit, Details can then show the old cron expression and timezone. The Edit,
Run now, and Delete dialogs still keep the entry from when they opened.

The Details dialog showed Open thread on a run with an error and a thread. The
control sent Core's `agent-chat:open-thread` window event, which only Core's
`MultiTabAssistantChat` handles, and Vivary does not mount it on Settings. The
run's thread also has no chat scope, and every Vivary history list shows only
threads of its own scope, so no page could open it. The owner decided on
2026-09-29 that run threads are not openable from Settings.
`AutomationDetailsDialog.js` no longer renders the control, and the desktop
guide says so.

Settings lists no next run for a paused automation, because both list actions
return none for a disabled entry. The stored value can be in the past, and the
agent's `manage-automations list` still returns it. The page offers schedule,
event, and webhook triggers, and both the packaged app and the hosted server
run all three in process, so that part of #115 needed no patch change.

Since issue #140, NEXT RUN in Details shows a wait instead of a date while a
lease or an unfinished run keeps the scheduler from acting on the automation
before its next run. It reads "After the current run finishes", "Scheduling
resumes after {{date}}, when an unfinished run times out", "Scheduling resumes
after {{date}}, when an interrupted schedule check times out", or, once that
time has passed, "Waiting for the next schedule check". An automation whose next
run falls after the wait keeps that time. For the first 90 seconds after a
scanner dies during its scan, its fresh lease reads as a live scan's, and
Details shows the next run. See "Settings next run during a scheduler wait".

Run `node --test packages/workbench/tests/automation-status.test.mjs`. It uses
a disposable SQLite database with `NODE_ENV=production`. It records a
heartbeat, then lists a scheduled automation, one whose recorded skip is later
than the heartbeat, an event automation, a paused automation, and two legacy
recurring jobs, and checks each LAST CHECKED value. Another app's heartbeat on
the same database does not count. It pins that a paused automation lists no
next run. It bundles the Details dialog with esbuild, renders it with a
successful, an interrupted, and an errored run, and checks that none offers
Open thread. The LAST CHECKED and Open thread cases failed on the previous
patch. A review round added three cases. A list on a fresh database, before
any heartbeat, keeps each stored value. A read that fails, because the health
table was moved away, is logged once per list, and both lists keep the stored
values. A heartbeat recorded with an error does not count, and the next good
check counts again. The last two failed on the patch before the fallback.
A fourth review round added a case: an automation and a legacy job created
after the heartbeat keep their stored value, and a resumed automation shows
the heartbeat. The first two failed on the patch before this round's fix. The
other fixtures are backdated an hour, so they predate the heartbeat.

Issue #141 added twenty-four cases to that file. They bundle Core's real
`AgentJobsTab.js`, `AutomationDetailsDialog.js`, and `use-jobs.js`, run the
hooks on React Query with a fake transport, and render the tab under linkedom.
An open Details dialog follows new list data. Opening Details fetches its list
again. A 30 second timer fetches both personal lists again, every recorded
interval is exactly 30 seconds, and none outlives the tab. Each of the three
Details controls, the Manage menu item, the hidden row button, and the View
details link, opens Details from closed on its automation and fetches the list
again. Opening Details on a personal recurring job, an organization recurring
job, and an organization automation fetches the list that holds each and no
other list, and shows that entry. The 30 second timer fetches the open
automation's past runs again. Details closes when its automation leaves the
list and stays closed when it returns. A personal and an organization
automation with one name keep Details on the organization one while another
entry moves ahead of it. Details closed with Close stays closed through the
timer, which fetches no past runs. A failed list refresh shows no load error,
keeps the row and the Details values, shows the section note and the Details
note but no Past runs note, and the next successful refresh clears both notes.
A failed refresh of each of the four lists shows the section note above that
section's rows and not in the other section, and the Details note of an open
organization automation only for its own list. Details on a personal and on
an organization recurring job shows the Details note above its fields when
that job list fails, and an automation's Details shows none when only the job
lists fail. A failed runs refresh keeps the runs listed, shows the Past runs
note under its heading and no Details note, and the next successful runs
refresh clears it. Each of the four lists, and Past runs, that fails its first
load shows its load error and no refresh note. A list that never loaded keeps
its load error and shows no "Loading…" while a timed retry is in flight and
after it fails, and lists its rows once a retry succeeds. Past runs that never
loaded does the same in an open Details dialog and lists the run once a retry
succeeds. A list reopened with the tab and Past runs reopened with Details,
each after a failed load, show "Loading…" and no load error while the reopen's
fetch is held, the load error when that fetch fails, and the rows or the run
when a later reopen's fetch succeeds. While the browser reports no network,
the timer still fetches all four lists and the runs, and failed fetches still
show the notes in both sections and in Details. On a page from `127.0.0.1`
with no network, a pause of a recurring job and of an automation is sent at
once, its switch is free again once the change settles, and a refresh keeps
the pause. A resume the server refuses rolls the switch back and shows its
error on the page. Run now sends its run and closes its dialog. A page from
`localhost` or `[::1]` sends a pause at once too. On a page from another
device with no network, a pause of a recurring job and of an automation and a
Run now are not sent, the switch shows the pause and stays disabled, and each
is sent once the network returns. When the network returns, each of the four
lists and the runs that went stale is fetched again. A hidden window skips the
timer, and a return to the window refetches each of the four lists and the
runs once they are stale. The first three failed on the patch before the fix.
Each of 80 mutations, one rule of the fix reverted or broken alone in the
installed Core, fails a named case. They cover the snapshot, the key's makeup,
each opener, the list each opener refetches and that it refetches no other,
closing, Past runs stopping after Close, the key clearing on departure, each
interval and its length, the refetch on return, the refetch on reconnect,
fetching in both scopes and sending each change hook's request while the
browser reports no network on a page from this computer, each loopback
hostname, each change hook waiting with no network on a page from another
device, the rollback and error line of a change refused with no network, both
failed-refresh rules, the load error staying and Loading staying off while a
list or Past runs that never loaded retries, Loading and no old load error
when a list or Past runs is reopened after a failed load, the section note for
each list and only in its own section, the Details note for its own list only,
a job's as well as an automation's, the Past runs note for its runs only and
under its heading, the section note reading `isRefetchError` and not `isError`
for each list, the Past runs note doing the same, and each note clearing on
the next successful refresh.

Upstream could take the LAST CHECKED change as it is, because it changes only
a read-only field. Removing Open thread is Vivary's choice: a host that mounts
Core's chat beside the page can open an unscoped thread. Remove the LAST
CHECKED part when an upstream release reports the scheduler's check and passes
the same test. Remove the Open thread part only when Vivary can open a run
thread, by giving it a scope or a route that loads it, and the test expects
the control. Upstream could take the #141 identity, opener, interval, and
failed-refresh rules. `refetchOnWindowFocus: true` fits only a client that
does not mount `useDbSync`, which runs its own focus refetch. `networkMode:
"always"` on the queries is Vivary's choice too, on every page. A read that
cannot reach the server then fails and shows the refresh note, rather than
pausing with no message. On the page's changes it applies only to a loopback
page, whose server runs on the same computer, so the browser's network flag
says nothing about that server. `refetchOnReconnect: true` only restores the
reconnect refetch that `networkMode: "always"` turns off. Remove the #141 part when an upstream
release keeps Details on the current list entry, refreshes the lists while the
tab is open, and passes the twenty-four #141 cases.

## Automation runs at quit

Issue #114. A normal quit during an automation run left the run's history row
`running` and the scheduler lease held by the old process. The next launch
could not take the lease until it expired, up to 10 minutes after the last
renewal, and the row became an error only then. Vivary's shutdown did nothing
for automations, and Core had no way to stop them.

`scheduler.js` now exports `stopRecurringJobs({ timeoutMs })`, and
`@agent-native/core/jobs` exports it too. Vivary's one shutdown owner,
`stopLocalWork` in `server/plugins/02-local-code-lifecycle.ts`, calls it beside
the Code host, original command, and preview stops. It calls the automation
stop first and starts every stop even when another throws as it is called. It
reports a failed stop only after all of them settle, so it always waits for
the automation stop, and a failed stop cannot end the CLI host while
automations are still stopping. That owner runs on the
desktop's IPC shutdown and on a signal or Nitro `close` in the CLI host. The
stop works in this order:

1. It closes the scheduler and the runner, synchronously. A timer tick returns
   before it takes the lease, a sweep that was still scanning starts no job,
   and `runQueuedAutomation` leaves a queued Run now row unclaimed for the next
   start. The runner exports `isBackgroundAutomationsClosed`, and four more
   places check it. `executeJob` returns `skipped` before it marks the
   automation running, so a due job stays due, a direct `runJobNow` starts
   nothing, and a Run now row it had already claimed reads interrupted. For
   an automation on a paired execution host, `executeJob` checks again after
   the mark, right before it queues the run on that host, because the stop
   cannot abort a run there. If a quit began during the mark, it writes back
   the fields the mark replaced without moving the next run, so a scheduled
   job stays due and a claimed Run now row reads interrupted. A quit that
   begins while `dispatchRemoteAutomation` looks up the host and writes its
   bookkeeping still queues the run. The event handler checks it for each
   matching trigger before the identity
   check, any write, and the condition classifier, so the event is lost as
   after a crash. It checks again right before the dispatch, for a handler
   that passed the first check before the quit began. The in-process webhook
   runner returns `skipped` before its claim, and Core's process-task route
   answers a webhook task with `skipped: "app-quitting"` before its claim, so
   the call stays queued, unclaimed, with its attempts unchanged. A run whose
   setup was already past those checks is aborted as soon as it starts, before
   the model.
2. It aborts every in-process background run that is still running with the
   reason `shutdown`. Scheduled runs, Run now, and event and webhook runs all
   go through `runBackgroundAutomation`, which keeps the ids of the runs it
   started. A run that already completed and is saving its thread is not
   aborted, so it records its own success.
3. Each run records its own outcome. The runner's completion callback turns a
   `shutdown` abort into the interrupted error. It checks the abort reason
   alone, because a run that reached a soft-timeout boundary reads completed
   after the quit's abort. The runner writes the
   history row as `interrupted` with the message "The run stopped before it
   recorded a result, for example because the app quit or its worker
   restarted. No delivery was confirmed." and the code
   `background_automation_interrupted`, the values Core already derived for a
   stale row. It does not report the interruption as a fault. For a scheduled
   run or Run now, `executeJob` then writes `lastStatus: error` and the same
   message on the automation. A scheduled run's next run moves to the next
   occurrence after the quit, and a Run now keeps its next run.
4. Each scheduled run or Run now releases its run lease after it records its
   outcome, and a run on a paired host releases it once the run is queued there.
   Event and webhook runs hold none. The scheduler lease is free once any scan
   in progress ends, because a sweep releases it when its scan ends, and the
   stop waits for that sweep. See "Scheduler lease per scan".

The stop waits for the sweeps, the queued runs, the runs it interrupted, and
the writes that record a trigger run's outcome, or for `timeoutMs`, whichever
comes first. The runner exports `trackBackgroundAutomationWork`, and the
dispatcher's `dispatchAgentic`, the in-process webhook runner
`runAutomationWebhookTaskInProcess`, and the process-task route put their work
in it, so the stop also waits for the automation's last status and the webhook
task's row on either path. The route tracks its claim, which follows a passed
closed check with no await between them, and then its call to
`runClaimedAutomationWebhookTask`. The desktop and the CLI host register the
in-process runner, so a webhook task reaches the route only on a host without
it, such as a deployment without the in-process timer. The runner's wait
drains the tracked work rather than reading it once: after each pass it waits
again for work tracked during that pass, until none is left. So a route call
whose claim was saving when the stop began is waited for through its run and
its requeue. That call still dispatches, as a run whose setup was past the
closed checks does (step 1): its run is aborted before the model, records an
interrupted history row and a thread, and the task goes back to the queue.
The stop passes its own promise to the wait, so no pass starts after the stop
returns and a pass still waiting then ends. Work that keeps arriving cannot
hold the stop past `timeoutMs`. The event handler's reads, identity check, and
classifier call are not tracked, and its second check covers a handler that is
past its first check when the quit begins. The declarations of the three
runner exports are in its `.d.ts`.
Vivary passes 10 seconds, the Code host's shutdown wait, so `stopLocalWork`
still ends 5 seconds before the desktop ends the server's process tree. A later
call returns the first stop. On the desktop the server calls no exit after
`stopLocalWork` settles, so the desktop's kill still ends it 15 seconds after
the shutdown message. The packaged check timed each normal quit at 15.5 to 15.9
seconds, with the automation rows written within 40 ms.

The hard-kill fallback does not change. The stop writes nothing itself and never
clears a lease by row id, so it cannot free another process's lease. Its flag
and run list are process state that only the stop sets, so a killed process
leaves the database as before. The row reads `running` until the liveness
ceiling, 15 minutes after the run started, or the stale-run reset, the
automation reads running, and the run lease of a scheduled run or Run now holds
until 10 minutes after its last renewal. Since issue #139 that lease blocks only
the killed automation, and the next launch runs the others at its first tick.
When the bound expires, the stop returns and writes nothing more. A run that
settles later still records itself, as any run end does, while the process
lives, and one that never settles is left as after a kill. No startup recovery
was added, because clearing a lease or ending rows at launch is unsafe when two
processes share a database. The lease length, the renewal, the liveness ceiling,
and the claim lease are unchanged. While a dead process's run lease holds,
Settings shows when scheduling resumes instead of a next run that passes with no
run. An automation whose next run falls after the wait keeps that time. See
"Settings next run during a scheduler wait".

Trigger runs record their outcome through the dispatcher, which catches the
run's error and writes the automation's last error from its message, without
the final sentence. An event has no queue, so an event whose run a quit
interrupted does not run again, as after a crash. A webhook call goes back to
the queue, as the owner decided on 2026-09-29. `dispatchAgentic` reports the
interruption without rethrowing, so the event handler keeps going through its
matching triggers, and `dispatchAutomationWebhookTask` returns `interrupted`.
`runClaimedAutomationWebhookTask` then calls `markTaskRetryable` with the
interrupted message and `resetAttempts`, because the host stopped the run, and
it does not start the next queued call. The task reads `pending` with its
payload kept. This write happens only in the run's settle path, after the run
recorded itself interrupted, never from the stop and never by task id, so a
second process on the same database cannot run the call while the first run
still works. The next launch's retry sweep runs it at its first pass at least
90 seconds after the quit, and the calls queued behind it follow in order. The
owner sees the interrupted history row and later a second row for the same
call. The rerun starts from the beginning, as after a crash. A run that
outlasts the bound, or a kill between the history row and the task write,
leaves the task `processing`, and the sweep delivers it again about 15 minutes
after its claim. A task the process-task route claimed records another
dispatch outcome, so the sweep delivers it again 5 minutes after its claim, or
16 minutes for a background-function claim. The route answers an interrupted
call with `retrying: "app-quitting"` instead of `"automation-active"`. An event
or a webhook call that arrives during the quit starts no run (step 1).

Run `node --test packages/workbench/tests/automation-quit.test.mjs`. Each
quitting or killed process is a child that runs
`tests/automation-quit-process.mjs` against the test's disposable SQLite
database, with `NODE_ENV=production` and a fake engine. The test process plays
the next launch. It checks that a quit during a scheduled run and a Run now
marks both rows interrupted with the message once and the code, writes each
automation's last status and next run, releases the lease, and returns only
after both runs settled. After the stop, a tick takes no lease and writes no
heartbeat, and a queued Run now stays unclaimed. The next launch runs both due
automations at its first tick. A killed child keeps its run's lease, which
expires about 10 minutes out. The next launch still scans and runs another due
automation, the killed run reads interrupted only past the liveness ceiling,
and once the run lease has expired and the run's time window has passed, a scan
resets the automation and deletes the lease row. A stop in a second process
scans and leaves the first process's run lease alone. A run that ignores its
abort holds the stop only until the bound, stays `running`, and keeps its run
lease. A source pin checks that `stopLocalWork` calls the stop with 10 seconds,
the Code host's wait, and that the package entry exports the scheduler's own
function. At the #114 fix, eight of the nine cases failed on the previous patch,
and the hard-kill case passed on both.

A review round added trigger cases. A child quits with an event run and
webhook call A in flight and call B queued, and exits as soon as the stop
returns, as the CLI host does. The event's automation reads its error, both
tasks read `pending` with their payloads and no spent attempt, only A has a
history row, and the next launch's retry sweep runs A and then B once each.
Both cases failed on the previous patch: the event's automation still read
running and call A was left `processing`, because the stop returned before the
dispatcher's writes. A second child quits with only an event run in flight, so
no other work holds the stop open for the dispatcher's write. After the stop, an event, a direct Run now, and a queued
webhook call start no run and write nothing, and a Run now claimed just before
the stop reads interrupted with no thread. Those three cases failed on the
patch before the closed checks. Three more pin a sweep that is scanning when
the stop begins, which dispatches nothing, leaves its job due, and releases the
lease, a second stop call, which returns the first, and a run still preparing
when the stop begins, which is interrupted before the model. A quit that lands
after a run completed, while its thread save is pending, leaves the history
row a success and the agent run completed. A quit that lands after a
one-second soft timeout ended a run's turn reads interrupted, not cut off.
Both failed on the patch before the running filter and the reason check.

A second review round added route and event cases. A child quits with a
webhook call's run in flight through Core's process-task route and exits as
soon as the stop returns. The task reads `pending` with its payload, no spent
attempt, and the interrupted message, and its one history row reads
interrupted. After the stop, the route answers a queued webhook call with
`skipped` and leaves it unclaimed with no history row, and an event whose
trigger has a condition reaches neither the classifier nor a write. Those three
failed on the patch before this round's fix: the task stayed `processing`, the
route wrote an interrupted run and a thread, and the handler called the
classifier and recorded a skip. The child answers the classifier itself, never
over the network. An event whose condition check began before the stop and
matched after it starts no run, which pins the second check. The after-stop
event cases wait for the dispatcher's handler to finish, not for a fixed delay.
A run the owner stopped just before the quit keeps its `user` abort reason and
reads as an error, not interrupted, which a status filter weaker than `running`
would break.

A third review round added two cases. A child starts the stop while the
route's claim of a webhook call is saving and exits as soon as the stop
returned and the claim saved. The task reads `pending` with its payload, no
spent attempt, and the interrupted message, and its one history row reads
interrupted. A second child tracks work that keeps arriving during the stop.
The stop waits for it until its bound, and no pass of its wait starts after
the stop returns. Both failed on the patch before this round's fix: the task
stayed `processing`, and the stop returned after the first piece of work.

A fourth review round added three cases. Two load the lifecycle plugin with
stand-ins for its four stops. One stop throws as it is called, and another
rejects. Through the Nitro `close` hook and through the signal handler, every
stop still starts, the automation stop first, and the failure is reported
only after the automation stop settled. Both failed on the previous
`stopLocalWork`, which used `Promise.all`: the preview stop never started, the
hook rejected first, and the throw left the signal handler. In the third, a
child holds the running mark of a scheduled run and a Run now for
automations on a paired execution host until both are saving, then starts
the stop. Nothing is queued on the host, the scheduled run stays due with no
history row, the Run now row reads interrupted with no thread, and the next
launch queues the due run. It failed on the patch before this round's fix,
which queued both runs on the host.

The plugin's import and Core's timer must share one copy of `scheduler.js` in
the server bundle, or the stop would close a scheduler that never runs. Both
resolve to the same Core file. The unpublished `9e921ca0` package holds one
copy: the scheduler's lease warning and the stop's message check are in one
Core chunk, `index.mjs` imports that chunk once, and a quit during a run left
the row interrupted 18 ms after the quit. The
[#114 and #115 receipt](../../../docs/product/multi-project/receipts/114-automation-quit-and-status.md)
records the check.

Upstream could take the stop as it is, because nothing changes until a host
calls it. Remove this part of the patch when an upstream release offers a stop
with the same order and fallback that passes the same test.

## Scheduler lease per scan

Issue #139. A sweep held the scheduler lease, the app's `<appId>:global` row in
`automation_scheduler_health`, until every job it started had finished. Each
tick asks for the lease with a new owner, so while one scheduled run lasted, up
to its 10-minute limit, every other tick in every process failed to take it
and returned without scanning. No other scheduled automation started, and LAST
CHECKED stood still, until that run ended.

The scheduler lease now covers one scan. `sweepRecurringJobs` takes it, writes
the heartbeat, scans, preflights and reserves the due jobs, writes the
dispatch and scan-end heartbeats, and releases it. Only then does it start the
jobs it reserved. Its renewal timer runs only while it holds the lease. A tick
that fails to take the lease still returns at once and writes nothing. Scans
never overlap, in one process or across processes on one database. Sweeps do
overlap while their runs execute. Each sweep's promise still settles after its
runs record their outcomes, so the stop, the sweep route, and the timer call
are unchanged. No heartbeat is written when the runs end, so LAST CHECKED
means a scan happened.

Releasing the lease early exposes a weakness it used to hide, the running mark's
time window. A sweep reads a `running` mark as stuck once its `lastRun` is older
than the run's hard timeout. That `lastRun` is the scan's time, taken before the
identity check, setup, and the model call, and delivery and the outcome write
come after the hard abort, so a live run can outlast its window. Once sweeps
scan during runs, another sweep would reset such a run. Each scheduled run or
Run now therefore holds a run lease of its own, a `run:<owner>:<path>` row in
the same table on the same lease columns, and the schema does not change. Run
lease rows share the table under `run:<owner>:<path>` ids that no reader lists,
because every reader looks up a heartbeat or the scheduler lease by its
`<appId>:<orgId>` or `<appId>:global` id. The run lease takes no app id, so
taking it reads nothing from the run's dependencies. Any failure those
dependencies raise lands in the run's own error handling and its redacted last
error, as the issue #97 case for an automation's last error in
`tests/native-redaction.test.ts` pins. Its row is keyed by the resource alone,
so its `app_id` column reads `default`, and a job written before app ownership
was saved, which every app's scheduler scans, has one run lease for all of them.
`executeJob` takes the run lease after the identity, Run now, and quit checks
and before the running mark, renews it every minute, and deletes the row after
the outcome write. A failed delete is logged, and the row expires as after a
hard kill. A run on a paired host releases the lease once the run is queued
there. Event and webhook runs take none. When another run holds the run lease, a
Run now ends as already running with the existing message, and a scheduled job
is skipped with one log line and stays due. `scheduler-health.js` exports
`acquireAutomationRunLease`, `renewAutomationRunLease`, and
`releaseAutomationRunLease`, which share the scheduler lease's acquire and renew
SQL.

A sweep that meets a `running` mark first tries to take its run lease. If
another run holds it, that run is live however old its mark is, and the sweep
leaves it. If the sweep takes the lease, it reads the automation again,
because the list it scanned can predate a run that has since finished and
released its lease, and it acts only on that fresh read. A mark that still reads
`running`, enabled with a valid schedule, is reset as before, and only once its
time window has passed, because some marks have no run lease. An event run of
an automation that also has a schedule takes none, and neither did older
builds. A paired-host mark is reconciled under the same rule, so no tick
reconciles a mark as failed while its dispatch is still saving the request id.
The sweep then releases the run lease. A failure while it checks one mark is
logged, and the scan goes on to the next automation.

After a hard kill, the next launch scans at its first tick and runs every
other due automation, because the killed process held no scheduler lease
unless it died during a scan. The killed run's lease holds until 10 minutes
after its last renewal. Once that lease has expired and the run's time window
has also passed, a scan takes the lease, resets the mark to the interrupted
error, and deletes the lease row. It also finishes the automation's latest
history row with that error when that row has not finished. If a later row
exists, such as a Run now refused while the lease held, the killed run's row
keeps no finish time and reads interrupted. A kill during a scan still blocks
scans for 10 minutes. After a quit and a quick relaunch on the same database,
the new process skips only automations whose run leases the old one still
holds.

A run whose process stops renewing for 10 minutes while the run lives, such as a
laptop asleep beside a second server on one database, reads as dead to the other
server. That is not new. Before this change the sweep ignored a failed renewal,
and the time window freed such a run the same way. A run does not abort when its
renewal finds another holder. A process still runs at most eight scheduled jobs
at once. Since issue #140, Settings shows when scheduling resumes while a run
lease or a dead scanner's lease blocks an automation's next run, after the first
90 seconds for a dead scanner, whose fresh lease reads as a live scan's. An
automation whose next run falls after the wait keeps that time. See "Settings
next run during a scheduler wait". Issue #141 keeps
LAST CHECKED in the Details dialog current. Run now and scheduled runs now
write the health table before the running mark, so they need it writable. When
the run lease cannot be taken because that write fails, the run does not start.
A Run now ends as an automation worker failure, and a scheduled job stays due. A
Run now is refused as already running whenever a scan holds the automation's run
lease for its short check. A scan takes that lease for every mark its list read
as `running`, including the mark of a run that finished after the list was read.

Run `node --test packages/workbench/tests/automation-quit.test.mjs`. The case "a
due automation starts at the next tick while another automation's scheduled run
is in progress" holds one scheduled run open, makes a second automation due, and
runs the next tick. The second automation runs within 5 seconds, LAST CHECKED
advances, and the first keeps one run and one engine start. The first run still
holds its run lease when its outcome is written, each run then deletes its run
lease row, and no check is written when the runs end. The case failed on the
patch before this change. The guard "two processes on one database never scan at
the same time" passed on both. A run whose lease another process holds stays
`running` with its `lastRun` 30 minutes old, and Run now refuses it. A mark with
no run lease stays `running` inside the time window and resets past it. A
paired-host mark whose dispatch holds the run lease is left alone, and it is
reconciled as failed once the lease is released. A run that finished after the
scan listed it is left alone, with its finished history row and a Run now row
claimed after it. A paired-host mark whose dispatch saved its bookkeeping and
released the lease after the scan listed it is reconciled from a fresh read and
stays `running`. A paired-host dispatch still holds the run lease when it saves
the queued run's bookkeeping. A due automation whose run lease another run holds
is skipped with one log line and stays due. When the database refuses a run
lease delete, a scheduled run and a Run now each log the refused delete, the
scheduled run keeps its success outcome, the Run now's history row reads
success, and both rows are left to expire. When it refuses one running mark's
run lease, the scan logs that mark, leaves it, and still runs another due
automation with no scan error. The hard-kill, stop, and stuck-run cases check
the run lease, and the next launch after a hard kill runs another due
automation. Five cases have a tick that should leave a running mark alone: the
run another process holds, the mark with no run lease, the paired-host mark
whose dispatch holds the lease, the run that finished after the scan listed it,
and the fresh reconcile. Each counts the scan's attempt to take the mark's run
lease, which shows that the tick reached the mark, and checks that the tick
logged no failed check of the mark. For the run another process holds and the
dispatching paired-host mark, the attempt gets no lease, and the holder still
holds it after the tick.

Upstream can take this change as it is. It adds exports to
`scheduler-health.js` and changes no schema. Remove this part of the patch
when an upstream release releases the scheduler lease before its runs, gives
each run a renewed claim of its own, and passes the same test.

## Settings next run during a scheduler wait

Issue #140. After a hard kill during a scheduled run, the run reads `running`
and the dead process keeps its run lease for up to 10 minutes. A scanner killed
during its scan keeps the `<appId>:global` scheduler lease the same way. Both
list actions reported the next occurrence from now once the stored one had
passed, and read neither lease, so Details showed a NEXT RUN about a minute
ahead that passed with no run. The packaged check of the unpublished `9e921ca0`
package read NEXT RUN 14:38 UTC at 14:38:13 while the run lease held until
14:45:25.

`list-automations.js` and `list-recurring-jobs.js` now report NEXT RUN through
`listedNextRun` in the new `jobs/next-run.js`, and their own `nextRun` copies
are gone. Each request reads the clock and the held leases once through
`readScheduleView`, which calls `readHeldAutomationLeases` in
`scheduler-health.js`. That is one read-only query for the app's scheduler lease
and every run lease that has not expired, with each row's `updated_at`. A row
the scheduler cannot act on yet lists `nextRun: null` and a `schedulerWait` of
`{ reason, resumesAfter }`. Every other row lists the value it listed before and
`schedulerWait: null`. The field is per row, so both actions still return bare
arrays.

A held run lease or a `running` mark is a wait on its automation. It ends at the
lease expiry or at `lastRun` plus the run time limit,
`resolveBackgroundRunHardTimeoutMs()`, whichever is later, as the scan reads
them. A mark whose `lastRun` does not parse ends now, because the next scan
resets it. A paired host's mark with no lease has no end, because its relay
reports when the run ends. A holder writes its lease row at every renewal, once
a minute, so a row whose `updated_at` is more than 90 seconds old, one and a
half renewals (`AUTOMATION_LEASE_STALE_MS`), belongs to a holder that stopped. A
held run lease is a wait whether or not it is stale, because a lease killed
seconds ago looks live, and a live run also delays the next occurrence.
Staleness picks only the reason. It is `run` while the holder writes the row,
and `stalled-run` once the holder stopped or for a mark with no lease.

Every live scan holds the scheduler lease for the seconds the scan takes, so
only a stale scheduler lease is a wait, with the reason `scheduler`.

The scheduler acts on a wait at the first tick at or after it ends, and a fresh
launch first ticks 70 seconds in, so every wait clears within two ticks
(`AUTOMATION_SCHEDULER_TICK_MS`) of its end. A due time later than that is the
run the scheduler starts, because no occurrence lies between now and that time.
The list shows it, so an hourly or daily automation keeps its date under a short
wait. An earlier due time is hidden, including a stored future `nextRun` that an
edit or a resume wrote during the wait. `resumesAfter` is the end of the wait
for `stalled-run` and `scheduler`, and null for `run`. It is a bound, never a
run time, because the tick that acts on the wait lands up to 70 seconds after
it, so a run time computed from it could be one occurrence early.

A failed lease read is logged, and both lists then read as if no lease is held.
A row with no running mark lists NEXT RUN as before this change. A `running`
mark still waits on its run's time window, so a live run reads `stalled-run`
until its time limit while the read fails.

Details in `AgentJobsTab.js` shows the wait in NEXT RUN. A `run` wait reads
"After the current run finishes". A `stalled-run` wait reads "Scheduling resumes
after {{date}}, when an unfinished run times out", and a `scheduler` wait reads
"Scheduling resumes after {{date}}, when an interrupted schedule check times
out". Once that time has passed, both read "Waiting for the next schedule check"
until a list refresh after the scheduler acts. A deploy with no scheduler keeps
its own string, which wins over a wait. A row from a server without the field
reads as no wait. The four strings are `jobs.*` keys in
`localization/default-messages.js`.

`holdRunLease` builds its key with the new `automationRunLeaseKey`, as the lists
do, and `server/agent-chat-plugin.js` sets the scheduler timer with
`AUTOMATION_SCHEDULER_TICK_MS`. The scheduler, the runner, every lease write,
`getAutomationSchedulerHealth`, and the hard-kill fallback are unchanged. The
agent's `manage-automations list` and `jobs/tools.js` still return the stored
`nextRun`.

Three limits remain. First, for up to 90 seconds after a scanner dies during its
scan, its lease looks like a live scan's, so the list shows the next occurrence,
and that time can pass with no run while the lease holds. That falls short of
the issue's first acceptance item for those 90 seconds. A live scan holds the
lease for seconds, so counting a fresh scheduler lease as a wait would replace
every scheduled row's next run with a wait during each scan.

Second, under a dead scanner's lease, the scheduler runs an automation that came
due during the wait at its first scan after the lease expires, on no occurrence.
When the next occurrence lies more than two ticks past the lease expiry, as for
an hourly or daily automation, the list shows that occurrence and not the
catch-up run. A run stores the next occurrence after it finishes, so that time
is still met unless the catch-up run is still in progress then.

Third, a run that starts or ends between the two reads of one list request can
list a `stalled-run` wait in that response, and the next refresh, 30 seconds
later, corrects it. Neither read order removes this, because a run takes its
lease before it writes its running mark and deletes the lease after it writes
its outcome. `list-automations.js` reads the rows before the leases, so a run
that ends between the reads shows a mark with no lease. `list-recurring-jobs.js`
reads the leases first, so a run that starts between the reads shows the same.

Run `node --test packages/workbench/tests/automation-quit.test.mjs` and `node
--test packages/workbench/tests/automation-status.test.mjs`. The cases "the list
names no next run before a killed run's lease lets the scheduler act" and "the
list names no next run while a dead scanner's lease blocks every scan" in the
quit file failed on the patch before this change. In the status file, a table
over `listedNextRun` at a fixed time covers an entry nothing blocks, a paused
entry, a live run with an every-minute and an hourly schedule, stale run leases,
a mark with no lease under the default and a longer run time limit, a mark with
no start time, a paired host's mark a year out, a due time 30 seconds after a
stale lease's expiry, a five-minute schedule due 70 seconds after one, which
only the two-tick slack hides, a stored next run written during the wait, a
lease written exactly and just over 90 seconds ago, a live and a dead scanner's
lease, an hourly entry under a dead scanner, the later of two waits, and an
event entry. A simulation resets a killed run's mark for every-minute,
every-five-minute, hourly, and daily schedules and kill times 7 seconds apart
around an occurrence. The reset lands at tick phases from 0 to 69 seconds after
the wait ends, in 4.6-second steps, or 70 seconds after a launch that comes
after the wait. Each NEXT RUN listed before the reset is null or the time the
reset stores. A slack of one tick fails both the simulation and the five-minute
row. Other status cases list a legacy job's wait, list the end of a 30-minute
run time limit set by `AGENT_BACKGROUND_RUN_HARD_TIMEOUT_MS`, log a failed lease
read and list as if no lease is held, render the four strings and a row with no
field in Details, and keep the no-scheduler string over a wait. In the quit
file, a run lease aged three minutes lists `stalled-run` at the later of its
expiry and `lastRun` plus 10 minutes, and lists the stored next run once a tick
resets the mark. A live run held by a child lists `run`, while an hourly
automation under a live lease keeps its hour. A scheduler lease taken as a scan
takes it changes no row. Under a dead scanner's lease, a due automation lists
the wait, a paused one lists no next run and no wait, and an event automation
lists as before.

Upstream can take this change as it is. It adds `jobs/next-run.js`, exports to
`scheduler-health.js`, and the `schedulerWait` field to both list actions, and
changes no schema. Remove this part of the patch when an upstream release names
no next run the scheduler cannot meet while a lease or a running mark blocks it,
and passes the same tests.

The current approval custody correction keeps Settings discovery separate from
ordinary bounded history reads. Settings opts into scoped retained approvals and
the history store deduplicates recent and retained rows. Pre-execution webhook
contention is retry, with payload and attempts preserved, rather than custody of
another execution's wait. Ask creation and wait persistence lock the exact live
resource in the existing database transaction. Modern and legacy deletion recheck
persisted custody in that transaction before token, secret and definition mutation.
PostgreSQL uses FOR UPDATE and local SQLite uses BEGIN IMMEDIATE. Resource deletion
events follow commit. A missing or replaced definition cannot receive an ask.
Unfinished admitted history survives deletion cleanup to record its terminal refusal.
The maintained PostgreSQL adapter controls are static query contracts, not database
execution proof. New source still requires controller runtime, review and UI checks.

## Durable automation approvals

Issue #108 keeps continuation in Native's existing owners. The background runner
saves `waiting_approval` on the existing `automation_runs` row before yielding.
It retains the Native thread, logical turn, exact pending ask and restricted
registry digest. The worker saves the retained turn in Native's completion callback,
then awaits Native's terminal finalization outside that callback before marking the
wait ready or returning. A 30-second finalization bound fails closed. Active chunk
ownership remains held when finalization cannot be confirmed. Waiting does not finish history, deliver a reply, emit
`automation.run.finished` or advance the schedule. Scheduler, Run now, event
and webhook paths propagate it and refuse another execution of that definition.
Waiting publication uses the same resource conditional update as other outcomes,
with an atomic SQL condition on the exact history ID, current Native chunk,
ready waiting status and unfinished history. A late original caller cannot overwrite
a terminal outcome or the wait of a newer chunk, even when it reads the latest
resource after the owner decision. A separate history read would leave a race. PostgreSQL locks the matched
history row through that write to serialize against the decision claim. SQLite
serializes its writers.
A webhook's existing `integration_pending_tasks` row also becomes
`waiting_approval`. The retry sweep does not select it, including after restart.

Run now can create a durable request while an earlier execution awaits approval.
Its worker still refuses admission. That refused history cannot supersede the
actual owner of the wait. Native history records `admitted_at` on initial thread
attachment, preserves it across fresh continuation chunks and leaves queue/refusal
rows unadmitted. History creation and conditional attachment are mandatory before
Native insertion or start. Attachment failure records an admission error and
executes no model or tool. Attached legacy histories use their recorded start
time even when a later continuation fills a missing admission marker. One
shared SQL predicate orders admitted owners by admission time and history ID,
including equal times, within the same owner, path, app and organization. Both the
history precheck and atomic resource CAS use it. Resource identity, definition
edits and fresh-running marks retain their existing protections.

After approval settles its retained webhook task and reconciles the resource,
the runner selects only the next queued task on that validated external thread.
It rechecks owner, organization, resource and app binding before the existing
claim-safe dispatch. The resource must have left waiting/running first. Duplicate
or recovered bookkeeping can redispatch a pending follower, but its existing FIFO
claim permits one execution. Dispatch failure keeps the original history's terminal
bookkeeping unreconciled for recovery. It never repeats the original consumed action.


Settings > Agent > Automations > Details > Past runs > Inspect run reads the
retained Native thread through `inspect-automation-run`. It shows prior tools,
results and the exact pending input. `decide-automation-approval` accepts only
history ID, expected ask ID and approve or decline. Authorization follows the
persisted run and retained execution binding. The normal HTTP transport's active
organization does not replace a personal run's null organization. Organization
runs require the same persisted organization, matching thread and continuation,
and current owner membership for inspection and decisions. Both are owner actions,
not model tools. Production chat POST rejects every automation-owned thread
before preparation, including a forged internal continuation. Native thread
scope and its retained history marker preserve that custody after history deletion.

`run-history.js` owns the conditional `waiting_approval` to `resuming` claim.
Only one concurrent decision wins. Approve rechecks owner, org, app, thread,
logical turn, exact Native ask, expiry, automation definition revision and the
restricted registry fingerprint. It invokes the current validated entry through
`executeAgentToolCall`, including Native schema validation, journal, mutation
ordering and redaction. The approval store consumes the exact ask ID once.
The approved result remains durably saved before the follow-up model response.
Automation saves pass the Native journal sequence to `foldAssistantTurn`.
Its automation-only mode retains chunk snapshots in the same assistant message's
custom metadata and replaces the latest chunk at a higher sequence, including
shorter authoritative text. Earlier chunks and the waiting sentence remain.
Equivalent or stale snapshots do not append text or cards again. Consumed ask
cards are removed from both visible parts and retained snapshots. Completed
prior chunks stay sealed. Legacy accumulated content is retained as a prefix
until a fresh chunk records its boundary. This adds metadata inside the existing
thread row, not another transcript or execution owner. Chat and team callers
keep the default fold mode. Broader merge/replay and installed automation checks
remain required for the new source.
The runner rechecks identity and fingerprints before consumption and immediately
before the current entry runs. A replaced MCP endpoint, changed schema, hidden
tool or changed definition refuses approval. Fingerprints contain digests,
never stored MCP headers, tokens or raw connection configuration. Owner-wide
always-allow policy cannot grant an unattended call. The policy setter binds
SQLite's enabled INTEGER as 1 or 0 and retains JavaScript booleans for PostgreSQL's
BOOLEAN. Tests exercise actual enable and disable calls on both backend paths.

Continuation uses the same history ID, thread and logical turn with a fresh
Native chunk ID. Native's thread fold and `threadDataToEngineMessages` with
tool calls included retain earlier results. Prior completed tools stay journaled.
A later gate can return that same history row to waiting. Decline consumes the
pending ask as declined and ends history clearly without the pending side effect.
An expired or changed wait can still be declined by its exact owner.

Waiting persists across restart. If a crash interrupted its turn save, the
next owner decision may recover the fold from Native events only after Native
proves the chunk terminal, the turn was not stopped and the exact ask is still
pending. Inspection only reads that readiness. A claimed continuation stays
blocked while its Native chunk may be live. A terminal chunk with a pending,
unconsumed ask may return to waiting through a conditional claim. If no chunk
was inserted, recovery waits for the existing full run liveness ceiling.
After consumption an unconfirmed crash becomes interrupted and that ask is
never automatically dispatched again. A persisted decline recovers as declined.
This gives no exactly-once external-effect promise. Stop and shutdown can leave
an approved action unconfirmed. The runner retains that explicit interrupted
classification through Native completion instead of replacing it with generic error. Shutdown preserves an idle approval wait.
Durable gate storage failure aborts the run and cannot become success. Its
`automation_approval_storage_failed` classification takes precedence over the
resulting generic abort. Pre-write Stop and validation refusals stay outside the
persistence catch. Stop is checked again after validation, and a genuine failed
write retains its failure flag without re-aborting an already stopped chunk.
Only that typed webhook failure propagates to the
existing worker. The worker returns failed and retains its payload pending for
exact-bound terminal reconciliation, which settles task and resource without
model redispatch or configured effects. Generic event errors and shutdown retry
semantics are unchanged.

`tests/automation-approval.test.mjs` uses installed Core, disposable SQLite and
fake engines and tools. It covers same-run approval, decline, concurrent and
duplicate decisions, identity and ask mismatch, expiry, definition and connector
changes, current-entry revalidation, crash refusal, gate storage failure, event
and webhook waiting, Run now, Stop and fresh-process restart. The existing
`automation-status.test.mjs` renders the real Settings component with a fake
owner transport to check retained inspection and exact decision payloads.
`automation-local-only.test.mjs` keeps the default twelve and their refusals.
The same suite retains the immediate process-exit restart test and adds a held
Native terminal-write barrier. Scheduler and trigger regressions cover approve and
decline in normal order, after a delayed latest-resource read and after a delayed
conditional update. Each checks terminal history and metadata, no unresolved wait,
exact configured side-effect counts and admission of fresh gated work. The local
surface test executes all three plugin dependency expressions with the real Native
restriction and MCP adapter, checking their local registry, gated declarations and
confined prompt loading. CI registers the lifecycle test beside those suites. These new regressions are
source only in this wave. Runtime checks, independent exact-head review and a
built UI journey remain required before acceptance of issue #108.

## Automation-written instruction files

Issues #109 and #144. The owner decided on 2026-09-28 that instruction and
memory files written by automation runs wait for review, and on 2026-09-29
that later runs skip those proposals too. Runs can change only their owner's
personal resources. They cannot write or delete app default, organization or
workspace resources, even when their creator is an organization admin.

The wrapper in dist/jobs/unattended-surface.js supplies automationRun through
the request context. The resource store derives the run identity from that
context, never from tool arguments. Every run write records created_by,
run_id and thread_id. A reviewed path is AGENTS.md, LEARNINGS.md, or a path
under instructions/, skills/ or memory/, compared in lower case. Runs must
write plain paths because the loaders match the stored path. A run's
LEARNINGS.md write defaults to the app-shared scope and is refused unless it
explicitly names its personal scope. Personal LEARNINGS.md is not prompt-loaded.

A write to a reviewed path keeps the proposed content in the resource row
and stores one accepted predecessor in runReview.previous. This is a complete
resource snapshot, bound to the same id, owner and path. The first proposal
captures the last accepted version. Later proposals, chat edits and owner
edits keep that predecessor while replacing only the proposed text. An empty
accepted file is a predecessor, distinct from a proposal with no earlier file.
Caller-supplied runReview metadata is removed by resourcePut and
resourcePutIfAbsent, then only the store's review record is attached.

resourcePut writes against the version, content and metadata it read. On a
conflict it reloads and recomputes the proposal, for at most eight attempts.
A competing initial insert does nothing and retries. Every successful write
advances updated_at, so same-millisecond writes and review decisions have
different versions. Moves compare the identity and version inspected before the
move, and ID-based deletes compare the owner and path checked before deletion.
Pending rows retain the accepted visibility and have no
expiry. A proposal cannot hide accepted instructions as agent scratch or
erase them through scratch cleanup. New proposals stay visible to Settings.

resourceForAgent returns the accepted projection while a proposal waits.
A new or legacy pending row without a saved predecessor returns no content.
The helper covers prompt AGENTS, compact and full instructions, memory,
skill indexes, skill references, the skills route, the first-message file
inventory and resources read. Loaders that list then fetch a body also project
the freshly read row. Settings reads the raw proposed content. The prompt
notice counts every pending personal file without quoting proposal paths
or content, and explains that accepted content remains available.

Settings > Automation files lists proposed text as plain text. Accept activates
that exact version and removes the saved predecessor. Discard restores the
accepted content, metadata, MIME type, visibility, expiry and origin in one
conditional update. If no predecessor was saved, it deletes the proposal with
the existing full-row comparison. Both decisions refuse a changed version.
The list rechecks ownership and pending state after reading each body.
An unconfirmed decision shows a notice until that file has a confirmed decision.
A successful review of another file cannot clear that notice.
The owner action remains unavailable to chats, MCP clients and automation
runs. Its internal delete operation now means discarding a proposal.
A pending proposal must be accepted or discarded before moving its path.

Automation deletion of instruction and memory paths is refused by every store
delete entry point. delete-memory refuses before deleting the body or changing
the memory index. Ordinary personal notes remain deletable. Conditional writes,
insert-if-absent writes and moves refuse automation changes involving reviewed
paths, so internal alternate writers cannot bypass proposal creation.

Core's raw SQL tools and extensions SQL routes refuse the resources table.
The raw SQL inspection section documents their shared parser and checks.
An ordinary note remains readable, and resources list may still show paths.
This change adds no schema migration and keeps only one accepted predecessor,
not a version history.

Limits: earlier pending rows have no saved predecessor, so this change cannot
recover text already overwritten before the fix. Those proposals remain
hidden until review. A new personal proposal can still shadow an inherited
shared or organization file at the same path. Accepted scratch visibility
remains scratch visibility. Interactive owner deletion remains an explicit
deletion. Live PostgreSQL and a packaged Windows journey for #144 are not
established by the SQLite and component tests.

Run:

```sh
node --test packages/workbench/tests/automation-file-review.test.mjs packages/workbench/tests/automation-file-review-component.test.mjs
```

The tests use disposable production SQLite data and the real unattended action
wrapper. They cover accepted reads and prompts during proposals, skill loading,
repeated edits, all deletion boundaries, conditional-write conflicts, reserved
metadata, stale decisions, list/read races and a fresh process after a proposal.
The first test commit records 15 failures before the fix. Two later identity-race
cases also failed before their fixes. The Settings component tests render the
real component with a stubbed action transport. They cover failed Accept and
Discard requests, successful retries and overlapping decisions on two files.

The older issue #109 packaged result remains in
[its receipt](../../../docs/product/multi-project/receipts/109-automation-file-review.md).
It is evidence for that earlier build, not this change. Remove this patch only
when upstream preserves accepted instruction content during pending changes,
refuses unattended instruction deletion, and passes these tests.

## Credential redaction

Issue #97 adds a text redaction hook. The owner asked on 2026-09-26 that
credentials never appear in anything Vivary shows, stores, or sends to a model,
even when an agent, a tool, or a provider error prints one. No existing Core
hook can change a tool result or a run event, so the patch adds one.

`dist/audit/redact.js` exports `setTextRedactor`, `redactText`,
`redactTextInValue`, and `textRedactionHoldback`, and the `./audit` entry
re-exports them. A host registers one function that takes text and returns
text, and can pass `holdback`, a function that returns how many trailing
characters a streamed delta keeps back. `redactText` applies the redactor, and
returns text unchanged when none is registered. `redactTextInValue` applies it
to every string in a plain object or array, and returns the same value when
nothing changed. If the redactor throws or returns something other than text,
the text is withheld as `[text withheld because redaction failed]`. Vivary's
`server/plugins/00-credential-redaction.ts` registers `redactCredentials` from
`server/credential-redaction.ts`, with a holdback that covers its longest held
form plus 256 characters, at most 16,384.

Core calls the hook in these places:

- `agent/production-agent.js` redacts a whole tool result before truncation, so
  the model, the `tool_done` event, the loop journal, and the read cache get one
  redacted string and a credential that crosses the limit is found whole. Every
  tool error result passes through `finalizeToolErrorResult`, which now redacts
  after `sanitizeToolErrorText`. Warnings appended to a result are redacted too.
  `structuredHistoryToEngineMessages` and the plain `history` fallback redact the
  earlier turns the browser sends back, so a credential typed in an earlier
  message reaches the model as its placeholder.
- `agent/run-store.js` redacts a recovered tool result in `writeLedgerEntry`
  before it is stored, and again in `readLedgerEntry`, so a row stored before
  this change is not replayed raw.
- `agent/run-manager.js` redacts every run event in `emitRunEvent`, before it is
  kept in memory, sent to subscribers, or inserted into `agent_run_events`. That
  covers tool starts and results, provider errors, and the terminal event, which
  `send` also redacts when it stashes it. A `text`, `thinking`, or
  `tool_input_delta` delta keeps back its last word, and the word before it when
  only spaces or tabs separate them, up to the host's holdback. Text and thinking
  share one slot, flushed before any other event. Each tool call's input has its
  own slot, flushed before any event that is not a delta, so input streamed for
  two calls at once stays whole. Everything held goes out when the run ends and
  when it is aborted. The last word or two appears a moment later while text
  streams. The joined text is unchanged apart from redaction.
- `server/credential-provider.js` redacts the provider error message it saves
  after a 401.
- `chat-threads/store.js` redacts `thread_data`, the title, and the preview in
  `updateThreadData`, a catch-all for browser saves and automation runs, and in
  the row `forkThread` inserts, because the source row can predate redaction and
  a snapshot comes from the browser. It redacts each string of the parsed
  repository and keeps the stored text as sent when nothing matched.
- `jobs/run-history.js` redacts the error of a finished automation run, and
  `jobs/scheduler.js` redacts the last error it stores in the automation's file.
- `cli/code-agent-runs.js` redacts a Code transcript event's message and
  metadata before `appendCodeAgentTranscriptEvent` writes it, and the title,
  subtitle, details, progress, and metadata of a run record before it is
  created or updated. The Vivary server and the coding worker each register a
  redactor. The worker's is built from salted fingerprints the host sends with
  the start request, so the host never sends the worker the values.
- `secrets/storage.js` exports `onAppSecretsChanged`. `writeAppSecret` and
  `deleteAppSecret` call its listeners after the write, and Vivary reloads its
  held set from them.

Run `pnpm test:credential-redaction`. CI runs it once, in the maintained
Workbench checks on Linux. The Windows CI job runs no Node tests, so a
platform-neutral test file is covered on Windows only when run there. It runs
`tests/credential-redaction.test.ts`, `tests/native-redaction.test.ts`,
`tests/code-run-redaction.test.ts`, and `tests/code-run-worker.test.ts` one
file at a time with random synthetic values and disposable SQLite databases.
The Native test registers Vivary's redactor and drives the agent loop with a
fake engine whose tools return a held value from an action, from an MCP-shaped
result, from a thrown error, and across the 50,000-character result limit. It
runs `startRun` with text, thinking, and tool-input deltas that split held
values, including one of 403 characters, with a thrown provider error, and with
an abort. It also checks the ledger, the saved provider failure, saved and
forked threads, earlier turns, an automation run error, and an automation's
last error. `tests/code-run-worker.test.ts` forks the real coding worker source
through tsx with a stub Claude CLI that reads a project file holding a held
value and a `ghp_` token, and checks the start request, the transcript file,
every file under the code-runs folder, the Code state, and the follow-up prompt.
It loads Core's server modules, which take several seconds, so it runs only in
this sequential suite.

Upstream could take the hook as it is, because nothing changes until a host
registers a redactor. Remove this part of the patch only when an upstream
release offers the same call sites and passes the same tests.

## Codex integration

The September 16, 2026 integration adds an explicit `codexCli` option to Core's
existing executor. Other Core consumers keep their existing launch behavior.
Vivary supplies the resolved executable and environment to the native app-server
transport, retains Codex configuration, and skips host MCP overlays. Credentials,
skills, tools, and configured connections remain owned by Codex.

Per-run permissions are Normal, Read only, or YOLO. Normal allows workspace writes
with native action approvals; Read only cannot approve broader access; YOLO removes
the shell sandbox and approval prompts. Normal and Read only validate their effective
sandbox boundaries. Connected services retain their own access settings. Global
Codex configuration is unchanged. Each conversation retains its selected model.
Each turn captures the permission mode selected when it starts. The adapter
explicitly selects the default collaboration mode.

The executor records the native session ID and resumes it for follow-ups. It has no
fixed turn deadline. Stop interrupts native work before bounded process-tree cleanup;
Windows launches use an executable and argument array without shell dispatch.
Native command, file, permission, and input requests return to the live app-server
request. Restart does not replay them. Actual subagent identities, lifecycle, and
public results remain separate from the main assistant answer. Tool events pair by
native call ID within their turn, with fallback for historical records without IDs.
Codex image-view items record the inspected screenshot path as a paired tool
input and result. The protocol item has no image bytes, so this does not render
the screenshot pixels in the conversation.

Run the maintained transport, transcript, approval, and discovery tests:

```sh
pnpm --dir packages/workbench exec tsx --test tests/codex-executor.test.mjs tests/codex-app-server.test.ts tests/codex-transcript.test.mjs tests/codex-active-state.test.mjs tests/codex-approval.test.ts tests/codex-models.test.ts tests/local-runtime-setup.test.ts
```

The optional `VIVARY_CODEX_POLICY_PROBE` test setting points to an installed Codex
executable. It checks effective permission rendering without starting a model turn.
Successful rendering does not establish operating-system sandbox execution. See the
[Workbench integration record](../README.md) for actual hosted and Windows proof.

## Host-owned conversation drafts

Issue #9 adds an opt-in `hostComposerDraft` interface to the existing chat
components. Vivary supplies a draft for the actual selected thread, waits for
that state before enabling the composer, and uses an explicit reset key when
restoring or clearing it. Routine autosave acknowledgements do not reset the
editor. The host ignores initial empty callbacks while the editor restores saved
text. Vivary supplies Core's route-controlled thread adapter so the editor and
page observe the same selected conversation. Saved host selection loads before
the chat mounts. Consumers that omit the draft interface retain Core's existing
behavior.

Host mode disables the browser and toolkit draft stores. Vivary persists text
through its authenticated `vivary-chat-draft` action and Native application
state. The key includes the owner, project, chat surface, and conversation.
Drafts are not messages and restoring one does not start execution. A conversation
with only an unsent draft may not have a Native thread row yet. If Native reports
that row missing, authenticated draft state retains its exact conversation ID.
Native also retains an ID that its own lifecycle marks as newly created, before
the first draft or message has been saved. An unknown missing ID keeps the normal
not-found behavior. In host mode, the Native thread hook allocates the initial
conversation ID. The tab wrapper defers to that ID instead of allocating another.
Existing thread rows still load their message history normally, even when they
also have an unsent draft. Vivary lists ID-only markers from the same
authenticated application-state owner so an unsent conversation stays in
history after another one becomes active. The marker holds an ID and timestamp,
never draft text or a second transcript. History derives its short preview and
Draft or Review send status from the authoritative draft record. Cleared drafts
stop appearing as draft-only rows. A started Code run exposes its first accepted
draft ID so later follow-ups reopen through run history. Older runs recover
that ID from a saved user event when one exists.

Each write compares the revision it observed. A cleared draft remains as an
empty tombstone, so a delayed save cannot recreate it. Before a send, the same
record retains a unique submission ID. Native carries that ID through its
existing queue and into the saved user message. A matching persisted message
or queued item settles the draft. An in-memory queue acknowledgement alone
cannot establish persistence. Code chat carries the same submission ID and
conversation key through its existing send action into the owned user event.
Reconciliation reads those existing run events without adding a transcript store.

If delivery remains uncertain, the UI retains a pending draft and offers Retry.
Restoring its text requires an explicit action with a duplicate-send warning.
Normal Discard draft also persists a tombstone. Request audit metadata remains
enabled, while the draft action excludes text inputs from the audit record.

The Toolkit patch adds `preserveDraftText` only for Core's host draft mode. It
reports line breaks, Unicode, and surrounding whitespace from the editor's
actual document. It restores that plain text with hard breaks so one saved line
break remains one visible line break. Consumers without host drafts keep
Toolkit's existing trimmed callback and paragraph restore behavior. Core keeps
the text-change callback stable while reading the latest host state. That
prevents a render from resetting the autosave timer or restoring stale editor
text after Discard.

The desktop close path waits for pending draft saves. If a save fails or times
out, the window remains open for retry. A browser can refuse navigation while
it has unsaved text, but its unload event cannot promise an awaited save. The
packaged desktop close and changed-port reopen passed on the unpublished
`250b402f` candidate. On-screen keyboard input remains unverified under #9.

Run the focused state and ownership checks with:

```sh
pnpm --dir packages/workbench test:chat-draft
```

These checks are included in `test:maintained`. Hosted restart and packaged
close checks are recorded in the [continuity receipt](../../../docs/product/multi-project/receipts/17a-chat-restart-and-drafts.md).
A follow-up under review gates host draft reads until the Native session is
ready. It verifies the exact owned thread before restoring a saved selection,
retains the unassigned Native history kind, and restores a Code draft after a
known local send refusal. The first `eb63459f` packaged retest exposed the
pre-read race. The focused follow-up checks passed on a dirty hosted build.
Clean-source packaged acceptance remains open.

The Windows keyboard case remains open under issue #9.

## Errors thrown after a request body is read

Issue #142. Core mounts framework routes, the Native chat POST among them,
through `getH3App(...).use`. Its wrapper in `server/framework-request-handler.js`
catches a handler's error and first asks `isClientAbortError` whether the
client left. That check counted any destroyed request stream as a client
abort. Node destroys a request stream once its body has been read to the end,
so every error a POST handler threw after reading its body was dropped as an
abort. h3 then answered 404 "Cannot find any route matching", and Core's chat
client posted the same turn nine times. The Native chat send guard's refusals
(#91) never reached the browser.

The patch changes that file in two places:

- `isClientAbortError` counts a destroyed request only when its body did not
  complete, and a destroyed response as before. A client that leaves after
  sending its body still destroys the response, so it is still an abort and is
  not logged as a server error.
- The JSON error response keeps the fields of an h3 error's `body`, as h3's own
  error response does, beside `error`. The guard's `errorCode` and
  `retryable: false` reach the chat client, which then shows the refusal once
  and does not send it again. A `stack` in that body is left out, so a stack
  still appears only when `AGENT_NATIVE_DEBUG_ERRORS=1`.

Run the focused checks with:

```sh
pnpm --dir packages/workbench exec tsx --test tests/native-chat-route-errors.test.ts tests/native-chat-project.test.ts
```

`native-chat-route-errors.test.ts` serves a route mounted through Core's
wrapper over a Node HTTP server and reads the body before the handler throws,
as Core's chat handler does. It is part of `test:native-chat`.

Every framework route mounted this way changes the same way. An
unauthenticated POST to a Native action throws its owner error after reading
the body, so it used to answer 404 and now answers 401.
`registry-http.test.mjs` pinned the old 404 with a comment naming this defect,
and now expects 401. The request is refused either way.

## Sidebar row menus from the keyboard

Issue #131. The Toolkit's chat history rows open a Radix dropdown menu from
their "Chat options" button. Its Rename, Pin, and Delete entries, and Vivary's
Archive, were plain buttons with `role="menuitem"` inside the menu content.
Radix moves focus, answers the arrow keys and typeahead, and handles Enter and
Space only for registered `DropdownMenu.Item` entries, so a keyboard user who
opened the menu could reach none of them.

The Toolkit patch changes `dist/chat-history/ChatHistoryList.js` and its types:

- A new `ChatHistoryMenuItem` wraps `DropdownMenu.Item` around the same button
  and classes, so the entry looks the same and Radix's keyboard navigation
  reaches it. `onSelect` runs on click, Enter, or Space.
- Rename, Pin, and Delete use it. `chat-history` exports it, and the
  `renderAdditionalRowActions` note says to render app entries with it.

Vivary's Archive entry in `ProjectHistory.tsx` is a `ChatHistoryMenuItem`.
Archive removes its row and the menu trigger that focus would return to. After
a confirmed archive, once the row is gone, focus moves to the row that took its
place, else the row before it, else New conversation (`app/lib/row-focus.ts`).
Archiving the open chat opens a new one, whose composer keeps focus. A failed
archive asks for no move, and a key or pointer press after Archive was chosen
leaves focus where the owner put it.

`native-chat-components.test.mjs` opens a row menu from the keyboard and checks
that every entry is a Radix item, and `row-focus.test.mjs` covers the focus
choice. A browser run of the built app walked the menu with the arrow keys and
typeahead, renamed with Enter, and archived, with focus landing on the next
row, the previous row, and the new chat's composer, at 1280 and 390 px.

## Composer focus while the owner types elsewhere

Issue #147. When a Native chat send was refused and its run ended, Vivary's
draft owner handed the text back to the composer. The Toolkit's composer set
the text and moved focus into itself unconditionally. If the owner was renaming
the chat in the sidebar at that moment, the rename field lost focus, its blur
saved the half-typed title, and the rest of the typing landed in the composer,
where Enter sent it to the model as a message.

The Toolkit patch changes `dist/composer/TiptapComposer.js`. A new
`composerMayTakeFocus` says whether the composer may take focus on its own: not
while the owner is typing in another field (an input, textarea, select, or
editable element outside the composer). `focusComposerAtEnd` replaces Tiptap's
`focus("end")` where the composer restores a saved draft, is handed new
`initialText`, and in its imperative `focus()` and `setText()`, which Core calls
when switching chat tabs and when prefilling a message. It moves the caret to
the end and focuses on the next frame, as Tiptap does, but checks
`composerMayTakeFocus` inside that frame, right before the DOM focus, so a field
the owner focused in between keeps it. With no field in use, or with focus on a
button, the composer still takes focus as before. `insertText()` is unchanged, because
it types through the browser's insert command, which needs the composer
focused.

`native-chat-components.test.mjs` hands the composer text through props,
`setText`, and `focus`, with another field in use and without, and once focuses
the other field after the composer asked for focus and before its frame, and
checks where focus lands. A browser run of the built app sent a message and renamed
the chat by mouse while the run ended: the title kept the whole name and
nothing was sent, in eight of eight runs.

## Native thread titles and previews without context

Issue #145. Vivary's composer appends the project's context to each message in
a `<context>` block, which the owner never typed. Core's `extractThreadMeta` in
`dist/agent/thread-data-builder.js` takes a saved thread's fallback title from
the first user message with text and its preview from the last, both from the
raw text. So the preview, and the title whenever no generated title replaced
it, showed that block, including the project's scope id.

The patch removes only the envelope that `appendAgentChatContextToMessage` in
`dist/shared/agent-chat-context.js` adds: from the first `\n\n<context>\n` to
the end, when the text ends with `\n</context>`. The cut starts at the first
opening because the context can hold its own block, and a later cut would show
the rest of it. A `<context>` the owner typed inline stays in the title. A
message that holds only context gives no title.

The limit. Core does not record where the appended context begins, and an app
may put any text in the context, including a block of the same shape. So in a
message that ends with a `</context>` line, the text is kept only up to the
first `<context>` line that follows a blank line. If the owner typed such a
line, the title and preview stop there, even when no context was appended. The
patch prefers a shorter title to one that shows context. Recording the boundary
would change how Core saves messages.

`native-thread-meta.test.mjs` builds messages with Core's own
`appendAgentChatContextToMessage` and checks the title and preview. It is part
of `test:native-chat`. On a loopback build the saved thread list showed a clean
preview; on `dev` the same send saved a preview holding the context block.

## Approval lifecycle retention and convergence

The Native run-store pruner exempts terminal chunks referenced by unfinished
waiting or resuming automation history. Ordinary terminal pruning and outcome
rollups remain active. A ready wait therefore keeps the SQL terminal evidence and
events required by the existing decision guard.

Migration 7 adds an approval outcome reconciliation marker to the existing history
owner. Terminal approval context retains its original task, resource and identity
binding. Unreconciled terminal rows survive history retention. The scheduler and
pending-task recovery sweeps finish recorded bookkeeping only. Task settlement
checks its retained platform, owner, organization, external thread and payload
binding. Resource writes combine their CAS with exact terminal history and chunk
identity and exclude newer history. Schedule calculation uses recorded completion
time, so retrying bookkeeping does not create another completion or delivery.
Repeated decisions may reconcile a terminal row but still refuse another decision.

The supported delete service refuses unfinished waiting or resuming history before
any resource, token or history mutation. Declared configured MCP tools await the
existing lazy initializer before entry construction. Local-only runs skip it.
Initializer failure remains a refusal and its existing rejected-promise reset
allows the next attempt to retry. Exact-call approval and current-entry validation
remain mandatory.

Installed-Core controls cover aged waits after real cleanup with ordinary pruning
as a positive control, deletion refusal and settled deletion, history-to-task and
task-to-resource storage failures, fresh-process terminal recovery, duplicate
decisions and exact configured-effect counts. Plugin expression controls exercise
held cold initialization, warm reuse, settings or discovery failure and retry,
plus all three restricted prompt paths with actual planted-file confinement.
These newly authored controls remain unrun until the controller refreshes the
maintained package after exact-source review.

### Approval recovery across durable owners

Pending-task custody repair matches the exact approval history, app, projected
owner, organization, thread, ask and webhook payload before a retry or settlement.
A processing or pending task can return to waiting after hard loss between the
two wait writes. No tool or model is redispatched during that repair. Native
liveness and consumed-ask checks still control the owner decision. Terminal task
and resource bookkeeping precede the existing claim-safe FIFO wake.

The pruning owner retains approval_context.runId as well as run_id and
resume_run_id while waiting or resuming. SQLite uses json_extract. PostgreSQL uses
a jsonb field selector. Both bind the original retained chunk, and ordinary
pruning resumes after settlement. Legacy manage-jobs deletion projects the
resolved execution identity through automationHistoryOwner before checking the
unfinished wait. Existing creator/admin authority and unattended mutation refusal
remain. Maintained tests distinguish selected SQL faults followed by SIGKILL from
ordinary thrown errors and cover normal owner recovery, attachment, pruning and
legacy deletion. Candidate runtime validation remains a controller gate.

The legacy deletion guard projects stored history scope independently of current
creator membership. Existing mutation authority permits org-admin cleanup of an
ordinary job after its creator leaves. Exact resource-bound unfinished histories
remain protected even if their scope conflicts with the current job metadata.
Unknown scope fails closed, and no execution or owner-decision eligibility changes.
Maintained controls use normal ORG/BetterAuth initialization and the actual
manage-jobs action, with real membership removal and explicit restoration only for
owner-decline cleanup. PostgreSQL pruning coverage is a static driver adapter and
query-contract control. It does not establish real PostgreSQL database execution.

Local SQLite transaction ownership queues ordinary execute calls and subsequent transactions behind the current transaction. Its callback must use the supplied tx.execute. Ownership is released after commit or rollback, including thrown callbacks. Organization history discovery queries exact org_id and caller email and treats missing membership as unavailable. Personal NULL-org history does not require membership in an unrelated active organization. The new SQLite controls are maintained runtime targets and have not run in this source allocation.

Webhook deletion initializes the existing webhook-token and app-secret schema owners before taking resource custody. It does not pre-delete token or secret data. Actual deletion stays on the transaction executor, together with history custody and resource mutation. Fresh-process controls seed the webhook in one process and delete or refuse it in another. Public closeDbExec uses the queued SQLite close owner before clearing the singleton. Close is memoized to avoid a second handle close. An old closed executor rejects later operations, while a new singleton can initialize normally. These new runtime controls remain unrun in the source sandbox.
