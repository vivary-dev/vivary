# Vivary: a minimal standard for agent-native workspaces

**Technical white paper · Version 0.2 · July 2026**

**Status:** Design and implementation paper. Not peer reviewed.

**Project:** [Vivary](https://github.com/vivary-dev/vivary)

**License:** MIT for the implementation; this document is distributed with the
repository.

## Abstract

Language-model agents can search, edit, execute tools, and coordinate work, yet the
projects they enter are rarely organized for reliable machine operation over time.
Important facts are distributed across source files, prose, issue trackers, chat
history, generated artifacts, and improvised memory. Instructions accumulate at the
root until they compete with the task for context. Search retrieves matching text
without establishing ownership, currency, relationship, or sensitivity. Optional
memory systems can improve recall while also creating a second, stale source of
truth. Finally, the tool interface often treats reading a file and publishing a
release as actions of the same kind even though their consequences differ radically.

Vivary proposes a minimal, portable standard for an **agent-native workspace**: a
project environment whose durable truth, current state, retrieval routes,
verification procedures, privacy boundaries, and human gates are legible to both
people and agents. The standard combines a typed graph over plain files, a small
operating contract with progressive disclosure, deterministic review, and optional
coordination. Networked providers, semantic recall, embedded storage, daemons, and
protocol servers are capability edges rather than hidden prerequisites.

The implementation currently provides deterministic graph validation and query,
bounded context packets, read-only filesystem mapping, additive brownfield adoption,
workspace health checks, graph-aware review, privacy-preserving receipts, optional
semantic-memory adapters, and multi-agent conflict and claim surfaces. It does not
yet prove the paper's central product hypothesis: that this structure reduces the
tokens, turns, wrong-file opens, unsupported claims, and time required to find and
safely act on project truth. This paper therefore distinguishes implemented behavior
from proposed behavior and unmeasured outcomes, and defines a reproducible evaluation
protocol intended to make the hypothesis falsifiable.

## Executive summary

Agent performance is partly a property of the model and partly a property of the
environment presented to it. Research on long-context use shows that providing more
context does not guarantee reliable use of the relevant evidence, especially when
that evidence appears in the middle of a large input [1]. Research on
agent-computer interfaces similarly shows that interface design can materially
change how an agent navigates, edits, and verifies work [2]. These findings do not
validate Vivary, but they motivate its premise: **workspace design is a first-class
part of agent-system design**.

Vivary's proposal has four parts:

1. **Typed project truth.** Plain Markdown and configuration files remain canonical.
   Types and relationships produce a validated graph that can answer what an object
   is, where it lives, what it depends on, and what depends on it.
2. **Progressive disclosure.** Root instructions route rather than warehouse detail.
   Agents retrieve bounded, task-relevant context and follow explicit links deeper
   only when needed.
3. **Verification before consequence.** Deterministic checks, blast-radius analysis,
   and dry runs precede mutations. Consequential actions stop at explicit human
   gates.
4. **Optional intelligence at explicit edges.** Semantic memory, vector indexes,
   source-code retrieval, MCP, and network providers can extend retrieval, but they
   do not silently become project truth or baseline dependencies.

The smallest useful Vivary workspace is not a platform installation. It is a
portable contract:

- one visible current-state surface;
- one canonical owner for each durable fact;
- typed and validated relationships;
- small routing files;
- private boundaries;
- a repeatable `Ask → retrieve → act → verify → learn → gate` protocol;
- commands that can verify the contract without calling a model or network service.

The implementation is organized into four atmospheric layers:

- **Tropo** — typed project truth, retrieval, map, and impact;
- **Strato** — state, routing, skills, privacy boundaries, and the operating loop;
- **Ozone** — deterministic review, context-budget checks, and gates;
- **Exo** — optional claims, conflicts, boards, and role contracts when one agent
  becomes many.

The paper makes three different kinds of statements and labels them accordingly:

- **Implemented and verified:** behavior present in the public repository and covered
  by tests or reproducible commands.
- **Specified but incomplete:** behavior defined by an interface or roadmap but not
  complete across supported environments.
- **Proposed or not yet measured:** product outcomes, comparative performance, or
  future capabilities that require published evidence.

The most important unmeasured hypothesis is:

> For fixed project-understanding and change-impact tasks, an agent using Vivary's
> deterministic map, typed retrieval, and routing surfaces will require less context
> and fewer irrelevant file opens to produce a supported answer than the same agent
> using an unstructured project baseline.

The paper does not present benchmark numbers because the benchmark has not yet been
published. The absence of that evidence is a current limitation, not a detail to be
hidden in marketing language.

## 1. Problem statement

### 1.1 The operational environment is part of the agent system

A model does not operate on a project directly. It receives a representation of that
project through prompts, selected files, tool results, indexes, summaries, and
interfaces. The quality of those surfaces influences what the agent can discover,
what it mistakes for current truth, and what it can verify.

This distinction matters because model capability and environment quality can mask
each other. A strong model can compensate for a poor workspace by repeatedly
searching, reopening files, and reconstructing relationships. A well-organized
workspace can make a weaker model appear more reliable by exposing ownership,
boundaries, and stop conditions. Neither observation implies that workspace design
can remove model limitations. It means that system evaluation should not treat the
workspace as neutral.

SWE-agent's work on agent-computer interfaces argues and demonstrates within its
evaluated software-engineering tasks that interface design affects agent behavior
and performance [2]. Vivary extends that intuition from an interactive shell
interface to the durable project environment itself.

### 1.2 More context is not the same as better context

Modern models can accept large inputs, but the relevant engineering question is not
only whether a token fits. It is whether the model can reliably locate and use the
right evidence in the supplied context. “Lost in the Middle” found substantial
position sensitivity in multi-document question answering and key-value retrieval,
including degraded performance when relevant information appeared in the middle of
long contexts [1].

Vivary does not infer from that work that short context is always superior or that
long-context models are ineffective. The narrower inference is that **context
selection and ordering remain system responsibilities**. Loading an entire
repository, vault, or operating manual “just in case” can be both expensive and
unreliable. A workspace should help an agent identify a small first set, preserve
provenance, and expand deliberately.

### 1.3 Project truth is fragmented and weakly typed

Durable project knowledge commonly appears in several forms:

- source and configuration files;
- README and architecture documents;
- decisions, changes, and release notes;
- issue trackers and pull requests;
- generated documentation;
- chat transcripts and handoffs;
- user preferences and private memory;
- provider indexes and caches.

These forms differ in authority, freshness, sensitivity, and cost. A raw search
result does not explain whether a matching paragraph is normative, historical,
generated, private, superseded, or speculative. When the workspace does not encode
those distinctions, the agent must infer them from prose on every task.

The failure is not “files are bad.” Files are inspectable, portable, and versionable.
The failure is the absence of a small, enforceable model for type, identity,
relationship, ownership, and routing.

### 1.4 Flat instructions and memory accumulate structural debt

Agent-enabled projects often begin with reasonable additions: an instruction file, a
status note, a memory file, a collection of prompts, and perhaps a provider index.
Without ownership and lifecycle rules, those additions tend to grow by append.

Three forms of debt result:

1. **Instruction debt:** every newly learned rule becomes always-on context even when
   relevant to one module or rare workflow.
2. **Truth debt:** summaries and memories copy facts instead of linking to their
   owner, creating contradictions after change.
3. **Retrieval debt:** an agent must search across increasingly many undifferentiated
   surfaces before it knows which one deserves trust.

The system can appear more knowledgeable while becoming harder to operate.

### 1.5 Retrieval without provenance can become a second truth system

Retrieval-augmented generation established the value of combining parametric models
with non-parametric memory and also identified provenance and knowledge updating as
central problems [3]. In a project workspace, those problems are concrete. A
semantic hit may point to a deleted file, a private note, an old decision, or an
untyped chunk with no current owner.

Vivary treats semantic retrieval as **candidate generation**, not adjudication. A
provider result is useful only if it resolves to a current typed project object and
survives the workspace's privacy and freshness checks. The canonical fact remains in
the inspectable project surface.

### 1.6 Tool access collapses actions with different consequences

Agent runtimes expose many operations through a uniform mechanism: read, write,
execute, send, publish, purchase, delete, or authorize. Uniform invocation should not
imply uniform authority.

Reading a public documentation file is low consequence and reversible. Publishing a
release, emailing a customer, deleting a directory, enabling a network provider, or
merging a protected branch crosses a durable boundary. A reliable workspace needs an
explicit model of when autonomous work stops and accountable human authority resumes.

## 2. Scope, terminology, and assumptions

### 2.1 Scope

Vivary addresses the local project environment used by one or more tool-capable
language-model agents and the humans responsible for that project. The standard
covers:

- durable project knowledge represented in ordinary files;
- typed identity and relationship metadata;
- routing and bounded retrieval;
- current state and repeatable operating procedures;
- local validation and review;
- privacy exclusions and provider boundaries;
- human approval at consequential edges;
- optional multi-agent coordination.

Vivary does not define a model architecture, prompting method, hosted agent runtime,
general identity provider, organization-wide authorization service, or universal
task planner.

### 2.2 Terminology

| Term | Meaning in this paper |
|---|---|
| **Agent** | A language-model-driven process that can inspect context, choose actions, and use tools. |
| **Workspace** | The bounded project tree plus the durable operating contract used by people and agents. |
| **Agent-native workspace** | A workspace whose truth, state, routes, verification, boundaries, and gates are explicitly legible to agents and people. |
| **Canonical truth** | The single durable owner of a project fact. A cache, summary, or index may point to it but does not silently replace it. |
| **Typed node** | A project object with an identity, type, path, and validated fields. |
| **Edge** | A declared relationship between typed nodes, such as dependency, ownership, review, or gate. |
| **Routing surface** | A small file whose primary job is to direct the reader toward deeper canonical context. |
| **Active context** | Material supplied to the model for the current task or turn. |
| **Context packet** | A bounded, ordered retrieval result with typed identity and provenance. |
| **Gate** | A stop condition requiring a specific human decision before a consequential action. |
| **Provider** | An optional external or local capability such as semantic memory, embeddings, or an index. |
| **Receipt** | A privacy-preserving record of an operation's command class, status, counts, and verification—not a raw transcript. |
| **Brownfield adoption** | Adding Vivary's operating surfaces to an existing project without reorganizing its existing files. |

### 2.3 Assumptions

The design assumes:

- the project has a meaningful filesystem boundary;
- at least some durable project truth can be represented or referenced from files;
- Git or another versioning mechanism may be available but is not required for basic
  graph operation;
- the agent runtime can read files and run approved commands;
- a human remains accountable for consequential external actions;
- deterministic checks are valuable even when they cannot establish semantic truth;
- optional providers may fail, become stale, or be absent.

### 2.4 Non-assumptions

The design does not assume:

- one model vendor, editor, operating system, or cloud;
- constant network access;
- embeddings or semantic retrieval;
- an always-running daemon;
- a trusted model output;
- that every project fact should be remembered;
- that more agents improve every task;
- that a clean graph proves the underlying prose or code is correct.

## 3. Design requirements

The following requirements constrain the implementation. They are deliberately more
important than feature count.

### R1. Minimal always-on context

Root-level instructions and state must remain small enough to route. Durable detail
belongs in the owning document, module, or reusable skill. This requirement reduces
baseline context cost and makes growth visible.

### R2. One canonical owner per durable fact

Indexes, status summaries, and generated pages should link to an owner rather than
copying durable detail. When duplication is unavoidable for presentation, the
derived surface must identify its canonical source and be regenerable or reviewable.

### R3. Inspectable and portable baseline

The baseline representation must be readable with ordinary tools and diffable
without a proprietary service. Markdown, YAML frontmatter, TOML, and directory
structure satisfy this requirement for the current implementation.

### R4. Deterministic, dependency-light core

Graph construction, validation, basic retrieval, mapping, and review should not
require a model, embedding provider, network call, or daemon. Optional capability
failure must not make baseline project truth unavailable.

### R5. Progressive disclosure

The workspace should return a bounded first packet and an explicit route to more,
instead of assuming that all potentially relevant content belongs in active context.
The packet must retain typed identity and source path.

### R6. Read and preview before mutation

Inspection should have a read-only path. Project adoption and repair should expose a
dry run or proposal before writing. Brownfield adoption should begin additively and
must not silently move or rewrite existing material.

### R7. Fail-closed privacy boundaries

Ignored, private, linked-outside-root, or unknown-sensitivity content must not enter
an optional provider merely because it is discoverable by the operating system.
Provider preparation should fail closed when the safety of a file cannot be
established.

### R8. Explicit capability edges

Embeddings, semantic memory, embedded databases, network calls, MCP servers, and
background services require explicit installation or configuration. Their state is
cache or capability state, not an invisible new canonical store.

### R9. Human authority at consequential edges

Approval must be scoped to the action being approved. A previous approval to edit
files does not imply permission to push, publish, send, purchase, disclose, or
destroy. The system should make the proposed action and blast radius legible before
the decision.

### R10. Evidence before expansion

Claims about context savings, retrieval quality, adoption, or retention require a
published method and result. New complexity should not be justified by an
unmeasured headline. The roadmap should prefer proof of the core loop over a larger
surface area.

These requirements echo established security principles including economy of
mechanism, fail-safe defaults, complete mediation, and least privilege [4]. Vivary
does not claim to implement a complete authorization system; it applies those
principles to workspace defaults, provider boundaries, and approval semantics.

## 4. System model and invariants

### 4.1 Conceptual model

Let a workspace be represented as:

`W = (F, N, E, R, S, P, G, C)`

where:

- `F` is the set of files within the resolved workspace boundary;
- `N` is the set of typed project nodes derived from eligible files;
- `E` is the set of declared, validated relationships among nodes;
- `R` is the set of routing surfaces;
- `S` is the visible current-state surface;
- `P` is the set of privacy and ignore rules;
- `G` is the set of gates and consequential action classes;
- `C` is optional capability configuration.

This notation is a design aid, not a mathematical proof of correctness. It makes the
ownership boundaries precise enough to test.

The deterministic graph is a projection:

`Graph(F, schema, P) → (N, E, findings)`

Retrieval is a bounded selection:

`Retrieve(query, N, E, budget, filters) → packet`

An optional provider may produce candidates:

`ProviderRecall(query, ProviderIndex) → candidates`

but candidates become eligible context only after:

`Resolve(candidate.id, N) ∧ Privacy(candidate, P) ∧ Fresh(candidate, W)`

If any predicate fails, the candidate is rejected or marked unavailable. Provider
ranking does not override graph identity or project ownership.

### 4.2 Core invariants

#### I1. Canonical ownership

Every durable fact promoted as project truth has one identified owner. Derived
surfaces are subordinate.

#### I2. Boundary preservation

Graph and provider operations resolve paths against the workspace root and enforce
ignore/private rules. A linked or escaped path is not made safe by being reachable.

#### I3. Deterministic availability

The baseline graph remains usable without optional providers, model calls, or
network access.

#### I4. Bounded retrieval

A context packet has an explicit budget or limit and identifies the nodes and paths
from which it was constructed.

#### I5. Previewable mutation

When a normal workflow can preview a consequential file mutation, the preview
precedes the write. Brownfield adoption is additive in its initial phase.

#### I6. Provider non-authority

Provider state is disposable and rebuildable. If provider state conflicts with
current canonical files and graph validation, the files and graph win.

#### I7. Monotonic restriction

Nested schema overlays may tighten requirements but must not silently loosen an
inherited strict rule. This is implemented in Tropo's tighten-only overlay law.

#### I8. Explicit consequence

An action that crosses a durable, destructive, privacy, financial, or public
boundary requires a specific gate decision unless the responsible human has defined
an equally specific standing policy.

#### I9. Receipt minimization

A receipt records enough to audit the class and outcome of an operation without
defaulting to raw query text, private content, absolute local paths, or complete
stdout/stderr.

### 4.3 Workspace state transitions

A typical operation moves through:

`unoriented → retrieved → proposed → verified → gated → committed`

- **unoriented:** the task exists but the relevant project truth has not been
  established;
- **retrieved:** a bounded set of candidate context with provenance is available;
- **proposed:** the intended change and affected surfaces are named;
- **verified:** deterministic checks or task-specific review have run;
- **gated:** any required human decision is pending or recorded;
- **committed:** the approved durable or outward-facing action has completed and its
  result is verified.

Not every task reaches every state. A read-only question may stop after retrieval and
verification. A failed check returns the operation to proposal or retrieval. A denied
gate terminates the consequential path without erasing completed local analysis.

## 5. Architecture

### 5.1 Layer model

Vivary uses an atmospheric metaphor to distinguish responsibilities:

```text
      exo      optional multi-agent claims, conflicts, boards, roles
     ozone     deterministic review, impact, context-budget and editorial gates
    strato     state, routing, skills, privacy, operating and learning loops
   tropo       typed graph, validation, retrieval, map, query, impact
```

The metaphor is mnemonic, not a dependency requirement. Tropo and the Strato
workspace contract form the baseline. Ozone and Exo are composable tools.

### 5.2 Tropo: typed project truth

Tropo derives type primarily from directory placement and validates frontmatter
against workspace schemas and packs. It creates typed nodes and relationships while
leaving the underlying files human-readable.

Implemented command families include:

- `check` for schema, link, and relationship validation;
- `find` for bounded typed context packets;
- `query` for graph-aware text, stored-vector, or optional semantic candidates;
- `map` for read-only filesystem inventory without prior configuration;
- `graph`, `blast`, and `view` for relationship and impact inspection;
- `plan` and migration-related commands for reviewable changes.

Tropo's value is not that a graph database replaces the filesystem. The graph is a
validated projection over the files. It adds identity, type, relationship, and
impact while preserving ordinary inspection and version control.

The deterministic baseline uses dependency-light code. Optional embedded storage and
stored vectors are explicit configurations. Semantic query is allowed to degrade to
graph or text behavior when the provider is missing or stale.

### 5.3 Strato: the workspace operating contract

Strato is currently distributed as scaffolded workspace files and reusable agent
skills rather than a standalone package. It establishes:

- root routing instructions;
- one visible current-state surface;
- module indexes for progressive disclosure;
- private user and memory boundaries;
- reusable skills and verification commands;
- the inner and outer operating loops;
- human-gate expectations.

The inner loop is:

`Ask → retrieve → act → verify → learn → gate`

The outer loop periodically decides whether repeated learning deserves a durable
home in state, memory, a playbook, a module router, or a skill. It must also delete,
merge, or demote stale material. “Remember everything” is incompatible with minimal
active context.

### 5.4 Ozone: deterministic review and impact

Ozone operates over the same graph and currently supplies deterministic rule packs:

- **structure** for graph completeness and topology;
- **context-budget** for oversized or duplicated routing surfaces and missing module
  indexes;
- **editorial** for writing-workspace review coverage.

`ozone review --strict` turns warnings into a nonzero gate result. `ozone impact`
uses graph relationships to identify dependents. The checks are deterministic
signals, not a substitute for code tests, editorial judgment, security review, or
human accountability.

### 5.5 Exo: optional coordination

Exo addresses coordination only when multiple agents or work streams justify it. It
currently provides:

- boards grouped by work-item state;
- explicit assignee claims;
- conflict detection for active work touching shared graph nodes;
- role contracts.

Claims remain ordinary frontmatter and are validated by the same graph. Exo refuses
unsafe claim targets such as linked or out-of-workspace files. The design favors
visible ownership over hidden orchestration state.

### 5.6 Optional capability plane

Optional capabilities include:

- embedded file or vector storage;
- semantic memory providers;
- source-code retrieval sidecars;
- the development-source read-only MCP adapter;
- provider-specific caches and indexes.

Each capability has four required boundaries:

1. **install boundary** — what dependency or service becomes present;
2. **data boundary** — what content may be read, transformed, cached, or transmitted;
3. **authority boundary** — which writes or network calls require approval;
4. **failure boundary** — how baseline behavior degrades when the capability is
   absent, stale, or broken.

MCP's published architecture separates host, client, and server responsibilities and
places authorization and consent at explicit components [5]. Vivary treats MCP as an
optional interoperability surface, not as the canonical project model. The current
development-source slice uses local standard input/output, exposes exactly four
read-only tools over operator-bound roots, and adds no baseline or Core dependency.
Named-client compatibility and external conformance remain unproven. The canonical
[MCP adapter guide](MCP.md) owns its data, authority, failure, and install boundaries.

### 5.7 Data flow

The normal retrieval path is:

```text
task
  ↓
root router and visible state
  ↓
typed graph filters and bounded retrieval
  ↓
canonical files and declared relationships
  ↓
optional provider candidates, if explicitly enabled
  ↓
privacy, freshness, and graph-identity checks
  ↓
ordered context packet with provenance
```

The normal change path is:

```text
task → retrieve → propose files and blast radius → dry run or edit
     → deterministic checks → task-specific tests/review
     → human gate if consequential → commit/publish → verify outcome
```

## 6. Operating protocol

### 6.1 Ask

The task is normalized into a concrete question or outcome. Before opening large
surfaces, the agent identifies likely truth owners, affected modules, constraints,
and whether the task may cross a gate.

The ask phase should distinguish:

- a request for explanation from a request to mutate;
- a local change from an outward-facing action;
- known facts from assumptions;
- a task that can be answered deterministically from one that needs model judgment.

### 6.2 Retrieve

Retrieval begins with the smallest credible route:

1. read the root routing contract and visible state;
2. query or find typed nodes using task-relevant filters;
3. inspect the owning module index;
4. open canonical files and declared dependents;
5. expand the packet only when evidence remains insufficient.

A context packet should answer:

- what nodes were selected;
- why they were selected;
- where their canonical files live;
- which relationships matter;
- what was excluded by budget, filter, or privacy rule.

This is related to retrieval-augmented generation but narrower in authority.
Provider results remain leads. The project graph and files retain ownership.

### 6.3 Act

The agent names the intended mutation and blast radius before applying it. For a
small local edit, the blast radius may be a short file list. For a schema, release,
policy, or public-copy change, it includes generated surfaces, package truth,
downstream documentation, and external consequences.

Normal implementation should proceed in small verifiable slices. If the task has a
clear test seam, the focused failing test precedes the implementation.

### 6.4 Verify

Verification is proportional to consequence:

- graph checks for schema and relationship integrity;
- unit tests for local behavior;
- parity checks for generated or scaffolded assets;
- static build and link checks for public documentation;
- browser checks for interaction and responsive layout;
- security review for provider, path, credential, or authority changes;
- external-state verification after publish, merge, or deployment.

A clean deterministic check proves only what the check encodes. The verification
record should avoid claiming broader semantic correctness.

### 6.5 Learn

Learning is a lifecycle decision, not an unconditional append. A new observation may
be:

- transient and not retained;
- recorded in current state;
- assigned to an existing canonical document;
- distilled into a reusable skill or test;
- added as an issue or roadmap item;
- rejected because it duplicates or contradicts stronger truth.

The outer loop should periodically remove stale routing, merge duplicated lessons,
and check whether always-on context has grown without sufficient benefit.

### 6.6 Gate

If the next action crosses a defined consequential boundary, the agent stops with:

- the exact action;
- target system or audience;
- relevant diff or artifact;
- verification completed;
- known residual risk;
- the specific approval needed.

Approval applies to that action. It does not silently authorize later pushes,
publishes, messages, purchases, destructive operations, or provider access.

This interleaving of reasoning, environment interaction, and verification is related
to ReAct's reasoning/action pattern [6], but Vivary's protocol is a workspace
operating contract rather than a model prompting method. It adds canonical ownership,
learning lifecycle, and explicit human gates.

### 6.7 Failure behavior

The protocol should stop or degrade safely when:

- the workspace root cannot be resolved;
- privacy rules are invalid or ambiguous;
- graph truth is inconsistent;
- a provider index is stale;
- a linked path escapes the root;
- a dry run and actual target disagree;
- verification fails;
- the gate authority is unknown;
- external state cannot be confirmed.

The correct fallback is usually smaller deterministic behavior, not a silent attempt
to recover with broader authority.

## 7. Security, privacy, and human authority

### 7.1 Security posture

Vivary is not a sandbox and does not make an untrusted agent safe by itself. It is a
workspace structure and a set of deterministic controls intended to make authority,
data flow, and impact more visible.

The design follows four practical principles:

- **local and dependency-light defaults;**
- **least capability until enabled;**
- **explicit preview and approval before consequential changes;**
- **inspectable records without raw private transcripts.**

NIST's Generative AI Profile emphasizes lifecycle risk management, measurement,
documentation, and governance for trustworthy use [7]. Vivary is not a certification
against NIST AI 600-1. Its claim taxonomy, evaluation plan, and gate model are
compatible with the narrower idea that risks and controls should be documented and
tested rather than assumed.

### 7.2 Assets

Assets that may require protection include:

- private notes and user memory;
- source code and configuration;
- credentials and environment variables;
- unpublished research and business plans;
- provider indexes and caches;
- release authority and repository history;
- outbound messages and public statements;
- receipts that could reveal local paths or query content.

### 7.3 Trust boundaries

The main boundaries are:

1. workspace root versus the surrounding filesystem;
2. public/canonical files versus ignored or private files;
3. deterministic local core versus optional provider runtime;
4. retrieval candidates versus canonical truth;
5. local work versus network or public action;
6. one agent's claim versus another agent's active work;
7. generated artifacts versus their canonical source.

### 7.4 Threats and controls

| Threat or failure | Current or required control | Residual risk |
|---|---|---|
| Out-of-root or linked file enters graph/provider | resolved-root checks; symlink, junction, and hard-link defenses; fail-closed provider packet construction | platform-specific filesystem behavior requires continuing tests |
| Private content is indexed or exposed | `.gitignore`, Vivary private rules, explicit provider privacy policy, network disabled by default | incorrect user rules or unknown external-provider retention |
| Semantic hit is stale or fabricated | node-id resolution, graph fingerprint checks, typed result contract, graph/file authority | a current node may still contain semantically wrong content |
| Agent mutates an existing project unexpectedly | read-only map, dry-run adoption, additive first slice, exact proposed files | a user can still approve a poor proposal |
| Provider performs hidden network work | explicit provider install/config, `allow_network = false` default, approval flags | third-party dependency behavior must be independently reviewed |
| Receipt leaks private task content | command-class and count recording, query/path redaction, root-relative surfaces | novel error messages may require new sanitization |
| Generated docs drift from source | source-owned sync, build-time regeneration, local link/anchor gate | a manually summarized marketing page can still become stale |
| Multiple agents overwrite shared work | explicit claims and conflict detection over active graph nodes | conflicts outside declared graph relationships may be missed |
| Human approval becomes blanket authority | per-action gate language and separate delivery gates | ambiguous instructions remain a social and interface risk |
| Deterministic checks create false confidence | narrow claim language and task-specific verification | users may still overinterpret green checks |

### 7.5 Provider policy

The optional Cognee adapter illustrates the intended contract:

- provider state lives under a workspace cache and is rebuildable;
- packet construction filters privacy rules before provider calls;
- linked, out-of-root, and hard-linked files are refused;
- network-capable runtime requires explicit configuration;
- provider writes and deletion require approval;
- recall returns typed candidates mapped to known nodes;
- stale graph fingerprints block normal recall;
- provider errors are sanitized before display.

This is an implementation boundary, not a guarantee about every future provider.
Each new provider requires its own install, data-flow, failure, and uninstall proof.

### 7.6 Human gates and least privilege

Saltzer and Schroeder's least-privilege principle says that programs and users should
operate with only the privileges required for the job [4]. Vivary translates that
principle into task authority:

- reading public project files does not imply permission to read private user memory;
- editing local files does not imply permission to push;
- pushing does not imply permission to merge;
- merging does not imply permission to publish a package or announcement;
- selecting a provider does not imply permission to install, index, transmit, or
  retain data.

The gate is therefore part of the operating protocol, not a decorative confirmation.

## 8. Adoption model

### 8.1 Greenfield scaffold

A new workspace can be created with:

```bash
npm create @vivary@latest my-workspace
```

Presets currently cover coding, second-brain, knowledge-work, and writing shapes.
The scaffolder writes a small routing and graph contract, and `doctor` plus
`tropo check` verify the result.

The scaffold is successful when:

- required routing and state surfaces exist;
- the graph validates;
- agent-runtime instructions are in parity where promised;
- private boundaries are present;
- optional providers are disabled unless deliberately configured;
- generated links are intact.

### 8.2 Brownfield adoption

The intended existing-project sequence is:

```bash
tropo map --root .
create-vivary adopt .
create-vivary doctor . --trend
```

The stages are:

1. **Map:** inventory the current tree read-only and identify likely routing,
   privacy, size, and module issues.
2. **Preview:** show the additive workspace shell and exact files before writing.
3. **Adopt:** add approved routing and graph surfaces without moving or rewriting
   existing files.
4. **Verify:** run doctor, graph validation, and relevant project tests.
5. **Return:** rerun doctor over time to observe drift and proposed repair.

Brownfield adoption is important because requiring a user to reorganize a project
before experiencing value creates both risk and selection bias. A tool should prove
that it can orient itself in the existing mess.

### 8.3 Reversibility

The baseline workspace is ordinary files. Removing Vivary tooling should not require
exporting canonical truth from a hosted service. Optional caches can be deleted and
rebuilt. Adoption's initial additive files can be reviewed and removed through
normal version control.

Reversibility does not mean every change is automatically harmless. If a user later
moves canonical truth into Vivary-specific schemas or enables external providers,
those choices have migration and data-retention consequences that must be documented.

### 8.4 Adoption success criteria

An adoption attempt should be considered successful only when the user can:

- explain where current truth lives;
- run one useful retrieval or map operation;
- inspect what adoption added;
- obtain a clean or actionable doctor result;
- identify private/excluded surfaces;
- remove or decline the proposed changes;
- complete a real project task with traceable evidence.

Install completion alone is not product success.

## 9. Claims and evidence status

### 9.1 Claim classes

| Claim | Status | Evidence boundary |
|---|---|---|
| Tropo builds and validates typed graphs over Markdown/configured schemas | **Implemented and verified** | public source, specification, and automated tests |
| `tropo find` returns bounded typed context packets | **Implemented and verified** | command implementation and tests |
| `tropo map` inventories a tree read-only without prior Vivary config | **Implemented and verified** | read-only implementation and filesystem safety tests |
| Brownfield adoption previews an additive workspace shell | **Implemented and verified** | scaffolder implementation and tests |
| Doctor reports health and trend state | **Implemented and verified** | implementation, scaffold tests, and CI smoke |
| Ozone performs deterministic structure, context-budget, editorial, and impact review | **Implemented and verified** | public rule packs and tests |
| Exo provides graph-native claims and conflict detection | **Implemented and verified** | public implementation and tests |
| Optional Cognee memory is privacy-filtered and approval/network gated | **Implemented and verified within tested adapter boundaries** | adapter tests with fake provider; not a third-party service audit |
| Vivary works with every agent runtime and editor | **Proposed or not yet measured as a universal claim** | portability follows from plain files, but runtime-specific behavior requires testing |
| Vivary reduces token consumption | **Proposed or not yet measured** | benchmark pending |
| Vivary reduces wrong-file opens and unsupported answers | **Proposed or not yet measured** | benchmark pending |
| Vivary improves long-term project health or user retention | **Proposed or not yet measured** | longitudinal adoption evidence pending |
| A local read-only-by-default MCP adapter exposes bounded governed context without creating workspace files | **Implemented and verified within the pinned local SDK boundary** | adapter, privacy, stdio, official-SDK, and greenfield end-to-end tests; named host conformance and comparative outcomes remain unproven |
| Context-budget repair proposals save a predictable number of tokens | **Specified but incomplete** | reporting exists; calibrated outcome evidence pending |

### 9.2 What current tests establish

The repository's automated suites establish that defined command behaviors,
filesystem protections, configuration rules, provider gates, generated asset parity,
and scaffolding contracts work for the covered fixtures and platforms. CI also runs a
graph validation gate and production site build.

These tests do not establish:

- comparative agent performance;
- correctness of arbitrary project prose;
- absence of all filesystem or provider vulnerabilities;
- suitability for regulated or safety-critical work;
- third-party provider privacy practices;
- adoption, retention, or economic value.

### 9.3 Claim publication rule

Public claims should use one of three forms:

- **Current behavior:** “Vivary does X,” backed by a command, test, or inspected
  implementation.
- **Design intent:** “Vivary is designed to X,” backed by a requirement and boundary.
- **Hypothesis:** “We expect X; here is how it will be measured.”

Unpublished benchmark numbers, synthetic testimonials, and universal compatibility
claims are not acceptable substitutes for evidence.

## 10. Evaluation protocol

### 10.1 Research question

For fixed project-understanding and impact-analysis tasks, does Vivary's deterministic
map, typed retrieval, and routing contract improve the efficiency and support of an
agent's answer relative to a minimally structured project baseline?

### 10.2 Primary hypotheses

- **H1 — context efficiency:** Vivary reduces total input tokens used before a
  supported answer.
- **H2 — retrieval precision:** Vivary reduces irrelevant or wrong-file opens.
- **H3 — task efficiency:** Vivary reduces turns and elapsed time to a supported
  answer.
- **H4 — support quality:** Vivary reduces unsupported, stale, or misowned factual
  claims.
- **H5 — safety:** Vivary does not increase private-path exposure or unauthorized
  writes under the evaluated tasks.

All five are **Proposed or not yet measured**.

### 10.3 Baselines

At minimum, compare:

1. **Unstructured baseline:** repository or document tree plus ordinary file search,
   with no Vivary routing or graph commands.
2. **Routing-only baseline:** small project instructions and module indexes without
   typed graph retrieval.
3. **Vivary deterministic:** map, find, query, graph, and routing surfaces; optional
   semantic providers disabled.

Optional provider conditions should be later experiments, not mixed into the first
headline result. Otherwise a retrieval-provider change could obscure whether the
workspace standard itself helps.

### 10.4 Task set

Use a frozen public repository revision and pre-register questions such as:

- Where is release truth owned?
- Which module owns a named behavior?
- What depends on a proposed schema or policy change?
- Which files should be read first for a specific issue?
- Which documentation surfaces must change with a command?
- What private or ignored material must be excluded?
- What verification commands and human gates apply?

Tasks should include direct lookup, multi-hop relationship, change impact, and
insufficient-evidence cases. The benchmark must contain questions whose correct
answer is “unknown” or “not supported.”

### 10.5 Experimental controls

For each condition:

- use the same model and version;
- use the same agent-runtime version and tool permissions;
- use a fresh session;
- pin the repository revision;
- hold task wording constant;
- randomize or counterbalance task and condition order;
- record system prompts and allowed tools, subject to provider terms;
- disable unrelated caches or document them;
- repeat enough runs to expose variance.

Because hosted models and agent runtimes change, the date and exact version are part
of the result, not incidental metadata.

### 10.6 Measures

Record:

- input and output tokens;
- number of turns;
- files opened;
- unique files opened;
- irrelevant files opened;
- commands executed;
- elapsed time;
- final answer support score;
- number of stale or unsupported claims;
- private-path or gate violations;
- failure and refusal rate.

Token count must come from the runtime or provider when available. Approximation
should be labeled and should not be mixed with exact counts in one aggregate.

### 10.7 Answer scoring

Create a blinded answer key before running the benchmark. Each factual claim should
be scored as:

- supported by canonical evidence;
- supported but stale or superseded;
- plausible but unsupported;
- contradicted;
- correctly identified as unknown.

At least two reviewers should score a subset independently. Disagreement and the
resolution procedure should be reported. A polished answer is not equivalent to a
supported answer.

### 10.8 Analysis and reporting

Publish:

- benchmark harness and task definitions;
- frozen repository revision;
- raw run records with secrets/private paths removed;
- per-task results, not only aggregate means;
- median and distribution where repeated runs exist;
- failures and regressions;
- known limitations;
- changes made after observing results.

Do not silently drop timeouts, refusals, or bad runs. If an implementation bug is
fixed during evaluation, rerun all affected conditions and publish both the reason
and revised result.

### 10.9 Threats to validity

**Model dependence:** one model/runtime may benefit more from explicit routing than
another.

**Repository selection:** a repository already organized like Vivary can overstate
benefit; a deliberately chaotic fixture can also bias the result.

**Task author bias:** maintainers may write questions that match the graph schema.

**Learning and contamination:** public repositories or tasks may appear in model
training data.

**Instrumentation effects:** token counters, tracing, or caches can alter runtime
behavior.

**Scoring subjectivity:** support and relevance judgments require a published rubric
and reviewer agreement.

**Version drift:** model, runtime, provider, and Vivary changes can make old results
non-comparable.

**Ecological validity:** benchmark tasks may not predict long-running project health,
team adoption, or economic value.

The benchmark should be described as evidence for a bounded condition, never proof
that Vivary universally improves agents.

### 10.10 Longitudinal evaluation

The retention hypothesis requires a separate study. For consenting external
adopters, record only privacy-safe aggregate events or user-provided receipts:

- first successful map/adopt/doctor sequence;
- repeat doctor use after one and four weeks;
- detected and repaired drift;
- abandoned adoption and reason;
- manual removal or migration;
- reported incidents or privacy failures.

Telemetry should not be introduced merely to make measurement convenient. Manual,
opt-in proof packets are acceptable for the first study.

## 11. Related work

### 11.1 Long-context language models

Longer context windows expand what can be supplied to a model, but evidence
utilization can remain sensitive to position and task [1]. Vivary is complementary:
it attempts to improve selection, ordering, ownership, and expansion before or during
context assembly. It does not modify model attention or claim to solve long-context
reasoning.

### 11.2 Retrieval-augmented generation and semantic memory

RAG combines parametric generation with non-parametric retrieval and motivated a
large family of semantic-memory systems [3]. Vivary differs at the authority layer.
Its primary object is not an untyped chunk but a current typed project node with a
canonical path and graph relationships. Semantic retrieval remains optional and is
filtered through identity, privacy, and freshness checks.

This choice trades some recall flexibility for clearer ownership and degradation.
The tradeoff must be evaluated rather than assumed superior.

### 11.3 Reasoning-and-acting agents

ReAct interleaves reasoning traces and environment actions [6]. Many contemporary
agents similarly alternate planning, tool use, and observation. Vivary's inner loop
belongs to this broad family but adds workspace-specific stages: bounded retrieval,
verification, durable learning decisions, and explicit human gates.

The workspace standard is intended to be runtime-agnostic; it is not a new inference
algorithm.

### 11.4 Agent-computer interfaces

SWE-agent treats the interface presented to an agent as a meaningful design object
and reports substantial performance differences in its evaluated software tasks
[2]. Vivary applies the same systems intuition to project information architecture:
the agent should receive commands and files shaped around its operational needs
without making the project unreadable to humans.

### 11.5 Instruction files and agent harnesses

Repository instruction files, saved prompts, IDE rules, agent skills, and task
harnesses are useful local mechanisms. Vivary does not replace them. It defines where
they sit in a broader contract:

- root instructions route;
- module instructions narrow scope;
- skills contain reusable procedure;
- state reports the present;
- typed files own durable truth;
- gates own consequential authority.

The differentiator is the relationship among surfaces, not the invention of each
surface.

### 11.6 Interoperability protocols

MCP standardizes context and tool exchange between hosts, clients, and servers and
includes explicit architectural and authorization responsibilities [5]. Vivary could
expose its read-only graph through MCP, but MCP does not by itself decide which
project file owns a fact, how a workspace routes context, or when a project-specific
human gate applies. The layers are complementary.

### 11.7 Security and AI risk frameworks

Classic protection principles such as least privilege and fail-safe defaults inform
the capability and gate model [4]. NIST AI 600-1 provides a broader voluntary risk
management profile for generative AI [7]. Vivary is narrower than both: it is not a
general access-control system or organizational risk framework. It supplies local
workspace controls that can participate in a larger governance program.

## 12. Limitations and failure modes

### 12.1 Structure cannot guarantee truth

A typed, valid graph can contain incorrect prose, bad decisions, insecure code, or
outdated claims. Types and relationships improve legibility and checking; they do not
establish semantic correctness.

### 12.2 Manual ownership creates maintenance work

Canonical ownership and explicit relationships require curation. If maintainers do
not update nodes, routes, and state, the graph can become a well-structured map of
stale information. Generated checks reduce but do not remove this burden.

### 12.3 Schema can become bureaucracy

Types and required fields can expand until simple work requires excessive metadata.
Vivary's tighten-only rules protect consistency, not usefulness. Schemas must remain
small, task-driven, and reviewable.

### 12.4 Routing can become another layer of indirection

Progressive disclosure helps only if routers are short and accurate. Too many indexes
can increase navigation cost. The context-budget pack detects some symptoms but
cannot determine the ideal architecture for every project.

### 12.5 Blast radius is limited by declared relationships

Graph impact finds declared dependents. It can miss dynamic code behavior, external
systems, undocumented social dependencies, or relationships absent from the graph.
It complements—not replaces—tests, static analysis, operational telemetry, and human
review.

### 12.6 Gates can be ignored or become ceremonial

A workspace contract cannot force every runtime or operator to respect a gate. Too
many prompts can also produce approval fatigue. Gates should be reserved for real
consequence, and runtimes should make bypass visible.

### 12.7 Optional providers enlarge the attack and privacy surface

Even with local configuration and filtering, a provider may introduce dependency,
network, retention, credential, or model-supply-chain risk. Fake-provider tests do not
audit the real provider. Each integration requires separate review.

### 12.8 Filesystem portability has edge cases

Windows paths, junctions, symlinks, hard links, case behavior, encodings, reserved
names, and permission models differ. The implementation includes targeted tests, but
novel filesystem behavior can create correctness or security bugs.

### 12.9 Multi-agent coordination is incomplete

Explicit claims and graph conflicts catch declared overlap. They do not provide
distributed transactions, semantic merge resolution, or reliable coordination across
unconnected repositories and external systems.

### 12.10 No published comparative benchmark yet

The largest limitation is empirical. The repository demonstrates command behavior
and safety properties for fixtures; it does not yet show that real users or agents
consume fewer tokens, open fewer wrong files, produce more supported answers, or
retain the workflow. Those remain hypotheses until the evaluation in Section 10 is
executed and published.

### 12.11 Not designed for every environment

Vivary may be a poor fit when:

- the authoritative system cannot be represented or referenced from files;
- the work is ephemeral and has no durable project context;
- an organization already has a mature, machine-readable knowledge and authorization
  architecture;
- the regulatory environment requires certified controls Vivary does not provide;
- the overhead of maintaining graph truth exceeds the retrieval benefit;
- the task is better solved by one short prompt and no persistent workspace.

## 13. Governance and evolution

### 13.1 Change criteria

A core change should answer:

- Which observed failure does it address?
- Which requirement or invariant does it strengthen?
- What always-on context, dependency, or authority does it add?
- How does it degrade when unavailable?
- What proof demonstrates the improvement?
- Can the same result be achieved with a smaller surface?

Features without a clear answer should remain optional, experimental, or deferred.

### 13.2 Compatibility

The project should version:

- package APIs and CLI behavior;
- graph schemas and receipt formats;
- generated workspace contracts;
- provider interfaces;
- machine-readable output.

Plain files reduce lock-in but do not eliminate migration responsibility. Breaking
schema or command changes require an explicit plan, migration path, and synchronized
documentation.

### 13.3 Provider admission

A provider should not be presented as supported until the repository documents and
tests:

- install and uninstall path;
- local and network behavior;
- credentials;
- content sent or stored;
- privacy filters;
- approval gates;
- cache/state location;
- freshness and rebuild behavior;
- failure degradation;
- known provider-specific limitations.

### 13.4 Evidence governance

Benchmark methods, raw results, and negative findings should be versioned with the
code. A changed harness or task set creates a new result series. Marketing summaries
must link to the method and must not combine incomparable runs.

Public signals such as package downloads or repository stars should be labeled as
distribution signals, not proof of user outcomes.

### 13.5 Security reporting

Filesystem escape, privacy leakage, provider bypass, receipt disclosure, gate
confusion, and supply-chain issues should be treated as security-relevant even when
they do not fit a conventional remote-code-execution category. Supported package
lines and disclosure channels live in the repository security policy.

### 13.6 Decision authority

The public repository can propose implementation changes. Product direction,
provider admission, breaking changes, and release/merge gates remain accountable
human decisions. Automation may prepare evidence and carry out an approved action,
but it should not erase the decision boundary.

## Conclusion

Agents need more than memory and more than a larger context window. They need a
project environment that distinguishes current truth from history, ownership from
mention, routes from detail, retrieval candidates from canonical evidence, local
work from external consequence, and implementation from unmeasured promise.

Vivary's proposal is intentionally small:

- keep durable truth in inspectable files;
- derive a typed and validated relationship graph;
- expose one visible state surface;
- route through progressive disclosure;
- retrieve bounded context with provenance;
- verify changes deterministically where possible;
- treat optional intelligence as an explicit capability;
- return authority to a human at consequential edges.

The implementation demonstrates that these boundaries can exist in a dependency-light
toolchain and can be adopted additively. It does not yet demonstrate the central
comparative outcome. The next obligation is therefore evidence: a public,
reproducible benchmark and honest brownfield case studies that report failures as
clearly as successes.

If the hypothesis survives that evaluation, the result will not be an agent that
remembers everything or acts without interruption. It will be an agent that finds
the right project truth with less waste, understands more of what a change touches,
and stops at the point where human responsibility begins.

## Appendix A: minimal workspace contract

A new Core workspace uses this exact small operational seed:

```text
AGENTS.md                    small startup routing and operating contract
STATE.md                     one visible current-state surface
.gitignore                   bounded private/runtime integration
.vivary/context.md           first typed project-context capsule
.vivary/workspace.toml       thin-v0.3 policy and type owner
```

No record directory, starter graph, templates, skills, or pre-populated second brain
is created. Typed modules, changes, decisions, verification, and gate records appear
under `.vivary/records/` only when actual work earns them through a governed action.
Richer legacy or optional workspace modes remain explicit capabilities, never Core
startup output. Brownfield adoption is more conservative still: at most the three
Vivary payload files, with at most two bounded host integrations when needed.

## Appendix B: operational conformance checklist

A workspace substantially conforms to this paper when:

- [ ] root instructions route rather than contain the whole project;
- [ ] current state has one visible owner;
- [ ] durable project objects have stable identity and type;
- [ ] relationships and required fields validate deterministically;
- [ ] private/ignored material is excluded from public and provider surfaces;
- [ ] a useful read-only map or retrieval path exists;
- [ ] context packets are bounded and retain provenance;
- [ ] optional providers are explicit and disposable;
- [ ] mutations can be previewed when reasonably possible;
- [ ] consequential action classes have named human gates;
- [ ] verification commands are documented;
- [ ] receipts avoid raw private content and absolute local paths;
- [ ] generated surfaces identify or derive from canonical truth;
- [ ] claims distinguish implemented behavior from hypotheses;
- [ ] removal or migration does not require a proprietary export.

This checklist is a design aid, not a certification.

## References

1. Nelson F. Liu, Kevin Lin, John Hewitt, Ashwin Paranjape, Michele Bevilacqua,
   Fabio Petroni, and Percy Liang. “Lost in the Middle: How Language Models Use
   Long Contexts.” *Transactions of the Association for Computational Linguistics*,
   2024. [arXiv:2307.03172](https://arxiv.org/abs/2307.03172).

2. John Yang, Carlos E. Jimenez, Alexander Wettig, Kilian Lieret, Shunyu Yao,
   Karthik Narasimhan, and Ofir Press. “SWE-agent: Agent-Computer Interfaces Enable
   Automated Software Engineering.” 2024.
   [arXiv:2405.15793](https://arxiv.org/abs/2405.15793).

3. Patrick Lewis, Ethan Perez, Aleksandra Piktus, Fabio Petroni, Vladimir Karpukhin,
   Naman Goyal, Heinrich Küttler, Mike Lewis, Wen-tau Yih, Tim Rocktäschel,
   Sebastian Riedel, and Douwe Kiela. “Retrieval-Augmented Generation for
   Knowledge-Intensive NLP Tasks.” *Advances in Neural Information Processing
   Systems 33*, 2020. [arXiv:2005.11401](https://arxiv.org/abs/2005.11401).

4. Jerome H. Saltzer and Michael D. Schroeder. “The Protection of Information in
   Computer Systems.” *Proceedings of the IEEE* 63, no. 9 (1975): 1278–1308.
   [doi:10.1109/PROC.1975.9939](https://doi.org/10.1109/PROC.1975.9939).

5. Model Context Protocol. “Architecture” and “Authorization.” Specification
   revision 2025-06-18.
   [Architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture/index);
   [Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization).

6. Shunyu Yao, Jeffrey Zhao, Dian Yu, Nan Du, Izhak Shafran, Karthik Narasimhan,
   and Yuan Cao. “ReAct: Synergizing Reasoning and Acting in Language Models.”
   *International Conference on Learning Representations*, 2023.
   [arXiv:2210.03629](https://arxiv.org/abs/2210.03629).

7. Chloe Autio, Reva Schwartz, Jesse Dunietz, Shomik Jain, Martin Stanley, Elham
   Tabassi, Patrick Hall, and Kamie Roberts. *Artificial Intelligence Risk
   Management Framework: Generative Artificial Intelligence Profile*. NIST AI
   600-1, July 2024.
   [doi:10.6028/NIST.AI.600-1](https://doi.org/10.6028/NIST.AI.600-1).
