# Spec: Vivary Data Layer + Setup Wizard

_Status: shipped in 0.2.0; retained as the implementation record plus future notes._

---

## Problem

Vivary's file-system knowledge graph (`tropo`) worked well for small workspaces but
hit a ceiling for:

- Large codebases (tens of thousands of nodes)
- Long-running projects (graph grows indefinitely)
- Huge second brains (millions of notes, cross-linked)

Before 0.2.0 there was no storage configuration, migration command, guided onboarding
for users who do not know the primitives, or machine-readable init path for agents.
0.2.0 shipped the storage layer, backend migration, setup wizard, and agent-mode flags.
The current public retrieval commands (`tropo find` / `query`) are graph-first and
zero-dependency; cloud adapters and provider-backed embedding services remain future
work.

---

## Design constraints (non-negotiable)

1. **Minimalism law holds.** The baseline must stay zero-dependency. Storage is opt-in — the default path installs nothing new.
2. **Windows-first.** Any embedded option must run on Windows without Docker or a server process.
3. **The CLI is the baseline agent API.** No MCP server or special protocol is
   required or enabled by default. Every command a human can run must remain available
   non-interactively with structured output. Optional adapters cannot replace or widen
   this core agent-native contract.
4. **Non-technical users are first-class.** Wizard language is plain English; no database jargon in the primary flow.
5. **Config lives in `.vivary/`.** Workspace-level storage config is `.vivary/storage.toml`. This keeps generated/runtime infra out of the workspace root and gitignore-able as a directory.

---

## Public governed-context vocabulary

These terms name the governed-context contract. They do not imply that a surface has
graduated. Current maturity lives in [MIGRATION-STATUS.md](MIGRATION-STATUS.md), and
exact command schemas live in [COMMANDS.md](COMMANDS.md#governed-machine-readable-envelopes).

- **Governed context** — bounded context whose claims retain typed evidence, selection
  reasons, conflicts, unknowns, omissions, workspace identity, and required checks.
  Core fails closed when those bindings cannot be reconstructed. [Capsule contract and
  tests](https://github.com/vivary-dev/vivary/blob/dev/packages/core/vivary_core/capsule_compile.py)
  are the behavior evidence.
- **Task Capsule** — the fingerprinted `vivary.task-capsule/v0` artifact compiled for
  one question and declared scope. It carries the context and effective checks that
  downstream policy and verification evaluate; it does not execute those checks.
  [Frozen fixtures](https://github.com/vivary-dev/vivary/tree/dev/packages/core/tests/fixtures/parity)
  cover its identity and omissions.
- **Execution Receipt** — the `vivary.execution-receipt/v0` record of what actually ran,
  bound to one capsule and workspace fingerprint. It reports passed, failed, or skipped
  checks and never treats provenance as proof of correctness. [Receipt implementation](https://github.com/vivary-dev/vivary/blob/dev/packages/core/vivary_core/receipt.py)
  and [verification tests](https://github.com/vivary-dev/vivary/blob/dev/packages/core/tests/test_verify.py)
  own that behavior.
- **Learning Proposal** — the public name for the deterministic `proposal` returned by
  a `vivary.recall-transition/v0` create or supersede projection. It names the proposed
  assertion transition, requires exact proposal-bound human approval, and performs no
  write by itself. [Recall transition implementation](https://github.com/vivary-dev/vivary/blob/dev/packages/core/vivary_core/recall_transition.py)
  and [recall tests](https://github.com/vivary-dev/vivary/blob/dev/packages/core/tests/test_recall.py)
  are the evidence. It is distinct from Ozone's context-repair proposal.
- **Integrity View** — the read projection returned by Core's `task_integrity_view`.
  It joins caller-owned task status to append-only execution edges and continues to
  expose failed verification after a task is marked done. [Control implementation](https://github.com/vivary-dev/vivary/blob/dev/packages/core/vivary_core/control_tasks.py)
  and [control tests](https://github.com/vivary-dev/vivary/blob/dev/packages/core/tests/test_control.py)
  own its shape and behavior.
- **ContextIntegrityEvent** — the frozen `vivary.context-integrity-event/v0` envelope
  for project-scoped append-only integrity facts. Occurrence time and recording time
  remain distinct, validation uses pinned reason codes, and accepted events rebuild a
  fingerprinted projection. [Conformance and replay fixtures](https://github.com/vivary-dev/vivary/tree/dev/packages/core/tests/fixtures/context-integrity-event-v0)
  are the byte-level evidence.

---

## Agent CLI contract

**The CLI is the complete agent interface for the data-layer and setup behavior in
this spec.** The same commands humans type are what agents call. The separate optional
[`vivary-mcp`](MCP.md) package wraps four read-only context producers; it exposes none
of this spec's setup, storage, migration, or mutation operations.

### Universal flags (every command)

| Flag | Meaning |
|---|---|
| `--json` | Machine-readable output. Agents parse this; never parse prose. |
| `--quiet` | Suppress non-essential output. |
| `--dry-run` | Show what would happen, do nothing. Safe to call from any agent. |

Exit codes are already uniform: `0` success · `1` findings/errors · `2` usage/config error. Gate on exit code, not text.

### Flags for commands that interact or install

| Flag | Meaning |
|---|---|
| `--yes` | Confirm the install or write selected by another explicit flag. Combined with `--json`, fully non-interactive. |
| `--auto` | Skip all questions. Use explicit storage or cloud-locality choices. Otherwise, keep file storage. |
| `--size small\|medium\|large` | Classify the workspace. Size never selects or installs a provider. |
| `--privacy local\|cloud` | Local keeps file storage by default. Cloud can select cloud configuration. |

### Self-install

When the user selects embedded storage, `create-vivary init` installs
`vivary-tropo[embedded]` if required. It runs `pip install vivary-tropo[embedded]`
through a subprocess. The agent does not have to know the extra name. In JSON mode,
`"installed": ["lancedb"]` reports the added provider. `--dry-run` prevents all writes
and installations.

Without `--yes`, the command asks for confirmation before the first provider install.
`--yes` confirms an explicit embedded selection. It never selects embedded storage.

### Shipped command surface (0.2.0)

| Command | Has `--json` | Has `--yes` | Has `--auto` | Has `--dry-run` |
|---|---|---|---|---|
| `tropo check` | ✓ | n/a | n/a | n/a |
| `tropo fix` | ✓ | ✓ (implied by `--dry-run`) | n/a | ✓ |
| `tropo graph` | ✓ | n/a | n/a | n/a |
| `ozone review` | ✓ | n/a | n/a | n/a |
| `exo conflicts` | ✓ | n/a | n/a | n/a |
| `create-vivary doctor` | ✓ | n/a | n/a | n/a |
| `create-vivary init` | ✓ | ✓ | ✓ | ✓ |
| `tropo migrate` | ✓ | ✓ | n/a | ✓ |
| `create-vivary wizard` | ✓ | ✓ | ✓ | ✓ |

### Example: agent bootstrapping a workspace end-to-end

```bash
# Agent inspects the repo and explicitly selects embedded storage:
create-vivary init . --preset coding --auto --storage embedded --size large --privacy local --yes --json
# → { "ok": true, "preset": "coding", "storage": "embedded", "provider": "lancedb",
#     "installed": ["lancedb"], "config": ".vivary/storage.toml", "dry_run": false }

# Agent checks workspace health:
create-vivary doctor . --json
# → { "ok": true, "graph": { "nodes": 9, "edges": 28, "broken": 0 }, "backend": "embedded" }

# Agent validates the graph:
tropo check --root . --json
# → { "errors": 0, "warnings": 0, "files": 42 }

# Agent runs migration after adding embedded backend to existing workspace:
tropo migrate --from file --to embedded --yes --json
# → { "migrated": 312, "failed": 0, "duration_ms": 4200, "from": "file", "to": "embedded" }

# Agent queries the knowledge graph by text:
tropo query "what decisions affect the auth module" --json
# → { "results": [ { "id": "...", "type": "decision", "score": 2, ... } ] }

# Agent asks for a small read-this-first context packet:
tropo find "where is auth release truth owned" --budget 800 --json
# → { "results": [ { "id": "...", "type": "decision", "path": "...", "reason": "..." } ] }
```

---

## Architecture: why NOT naive RAG

The shipped 0.2.0 layer is storage/search infrastructure, not a chunked-RAG system.
The local vector retrieval slice preserves this boundary: it computes typed vectors
from bounded graph-node text at query time and keeps provider-backed embedding/index
mechanics outside tropo core.

**This is NOT chunked-text RAG.** Naive RAG = chunk arbitrary documents into ~500-token blobs, embed each chunk, retrieve top-k at query time. This throws away all the structure in a knowledge graph — relationships, types, hierarchy — and produces chunking artifacts that hurt retrieval quality.

**Vector retrieval should be graph-shaped.** Vivary already has a typed knowledge
graph (tropo: folder-as-type, each node is a typed entity). Vector layers operate on
graph nodes, preserve relationships and types, and return typed graph nodes for agents
to follow.

**For code specifically:** CocoIndex (already in Vivary as of PR #40) provides
structured active-context indexing — ASTs, call graphs, import graphs, hot context.
That's strictly better than RAG for code. The shipped `tropo query` command is
typed graph search over ids, titles, frontmatter, paths, body text, and edge context.
`tropo find` packages that same deterministic search into a small context packet.
Semantic code retrieval belongs to the active-context CocoIndex sidecar.

**For second brain / writing:** The tropo graph is the index. Semantic retrieval, when
enabled, should embed graph nodes rather than arbitrary chunks so the agent retrieves
structured entities and can traverse typed relationships. `tropo query --mode
semantic` is the minimal bridge into that optional provider layer; default query and
find remain deterministic graph/text search.

The provider boundary for that future work lives in
[SEMANTIC-MEMORY.md](SEMANTIC-MEMORY.md): semantic memory consumes privacy-filtered
typed nodes and edges, then returns typed node candidates for the agent to inspect.
Cognee is evaluated there as an optional provider, not a storage default.

**Retrieval notes by workspace type:**

| Workspace | Retrieval approach | Role of LanceDB |
|---|---|---|
| Coding | CocoIndex active context first; tropo graph search for docs/decisions | Future persistence target for structured code context |
| Second brain | Graph traversal (tropo edges), with optional local typed-node vectors | Local graph-node vector retrieval |
| Writing | Text graph search now; typed-node vectors if corpus scale needs it | Local graph-node vector retrieval |

**Critical nuance for coding:** For coding workspaces, avoid a separate
tropo-to-vector pipeline for source code. CocoIndex owns structured code indexing;
tropo owns the typed workspace graph.

**Historical hypothesis, not Vivary benchmark evidence:** the approved 0.2.0 plan
recorded an external comparison of roughly 2% task accuracy for naive chunked-text RAG
and 50–80% for AST-based structured indexing on SWE-bench-class work. No linked Vivary
fixture establishes those figures, so they must not be repeated as a product-performance
claim. The design implication retained here is structural: Tropo preserves node type as
a filter dimension, so a `decision` and a `reference` do not become indistinguishable
text chunks.

Full GraphRAG (Microsoft-style community summarization) is overkill for local workspaces. A future tropo graph + LanceDB node-embedding layer can provide the same structural benefit without the cost.

---

## Storage tier model

Three tiers use one interface. The wizard keeps file storage unless the user selects another tier.

```
file (default)  →  tropo's existing file-system graph. No new deps. Works for small workspaces.
embedded        →  LanceDB. In-process, disk-file, zero server. Unlocks persisted graph-node storage now and future local retrieval.
cloud           →  Qdrant Cloud (primary) or Astra DB (enterprise). Requires account + API key.
```

`auto` = file storage unless cloud locality is explicit. Embedded storage requires an exact choice.

### Why these choices

**LanceDB for embedded:** Closest thing the vector DB world has to SQLite. In-process, disk-file-native, zero server, zero config — `lancedb.connect("./.vivary/data")` is the entire setup. Runs on Windows. Apache 2.0. Direct upgrade path to LanceDB Cloud (same Python API). Handles millions of vectors on disk without RAM pressure. ~50MB wheel (Rust-compiled) — only installed when user chooses embedded.

**Qdrant Cloud for cloud (primary):** Fully open source (Apache 2.0), purpose-built for vectors, rich payload filtering for structured graph queries, free tier, excellent Python SDK, strong agent framework integrations (LangChain, LlamaIndex, CrewAI).

**Astra DB as secondary cloud:** Valid for enterprise/DataStax users. Higher setup friction. Supported as an adapter, not the default recommendation.

**sqlite-vec as bare-minimum:** Zero pip deps beyond stdlib — load one SQLite extension, get local vector search. No cloud upgrade path. Exposed as an explicit choice, not the auto default.

**Eliminated:**
- Weaviate: embedded mode is Linux/macOS only — fails on Windows.
- mem0 / Zep: memory-management layers *above* storage, not storage primitives. Document as optional integrations users can stack on top.
- ChromaDB: strong #2 embedded option, future adapter candidate; LanceDB wins on Windows footprint and cloud upgrade path.
- Pinecone: cloud-only, proprietary; adapter target only.

---

## Backend migration

"Migration" = when a user switches storage backends, their existing graph data needs
to move. Example: workspace starts on `file` backend, grows to 10k nodes, and switches
to `embedded` (LanceDB) for local persisted node storage and future retrieval work.
Without migration, the LanceDB table starts empty.

**Solution: `tropo migrate` command.**

```bash
tropo migrate --from file --to embedded
# Reads all nodes from the file-system graph
# Writes node content to the configured embedded backend
# Reports: N nodes migrated, M failed
```

**No automatic migration on install.** Migration is explicit and user-triggered. In
0.2.0, `tropo migrate` supports `--from file` into the configured embedded backend.
Non-file sources, cloud targets, automatic backend installation, and `migrated_at`
tracking are future 0.3.x work.

**No provider embeddings in tropo migration.** The embedded backend stores indexed
node content and can be queried at the backend layer, but migration does not create
stored vectors, call providers, or override the workspace's `tropo.toml` exclusions.
Public `tropo find` and default `tropo query` search the analyzed typed graph
directly. `tropo query --mode vector` uses dependency-free local typed vectors at
query time or falls back to text search when no vector config is present.
`tropo query --mode semantic` delegates to an explicitly configured optional
semantic-memory provider and returns typed node ids; it is unavailable until the user
installs and indexes that provider.

---

## Python interface

`StorageBackend` protocol in `tropo`. Existing file-system logic becomes `FileBackend` (wrapper, no behavior change). New backends are pip-extra-gated.

```python
# packages/tropo/storage.py

from typing import Protocol, runtime_checkable

@runtime_checkable
class StorageBackend(Protocol):
    def upsert(self, nodes: list[dict]) -> None: ...
    def get(self, node_id: str) -> dict | None: ...
    def delete(self, node_id: str) -> None: ...
    def query(self, text: str, k: int = 10, filters: dict | None = None) -> list[dict]: ...
    def migrate_from(self, source: "StorageBackend") -> dict: ...  # returns stats
    def close(self) -> None: ...


class FileBackend:
    """Default: existing tropo file-system graph. No new dependencies."""
    ...

class LanceBackend:
    """Embedded vector DB. Requires: pip install vivary-tropo[embedded]"""
    def __init__(self, path: str): ...

class QdrantBackend:
    """Cloud/self-hosted. Requires: pip install vivary-tropo[cloud]"""
    def __init__(self, url: str, api_key: str, collection: str): ...

class AstraBackend:
    """Enterprise cloud. Requires: pip install vivary-tropo[astra]"""
    def __init__(self, token: str, endpoint: str, collection: str): ...
```

Extras in `pyproject.toml`:
```toml
[project.optional-dependencies]
embedded = ["lancedb>=0.5"]
cloud    = ["qdrant-client>=1.9"]
astra    = ["astrapy>=1.0"]
```

`tropo` loads the backend from `.vivary/storage.toml`. If absent, defaults to `FileBackend`.

---

## .vivary/storage.toml schema

```toml
# .vivary/storage.toml — generated by create-vivary wizard
# Do not edit by hand unless you know what you're doing.
# Run `create-vivary wizard` to reconfigure.

[storage]
backend = "auto"            # auto | file | embedded | cloud

# For backend = "embedded":
[storage.embedded]
path = ".vivary/data"
provider = "lancedb"        # lancedb | sqlite-vec

# For backend = "cloud":
# [storage.cloud]
# provider = "qdrant"       # qdrant | astra
# url = "https://..."
# api_key = "${VIVARY_CLOUD_API_KEY}"
# collection = "my-workspace"

# migrated_at = ""          # set by `tropo migrate` on completion

# Optional local typed vectors for `tropo query --mode vector`:
# [storage.embedding]
# enabled = true
# provider = "local-hash"
# dimensions = 128
```

`.vivary/` should be in `.gitignore` by default (contains runtime data + secrets). The scaffold adds it.

---

## Wizard + agent-native init

The wizard is the `create-vivary init` (and `create-vivary wizard`) command. It replaces the current minimal init prompts entirely — it's strictly better UX for the same job.

**Two invocation modes:**

### Human mode (interactive)
```bash
create-vivary init my-workspace
create-vivary wizard          # reconfigure an existing workspace
```

### Agent mode (non-interactive)
```bash
# Use safe file storage with no questions:
create-vivary init my-workspace --auto

# Classify the workspace without selecting or installing a provider:
create-vivary init my-workspace --auto --size large --privacy local

# Dry run — print what would be scaffolded, install nothing:
create-vivary init my-workspace --auto --dry-run --json

# Fully scripted with explicit choices:
create-vivary init my-workspace --preset coding --storage embedded --no-wizard

# Machine-readable output for agent consumption:
create-vivary init my-workspace --auto --json
# → { "ok": true, "preset": "coding", "storage": "file", "provider": "lancedb",
#     "installed": [], "config": null, "dry_run": false }
```

**`--auto` decision logic (agent-callable, no human required):**

```
if explicit --storage is set and not "auto"     → that storage tier
elif privacy = "cloud"                          → cloud config (backend future 0.3.x)
else                                            → file (no new dependencies)
```

Agents inspecting a codebase can count files, detect languages, read existing
`STRATO.md`, and pass explicit `--size` and `--privacy` flags. Size alone never grants
provider-install authority. The wizard outputs JSON so the calling agent can read the
decision.

**Human wizard question flow (plain English, no jargon):**

```
Welcome to Vivary! Let's set up your workspace.

  What are you building?
  ❯ A coding workspace  (software projects, codebases)
    A second brain      (notes, ideas, research)
    A writing workspace (drafts, content, blog posts)
    Something else

  How large do you expect this to get?
  ❯ Just starting out                       → file (no new installs)
    Growing — hundreds of files or notes    → ask for a storage choice
    Large — huge codebase or years of notes → ask for a storage choice

  [If "growing" or "large" selected:]
  How should Vivary store searchable context?
  ❯ Project files only — local, no provider install
    Embedded search — local, installs LanceDB
    Cloud search — requires a separate provider

  [If "cloud" selected:]
  Which cloud service?
  ❯ Qdrant (free tier, open source, easiest setup)
    Astra DB (DataStax, enterprise scale)
    I'll set this up later

  [If Qdrant/Astra selected:]
  Paste your API key here, or press Enter to set it up later:
  > _______________

  [Summary before scaffolding:]
  Here's what we'll set up:
  ✓ Coding workspace
  ✓ Smart search across your workspace (stays on your computer)

  Looks good? (Y/n)
```

**"?" inline help:** Typing `?` at any prompt shows a plain-English explanation. Example:
> "Smart search lets your AI assistant find relevant files and notes by meaning,
> not just keyword. It works entirely on your computer — nothing is sent online."

**agent-callable doctor integration:** After init, `create-vivary doctor` validates the configured backend is reachable and reports what's installed. Agents can call this as a health check.

---

## Shipped implementation and future work

### Shipped in 0.2.0 — Storage abstraction + LanceDB

- `StorageBackend` protocol in `tropo/storage.py`
- `FileBackend` wrapping existing logic
- `LanceBackend` (gated on `vivary-tropo[embedded]`)
- `.vivary/storage.toml` loading in `tropo`
- `auto` resolves to `LanceBackend`
- Unit tests for backend protocol compliance

### Shipped in 0.2.0 — Wizard + agent mode

- `create-vivary init` replaces existing prompts
- `--auto`, `--json`, `--dry-run`, `--no-wizard` flags
- `create-vivary wizard` as re-configuration alias
- `.vivary/storage.toml` scaffolded by wizard
- `doctor` validates backend connectivity
- `--auto` decision logic tested with explicit size/privacy/storage hints

### Shipped in 0.2.0 — Migration command

- `tropo migrate --from file --to embedded`
- Reports migrated/failed counts and duration
- `--dry-run` preview mode
- Uses indexed node content; no provider embeddings or stored vector search in migration

### Future — Cloud adapters (0.3.x)

- `QdrantBackend` (gated on `vivary-tropo[cloud]`)
- `AstraBackend` (gated on `vivary-tropo[astra]`)
- Env var interpolation in `storage.toml`
- Non-file migration sources and cloud migration targets
- `migrated_at` tracking in `.vivary/storage.toml`

---

## Out of scope

- `vivary.toml` — settled.
- Weaviate, ChromaDB, Pinecone as primary backends.
- mem0 / Zep as storage primitives — layers above storage; document as optional integrations.
- Automatic migration on install — migration is always explicit via `tropo migrate`.
- Multi-backend writes simultaneously.
- Provider embedding model ownership — tropo delegates; optional semantic-memory
  providers own external embedding/index mechanics.
- Chunked-text RAG — not this product. Semantic retrieval should operate over typed
  nodes or active-context sidecars, not arbitrary chunks.

---

_Historical note: this plan was approved and shipped as the 0.2.0 data-layer slice.
Future cloud/provider-vector work still requires fresh plan+alignment before
implementation._
