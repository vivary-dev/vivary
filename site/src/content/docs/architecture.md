---
title: "Architecture"
description: "The four-layer model and the principles behind Vivary."
editUrl: "https://github.com/vivary-dev/vivary/edit/dev/docs/ARCHITECTURE.md"
---

This page explains how Vivary is put together and why. It's the deep version; for the
plain-language overview, read [Concepts](/concepts/) first.

## 1. What Vivary is

Vivary gives agents the right bounded project context, preserves conflicting truth
instead of guessing, makes authority and gates explicit, and produces evidence a human
can inspect. It is a standard for agent-native workspaces and a scaffolder that composes
standalone modules into a normalized workspace — for a second brain, a coding project,
or a writing project, on any agent runtime (Claude Code, Codex CLI, …) and any stack.

The goal is **normalization**: today everyone hand-rolls their agent setup.
Vivary makes the workspace a known, structured, portable thing.

## 2. The first-principles baseline

Four of Jeff's repos turned out to be **two ideas**, one of them a single loop
seen at two speeds:

- **braincheck → loam** — one knowledge-layer lineage (loam supersedes braincheck).
- **throughline + flywheel** — the *same self-improving loop*. throughline runs
  `Ask→retrieve→act→verify→learn→gate` every turn; flywheel distills what the
  loop `learn`ed into durable memory, playbooks, and skills on a heartbeat. Inner
  turn and outer turn of one mechanism.

The irreducible core, true of any agent workspace regardless of stack or task:

> **A self-improving loop running over a typed, navigable knowledge graph, with
> one visible state surface and human gates.**

**Design law (from throughline's minimalism hypothesis):** every always-on file
competes with the user's task for context. The framework must cost almost nothing
to load. Fewer files, fewer words, more room for the work. This is the constraint
that keeps Vivary from bloating into a heavy harness.

**DRY and progressive disclosure:** context management only works if it lowers the
active load. `AGENTS.md`, `STATE.md`, and `modules/**/index.md` are routing surfaces;
canonical detail lives once in the owning typed file or skill. Agents choose a module
through `modules/index.md`, open that module's `index.md`, and follow deeper links only
when the task proves they are relevant.

**No lock-in (corollary):** a workspace is plain Markdown + YAML plus a few
lightweight Python CLIs. Governed Tropo composes the first-party `vivary-core` seam,
but no CLI requires an editor, plugin, provider, network service, or single-vendor
agent runtime. Workspaces operate in any editor or none, with Claude Code via
`.claude/` or Codex via `AGENTS.md` + `.agents/`; tropo ignores `.obsidian/`,
`.vscode/`, and similar tool state.

**Active context is a sidecar.** For codebases, a workspace may opt into
CocoIndex-code guidance (`--active-context cocoindex-code`) so agents can ask before
using semantic code search. This does not move embeddings or indexing into the tropo
core; it keeps the deterministic graph as truth and treats semantic search as
candidate retrieval.

**Semantic memory is also optional.** For second-brain, knowledge-work, and writing
workspaces, semantic recall should use provider adapters over typed `tropo`
nodes, not naive chunked RAG and not a second source of truth. Database/search and
memory providers are optional capabilities presented in the install flow; Cognee may
be one provider behind that adapter, but it must stay out of the default install and
default preset path. See [Optional semantic memory](/semantic-memory/).

## 3. The layer model

A vertical column. Each layer is a standalone module that reads/writes the same graph
and obeys the same convention. Published CLIs are thin. Strato's agent-OS templates
remain bundled in generated workspaces, while its new Python facade is declared as the
unpublished `vivary-strato` source package during development.

```
        exo      ── multi-agent orchestration            (outermost, optional)
       ozone     ── review: code + editorial / gates     (protective filter, optional)
       strato    ── agent OS: state · memory · loop · gates · self-improvement   (BASELINE)
       tropo     ── typed knowledge graph: what's true   (dense foundation, BASELINE)
```

- **tropo** (troposphere) — the dense, living foundation. Typed frontmatter →
  typed graph → search/navigation. Ground truth. *(ported from loam)*
- **strato** (stratosphere) — the stable layer above the churn. The visible state
  surface, compounding memory, the operating loop, human gates, and the
  self-improvement that falls out of `learn` over time. *(throughline + flywheel,
  fused)*
- **ozone** — the protective filter. Review for code *and* prose; a specialized
  verify/gate step. *(optional)*
- **exo** — the outermost layer. Coordination and a bounded governed-control adapter
  when one agent becomes many. *(optional)*

Baseline = **tropo + strato** (knowledge + the self-improving loop over it).
`ozone` and `exo` snap on as needed.

### The shared seam: `vivary-core`

The four layers above are the *vertical* column. `vivary-core` forms the horizontal
seam beneath them. Each role package speaks through these governed-context primitives,
so "what is true, and how do we know" has exactly one implementation rather than four
that drift. Tropo, Strato, Ozone, and Exo use this seam in the development source.

It is a library, not a layer and not a CLI. Nothing about the baseline changes
because it exists: you still install and run `tropo`, `strato`, `ozone`, `exo`.

```
   exo · ozone · strato · tropo      ── the layers, each with its own CLI
   ─────────────────────────────
          vivary-core               ── the seam they share (library, no CLI)
```

What it owns:

- **Determinism** — canonical JSON, sha256 fingerprints, deterministic IDs. Same
  input, same bytes, on every machine.
- **Observation** — read-only checkout observation over explicit allowlisted roots.
  Never fetches, never writes, never crawls.
- **Projection** — observations into a typed evidence graph, where divergent
  checkouts become explicit unresolved conflicts with both sides preserved, never
  auto-resolved.
- **Capsules** — bounded task context with traversal-free absolute declared scope roots,
  every claim carrying its evidence and selection reason, and every compiler-owned
  omission reconstructed. Candidate-by-question-term-and-filter ranking and content
  containment have Core-owned work ceilings. Capsules compiled from complete content
  observations fingerprint that exact source. Content searches resolve and search a
  named HEAD commit tree; duplicate checkout or match identities fail closed.
  Graph-context verification requires the fingerprinted source, rejects stripped
  bindings, and recompiles the complete capsule. Core owns the exact top-level capsule
  and receipt field sets.
- **Receipts and evidence** — what actually ran, bound to the exact capsule and
  workspace fingerprint it ran against, in an append-only store. Core rejects receipt
  checks that have no exact name-and-command authority in the capsule, including for
  direct Core and Strato callers.
- **Control lifecycle** — Core owns exact actor and authority validation, claim and
  lease decisions, dependency-cycle decisions, record-only handoffs, exact execution
  evidence derivation, replay-safe append projections, and task-integrity views. The
  [Core control contract](https://github.com/vivary-dev/vivary/blob/dev/packages/core/README.md#governed-exo-control) owns the
  lifecycle details.
- **Role-policy surfaces** — reference implementations of the governed loop inside
  `vivary-core`, exposed incrementally through explicit experimental role adapters:
  - **Strato (`policy_*`)** evaluates budgets, capsule and receipt gates, and the
    next loop step with fail-closed, pinned reason codes. The `vivary-strato`
    `decide --governed` facade adds the actor/authority, workspace/scope,
    caller-supplied clock, freshness, and policy-version envelope without duplicating
    those decisions or persisting loop state.
    Core's primitive accepts finite numeric limits/counters and treats an omitted limit
    as unbounded; the role envelope narrows any supplied counter or limit to a
    non-negative integer before delegation.
  - **Ozone (`verify_*`)** recomputes receipt fingerprints for tamper detection,
    evaluates gate sufficiency without allowing duplicate check names to erase
    worse evidence, and emits bounded repair proposals as gated dry-run data. The
    `vivary-ozone` `verify --governed` facade applies iterative whole-request and
    multiplicative scalar-work ceilings before recursive validation, preserves Core's
    exact artifact-field ownership and typed unknown-field refusals, binds graphless
    check working directories to task scope, rejects receipt-only check authority,
    requires canonical repair-graph allowlists, and transports content observations
    bound to both the named commit tree and the graph's effective ignore-policy
    fingerprint for Core reconstruction. Its raw fingerprinted gate verdict passes to
    Strato unchanged.
  - **Exo (`control_*`)** exposes Core's
    [control lifecycle](https://github.com/vivary-dev/vivary/blob/dev/packages/core/README.md#governed-exo-control) through one
    bounded request/response adapter. The caller owns and persists every state value.
    [The command reference](https://github.com/vivary-dev/vivary/blob/dev/docs/COMMANDS.md#governed-control-development-source) owns the
    transport envelope.
  - **Bellamente (`recall_*`)** applies the
    [SPEC-owned candidate-recall firewall](https://github.com/vivary-dev/vivary/blob/dev/docs/bellamente-memory/SPEC-bellamente-memory.md#6-candidaterecallprovider-contract).
    The public Core seam classifies bounded normalized candidates and projects
    caller-owned `preserve`, `create`, or `supersede` transitions. Create and
    supersede require an exact proposal-bound human approval. Applied records append
    learned assertions and never rewrite authored truth.

The governed Exo adapter adds no scheduler, state store, agent runner, network or
provider call, MCP server, repair write, or publishing path. It makes no Agent Relay
compatibility or byte-parity claim.
The governing rule is the same one the rest of Vivary follows: it never resolves an
ambiguity it merely observed. Conflicts are handed to review, not to confidence, and
anything unproven is reported `unknown` rather than guessed.

**Selected dependency direction:** a shipping package that imports `vivary-core`
declares its own floor in the same commit. The `vivary` meta-package receives Core
transitively through the role packages instead of declaring a duplicate Core edge.
Tropo, Strato, Ozone, and Exo own their Core floors. The meta-package owns its five
component floors, including `create-vivary>=0.3.3`, `vivary-tropo>=0.5.1`, and
`vivary-strato>=0.1.2`. One owner per edge avoids version-pinning fights.

**Optional MCP boundary:** `vivary-mcp` is an interoperability adapter, not a layer
or part of Core. Its dependency direction is `vivary-mcp → vivary-tropo →
vivary-core`; it separately pins the official MCP SDK. The adapter exposes only
bounded public Tropo/Core projections over operator-bound local roots. The baseline
and `vivary` meta-package do not install or start it.

**Installed-capability truth:** development-source `create-vivary capabilities`
projects a fixed public inventory for Core and the four governed roles. A bounded
passive reader binds each credited module or console script to the exact distribution
record under the active interpreter's canonical package roots. It neither imports
optional packages nor dispatches ambient import or distribution hooks. Each row reports
`installed`, `not-installed`, `incompatible`, or `probe-failed`. Optional absence and
probe failure do not make the workspace unhealthy. Doctor embeds the same envelope
and a separate passive `interop:mcp` row; neither probe imports or starts the adapter.

**Status:** Tropo, Strato, Ozone, and Exo Core adapters are present in the development
source and remain unpublished behind explicit `--governed` flags. The optional
read-only MCP adapter is also present only in development source and disabled by
default. Plain Tropo retrieval, Ozone review and impact, and legacy Exo graph
coordination remain unchanged. Current versions and publication status live in
[the root release status](https://github.com/vivary-dev/vivary/blob/dev/README.md#release-status).

## 4. The moat

Existing harnesses persist *flat context* — specs and memory dumped into Markdown.
Vivary's differentiators:

1. **Typed knowledge graph substrate**, not flat memory (tropo).
2. **Blast-radius / impact reasoning** — show what a change touches, before and
   after, visually, in a way a text diff cannot. (tropo's graph roadmap.)
3. **Medium-agnostic** — code review and editorial review are the same layer
   (ozone) with different rule packs.
4. **A standardized agent workspace** — uncovered ground.

## 5. Naming & namespace

The brand owns the namespace; current package truth is:

<!-- The PyPI bullet below is parsed by scripts/check_package_docs_parity.py; keep only distribution names backticked. -->
- npm: `@vivary/create` — the launcher for the scaffolder.
- PyPI: `vivary` (the meta package that installs the suite), `vivary-tropo`,
  `vivary-ozone`, `vivary-exo`, `create-vivary`, and the optional
  `vivary-memory-cognee`.
- `vivary-core` is declared in-repo and remains unpublished during development. It
  ships only as part of the final comprehensive coordinated release train, never in an
  earlier release line than its dependent roles; within that train, dependencies upload
  before dependents, so core uploads first.
- `vivary-strato` is declared in-repo and remains unpublished during development.
  Strato's templates and skills also remain bundled by `create-vivary`; the runtime
  package adds the policy facade rather than replacing those workspace assets.
- `vivary-mcp` is declared in-repo and remains unpublished during development. It is
  an optional local standard-input/output adapter, not a `vivary` meta-package
  dependency. [MCP.md](/mcp/) owns its contract.
- GitHub: `vivary-dev/vivary` holds the public repo.

Future packages can still use the Vivary namespace. Release surfaces must distinguish
published packages from declared, unpublished development source.

## 6. Module naming = atmosphere strata

The vertical column is named by altitude: `tropo` (troposphere, ground-hugging
and dense) → `strato` (stratosphere, stable) → `ozone` (the protective layer) →
`exo` (exosphere, the boundary to space). A *vivary* contains its own atmosphere,
so the metaphor nests cleanly: the world (Vivary) and its layers (the strata).
