# Research: a native structured-state memory wedge

**Research snapshot:** 2026-07-22  
**Scope:** Current first-party product documentation, APIs, repositories, and
standards. Product-performance claims were not independently benchmarked.

## Executive finding

The proposed direction contains a real opportunity, but the original competitive
claim is too loose.

- **Letta is not Markdown-only.** Its durable memory blocks are string-valued and
  prompt-injected, and Letta Filesystem exposes parsed document contents through a
  filesystem metaphor. But Letta also accepts persisted image content in messages,
  serializes substantial agent state in AgentFile, shares memory between agents, and
  supports concurrent conversations and Git/worktree-based memory collaboration.
- **Supermemory does more than treat non-text as opaque objects.** It keeps a raw
  document layer and explicitly ingests images, audio, video, PDFs, code, JSON, and
  CSV. Its advertised retrieval and memory pipeline is nevertheless extraction-led:
  OCR, transcription, chunking, summaries, string-valued facts, and semantic graph
  relationships are the useful projections.
- **LangSmith is the strongest adjacent threat.** It already attaches images, audio,
  video, PDFs, and CSVs to traces and renders threads, child runs, tool activity, and
  nested subagent views. It is observability rather than a portable source of project
  truth, but it occupies much of the multimodal-timeline UX.

The defensible white space is therefore not “accept any media.” It is **native,
typed, inspectable state evidence**: preserve the source structure and causality of a
UI, application, database, and multi-agent run; derive searchable representations
without confusing them with the evidence; and bind observations to workspace
revisions, actors, privacy policy, and reviewed truth.

That direction fits Vivary only if it remains an optional, manifest-first evidence
layer over its deterministic typed graph. A capture daemon, hosted blob platform, or
general tracing UI would be a different product.

## Verified capability matrix

“Not documented” below means no first-party surface reviewed for this note advertised
the capability. It is not proof that a generic API or custom tool could not implement
it.

| System | Documented capability | Careful boundary / implication |
|---|---|---|
| **Letta memory blocks** | Blocks have labels and string `value`s, persist across interactions, are rendered into the prompt in an XML-like form, and can be attached to multiple agents for live shared memory ([memory blocks](https://docs.letta.com/guides/core-concepts/memory/memory-blocks)). | **Fact:** the core memory representation is text-centric. **Inference:** it is not a native representation of DOM, application-store, or database state, even though text or JSON could be placed in a block. |
| **Letta messages and files** | The message API accepts image content via URL, base64, or persisted Letta file; message histories contain structured user, assistant, reasoning, tool-call, tool-return, approval, summary, and event message types ([messages API](https://docs.letta.com/api/typescript/resources/agents/subresources/messages/methods/create)). Letta Filesystem represents parsed PDFs, transcripts, and documentation as folders/files that agents can open and grep ([filesystem](https://www.letta.com/blog/letta-filesystem/)). | **Fact:** “Letta is text-only/Markdown-only” is false. **Inference:** accepting an image and parsing documents is different from indexing a synchronized pixel + DOM + accessibility + application-state snapshot. No such capture contract was documented. |
| **Letta portable and concurrent state** | AgentFile serializes model configuration, complete message history, prompt, blocks, tool rules/code/schema, environment-variable slots, files/sources, groups, and MCP servers ([AgentFile](https://docs.letta.com/guides/core-concepts/agent-file)). Conversations share agent memory across concurrent sessions ([conversations](https://www.letta.com/blog/conversations/)); Context Repositories use Git and worktrees for parallel memory agents ([context repositories](https://www.letta.com/blog/context-repositories/)). | **Fact:** structured agent state and multi-agent memory collaboration are already covered. **Inference:** “multi-agent timelines” alone is not a wedge. Cross-runtime causal evidence tied to external application state may be. |
| **Supermemory ingestion** | Supermemory documents are raw inputs; supported inputs include PDFs, images, audio/video, code, JSON, CSV, and conversations. The documented pipeline performs OCR, descriptions/diagram interpretation, transcription, speaker/topic segmentation, chunking, embedding, and relationship indexing ([content types](https://supermemory.ai/docs/concepts/content-types), [how it works](https://supermemory.ai/docs/concepts/how-it-works)). The file endpoint retains a document ID, status, filepath, metadata, and optional custom ID ([upload API](https://supermemory.ai/docs/api-reference/ingest/upload-a-file)). | **Fact:** Supermemory does not merely store an opaque file and does not claim to discard the original document layer. **Inference:** its primary memory/retrieval abstraction is a semantic projection of rich media—chunks, text/facts, metadata, and `updates`/`extends`/`derives` relations—rather than a replayable application-state model. |
| **Supermemory structured inputs and graph** | JSON and CSV are supported, but examples send JSON as a string; the public graph component models document and memory `content` as strings plus shallow metadata and temporal relation types ([content types](https://supermemory.ai/docs/concepts/content-types), [memory graph](https://supermemory.ai/docs/integrations/memory-graph)). Hybrid search returns extracted memories or document chunks ([search](https://supermemory.ai/docs/search)). | **Fact:** Supermemory preserves raw documents and searches both facts and chunks. **Inference:** “native structure” would need to mean more than ingesting JSON—it would preserve versioned schemas, typed fields, diffs, provenance, and capture fidelity. That is not documented here. |
| **LangSmith multimodal traces** | LangSmith can upload binary images, audio, video, PDFs, and CSVs alongside traces; MIME type and binary content are retained as attachments ([trace attachments](https://docs.langchain.com/langsmith/upload-files-with-traces)). It can also render image inputs in multimodal LLM traces ([multimodal traces](https://docs.langchain.com/langsmith/log-multimodal-traces)). | **Fact:** multimedia attached to execution records is already a product capability. **Inference:** Vivary cannot differentiate on “screenshots attached to a timeline.” It would need typed state semantics, local portability, evidence/truth separation, and deterministic validation. |
| **LangSmith threads and subagents** | Runs can be grouped by thread; the UI shows turns and full traces. The Messages view includes reasoning, tool calls/results, and subagents; a subagent opens as a nested message view. Child runs are inspected with timing, cost, errors, and metadata ([threads](https://docs.langchain.com/langsmith/threads), [trace views](https://docs.langchain.com/langsmith/view-traces)). | **Fact:** nested multi-agent timeline inspection is substantially covered. **Inference:** the remaining gap is a vendor-neutral, workspace-owned causal record that can inform durable memory without becoming authoritative truth. |

## What is genuinely underserved

### 1. Structured application-state episodes — promising

Letta can serialize *agent* state, LangGraph/LangSmith can persist and trace execution
state, and Supermemory can ingest JSON. The reviewed products do not document a
portable episode that preserves an arbitrary application's typed state with:

- a versioned schema and source/runtime identity;
- before/after state or a deterministic diff;
- capture time, workspace revision, actor, action, and causal parents;
- pointers to visual/network/database evidence;
- explicit redaction, retention, authority, and confidence labels; and
- derived text/embeddings that can be rebuilt from the evidence.

This is the best version of the wedge. “Native” must mean schema-preserving and
queryable as structure, not merely serializable to JSON.

### 2. UI memory — promising only as a synchronized evidence bundle

Screenshots alone are commoditized. Playwright already records action-by-action traces
with before/after page state, interactive DOM snapshots, source, network, logs, errors,
and console output ([Trace Viewer](https://playwright.dev/docs/trace-viewer-intro)).
LangSmith can attach and display the screenshots.

The underserved unit is a **synchronized UI observation**: screenshot/video frame +
DOM/layout + accessibility tree + URL/navigation identity + input/action + relevant
application state, all captured at one logical time and linked to the resulting state
transition. This allows both human visual inspection and semantic agent queries such
as “the Save button was visible but disabled after agent B changed field X.”

### 3. Database schema and runtime-state memory — plausible, high-risk

Database products already expose their own snapshots. PostgreSQL can emit object
definitions without data via `pg_dump --schema-only` ([pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html))
and exposes current activity/statistics through `pg_stat_activity` and related views
([monitoring](https://www.postgresql.org/docs/current/monitoring.html)). What appears
missing is a memory-layer contract that binds a sanitized schema/runtime observation to
the application version, agent action, test result, and later schema change.

This could answer valuable questions—“which schema was actually running when this
migration failed?”—but there is no universal cross-database runtime snapshot. Adapters
and redaction policy would be unavoidable.

### 4. Multi-agent collaborative timelines — mostly covered; narrow the claim

Letta has concurrent conversations, shared blocks, parallel agents, and Git-backed
memory worktrees. LangSmith has hierarchical traces, threads, and nested subagent
views. OpenTelemetry already models parent/child spans, timestamped events, and causal
links across traces.

The narrower opportunity is a **portable evidence ledger across runtimes**: claims,
work ownership, handoffs, observations, and state transitions linked causally to the
same workspace revision and review gates. It should not compete with LangSmith on
hosted trace UX or with Letta on agent runtime.

## Implementation-relevant standards and capture primitives

These are adapters or envelope precedents, not reasons to copy their internal storage
formats into Vivary.

| Primitive | Relevant documented behavior | Use / caution |
|---|---|---|
| [Chrome DevTools Protocol DOMSnapshot](https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/) | `captureSnapshot` returns flattened DOM trees including frames/templates plus layout, selected computed styles, rectangles, and optional paint order. | Strong Chromium capture source. The domain and tip-of-tree protocol are experimental/unstable; normalize into a versioned Vivary-owned manifest. |
| [Chrome DevTools Protocol Accessibility](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/) | `getFullAXTree` returns the accessibility tree with roles, properties, relationships, and states. | Useful semantic complement to pixels/DOM; experimental and potentially reveals content not visually obvious. |
| [Playwright traces](https://playwright.dev/docs/trace-viewer-intro) and [ARIA snapshots](https://playwright.dev/docs/aria-snapshots) | Trace Viewer correlates actions, DOM snapshots, screenshots, network, logs, console, errors, and source. ARIA snapshots provide a YAML representation of roles/names/states/hierarchy. | Excellent reference capture and import source. Treat `trace.zip` as a tool artifact, not a promised stable interchange standard. |
| [W3C WebDriver BiDi](https://www.w3.org/TR/webdriver-bidi/) | Defines cross-browser browsing-context, script, network, log, screenshot, and related commands/events. | Better long-term cross-browser seam, but the current specification is a Working Draft and does not itself define a memory episode. |
| [OpenTelemetry traces](https://opentelemetry.io/docs/concepts/signals/traces/) and [Tracing API](https://opentelemetry.io/docs/specs/otel/trace/api/) | Spans carry IDs, parentage, timestamps, attributes, events, status, and links to causally related spans in the same or different traces. | Reuse correlation semantics for agent/action timelines. Store large artifacts by content hash/pointer, not in attributes. |
| [W3C Trace Context](https://www.w3.org/TR/trace-context/) | Standard HTTP headers propagate request/trace identity between services. | Useful for joining app, agent, browser, and database observations without inventing transport headers. It does not define the observation payload. |
| [JSON Schema 2020-12](https://json-schema.org/draft/2020-12) | Versioned validation vocabulary for structured JSON instances. | Suitable for capture-envelope and modality-manifest validation while keeping raw artifacts external. |

## Strategic implications for Vivary

Vivary's current architecture is explicitly deterministic, typed, plain-file, local,
minimal, and review-gated. Its own [architecture](ARCHITECTURE.md) calls the filesystem
and typed Markdown/YAML graph authoritative truth; [harness strategy](HARNESS-STRATEGY.md)
already separates authoritative truth, evidence, learned memory, and bounded active
context. That separation is more strategically useful than a generic “multimodal”
label.

The compatible shape is:

1. **Raw evidence remains raw and immutable.** Binary or high-volume captures live
   outside Markdown and are addressed by digest. They are evidence, never truth.
2. **The typed graph stores small manifests and relationships.** A manifest can name
   capture type/version, hash, source/runtime, timestamp, actor, workspace revision,
   causal parents, sensitivity/retention class, and derived indexes. The graph remains
   inspectable and deterministic.
3. **Derived representations are disposable.** OCR, captions, embeddings, DOM text,
   summaries, and proposed facts are rebuilt indexes or learning candidates. They do
   not silently replace the capture or promote themselves into project truth.
4. **Capture is adapter-led and opt-in.** Playwright/CDP, a database, or a runtime
   produces evidence; Vivary validates and links the envelope. Core does not become a
   browser recorder, database monitor, model router, or hosted blob service.
5. **Retrieval is progressive.** An agent should first receive a compact state packet,
   then request a DOM subtree, screenshot, trace segment, or schema fragment only when
   needed. Loading rich state by default would violate Vivary's context-cost law.

This suggests a narrow experiment such as a **State Evidence Pack** format and two
adapters (one browser trace, one database schema), evaluated against concrete recovery
questions. It does **not** justify repositioning the whole product or broad code work.
If success requires continuous capture, cloud retention/search, cross-device sync,
video processing, and a trace UI, that is likely a separate product—possibly using
Vivary manifests as its portable export.

## Privacy, security, storage, and cost risks

- **Screens are secret-dense.** Pixels, DOM, accessibility trees, console/network data,
  clipboard/input state, and hidden nodes can expose credentials, private messages,
  customer data, and anti-CSRF/session tokens. AX/DOM capture may reveal content not
  visible in a screenshot.
- **Database runtime state is more sensitive than schema.** Activity views may include
  query text, users, client addresses, locks, and workload patterns. Schema dumps expose
  topology and privilege design. Collection must be least-privilege, allowlisted, and
  redacted before persistence.
- **Replay is an execution boundary.** PostgreSQL warns that restoring a dump can
  execute code chosen by source superusers. Browser traces and captured pages also
  contain untrusted content. Evidence should be inspectable but never automatically
  replayed or restored.
- **Volume grows faster than useful memory.** Screenshots, DOM/layout trees, network
  bodies, video, and high-frequency runtime samples can produce gigabytes quickly.
  Content hashing, delta capture, quotas, sampling, expiry, and tiered storage are
  mandatory. Git is a poor default store for large changing binaries.
- **Extraction multiplies cost and deletion work.** Vision/OCR/transcription,
  embeddings, summaries, and replicas add compute and storage. Deleting source data
  must also invalidate derived text, embeddings, caches, and graph edges.
- **Content-addressing complicates privacy.** Deduplication can leak cross-tenant
  existence and make deletion ambiguous. Encryption and dedupe scope must respect
  project/user boundaries.
- **Timelines can become surveillance.** Multi-agent and UI capture needs explicit
  consent, actor attribution, private scopes, retention defaults, and a way to capture
  proof without retaining raw prompts or human activity indefinitely.
- **Capture fidelity decays.** Browser/protocol versions, dynamic content, external
  services, and missing environment images can make “replayable” an overclaim. Prefer
  “inspectable and revision-bound” unless deterministic replay is actually proven.

## Conclusion

**Pursue the idea only under a sharper thesis: _Vivary remembers the structure and
causality of state, not just what a model extracted from it._**

The original comparison is not safe positioning. Letta already has multimodal message
input, portable structured agent state, and multi-agent memory. Supermemory already
ingests rich media, keeps a document layer, and turns it into searchable text/facts.
LangSmith already owns much of multimodal, nested execution inspection.

Vivary's credible advantage is its existing trust model: deterministic typed truth,
separate evidence, rebuildable derived memory, local plain-file manifests, provenance,
and human gates. A small state-evidence format could deepen that advantage. A generic
multimodal memory engine would dilute it and enter a market where ingestion, graph
memory, and trace visualization are already well covered.

## Residual uncertainty

- These products change quickly; this note reflects public first-party surfaces as of
  the research date, not private roadmaps or enterprise-only behavior.
- Absence of a documented DOM/app/database snapshot type is not proof that generic
  files, metadata, custom tools, or attachments cannot carry one.
- No hosted product was exercised and no ingestion/retrieval fidelity, latency, cost,
  deletion, or replay claim was benchmarked.
- The commercial value of state episodes remains a hypothesis until users repeatedly
  recover a failure, resume work, or verify a decision faster than they can with an
  ordinary trace plus repository history.

## Primary sources consulted

- Letta: [memory blocks](https://docs.letta.com/guides/core-concepts/memory/memory-blocks),
  [message API](https://docs.letta.com/api/typescript/resources/agents/subresources/messages/methods/create),
  [AgentFile](https://docs.letta.com/guides/core-concepts/agent-file),
  [filesystem](https://www.letta.com/blog/letta-filesystem/),
  [conversations](https://www.letta.com/blog/conversations/), and
  [context repositories](https://www.letta.com/blog/context-repositories/).
- Supermemory: [how it works](https://supermemory.ai/docs/concepts/how-it-works),
  [content types](https://supermemory.ai/docs/concepts/content-types),
  [ingestion](https://supermemory.ai/docs/add-memories),
  [file upload API](https://supermemory.ai/docs/api-reference/ingest/upload-a-file),
  [search](https://supermemory.ai/docs/search), and
  [memory graph component](https://supermemory.ai/docs/integrations/memory-graph).
- LangSmith: [trace attachments](https://docs.langchain.com/langsmith/upload-files-with-traces),
  [multimodal traces](https://docs.langchain.com/langsmith/log-multimodal-traces),
  [threads](https://docs.langchain.com/langsmith/threads), and
  [trace views](https://docs.langchain.com/langsmith/view-traces).
- Capture/interop: [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer-intro),
  [Playwright ARIA snapshots](https://playwright.dev/docs/aria-snapshots),
  [CDP DOMSnapshot](https://chromedevtools.github.io/devtools-protocol/tot/DOMSnapshot/),
  [CDP Accessibility](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/),
  [WebDriver BiDi](https://www.w3.org/TR/webdriver-bidi/),
  [OpenTelemetry traces](https://opentelemetry.io/docs/concepts/signals/traces/),
  [W3C Trace Context](https://www.w3.org/TR/trace-context/), and
  [JSON Schema 2020-12](https://json-schema.org/draft/2020-12).
- Database capture: [PostgreSQL `pg_dump`](https://www.postgresql.org/docs/current/app-pgdump.html)
  and [monitoring database activity](https://www.postgresql.org/docs/current/monitoring.html).
