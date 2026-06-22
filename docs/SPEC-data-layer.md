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
0.2.0 shipped the storage layer, text/BM25-style graph search, migration, setup
wizard, and agent-mode flags. Cloud adapters and vector retrieval remain future work.

---

## Design constraints (non-negotiable)

1. **Minimalism law holds.** The baseline must stay zero-dependency. Storage is opt-in — the default path installs nothing new.
2. **Windows-first.** Any embedded option must run on Windows without Docker or a server process.
3. **The CLI is the agent API.** No MCP server, no special protocol. Every command a human can run, an agent must be able to run non-interactively with structured output. This is the core agent-native contract — see the [Agent CLI contract](#agent-cli-contract) section.
4. **Non-technical users are first-class.** Wizard language is plain English; no database jargon in the primary flow.
5. **Config lives in `.vivary/`.** Workspace-level storage config is `.vivary/storage.toml`. This keeps generated/runtime infra out of the workspace root and gitignore-able as a directory.

---

## Agent CLI contract

**The CLI is the only agent interface for Vivary.** No MCP server, no SDK, no special protocol. The same commands humans type are what agents call.

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
| `--yes` | Auto-confirm all prompts. Combined with `--json`, fully non-interactive. |
| `--auto` | Agent picks the best option based on available signals (file count, workspace type, hints). No questions asked. |
| `--size small\|medium\|large` | Hint for `--auto` decisions. Agents can inspect a codebase and pass this. |
| `--privacy local\|cloud` | Hint for `--auto` storage decisions. |

### Self-install

When a wizard or migration command decides it needs `vivary-tropo[embedded]` (or another extra), it **installs it** during execution if not already present — `pip install vivary-tropo[embedded]` via subprocess. The agent does not have to know about pip extras. In `--json` mode the output reports `"installed": ["lancedb"]` so the agent knows what changed.

If `--yes` is not set and the install would be the first time a new dep is added, the command prompts for confirmation before calling pip. In `--yes` mode, install is automatic.

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
# Agent inspects the repo, decides it's a large coding workspace, scaffolds and configures:
create-vivary init . --preset coding --auto --size large --privacy local --yes --json
# → { "preset": "coding", "storage": "embedded", "provider": "lancedb",
#     "installed": ["lancedb"], "config": ".vivary/storage.toml", "status": "ok" }

# Agent checks workspace health:
create-vivary doctor . --json
# → { "status": "ok", "nodes": 9, "edges": 28, "broken": 0, "backend": "embedded" }

# Agent validates the graph:
tropo check --root . --json
# → { "errors": 0, "warnings": 0, "files": 42 }

# Agent runs migration after adding embedded backend to existing workspace:
tropo migrate --from file --to embedded --yes --json
# → { "migrated": 312, "failed": 0, "duration_ms": 4200, "backend": "lancedb" }

# Agent queries the knowledge graph by text:
tropo query "what decisions affect the auth module" --json
# → { "results": [ { "id": "...", "type": "decision", "score": 2, ... } ] }
```

---

## Architecture: why NOT naive RAG

The shipped 0.2.0 layer is storage/search infrastructure, not a chunked-RAG system.
If Vivary adds vector retrieval later, it should preserve this boundary.

**This is NOT chunked-text RAG.** Naive RAG = chunk arbitrary documents into ~500-token blobs, embed each chunk, retrieve top-k at query time. This throws away all the structure in a knowledge graph — relationships, types, hierarchy — and produces chunking artifacts that hurt retrieval quality.

**Future vector retrieval should be graph-shaped.** Vivary already has a typed
knowledge graph (tropo: folder-as-type, each node is a typed entity). Any future
embedding layer should operate on graph nodes, preserve relationships and types, and
return typed graph nodes for agents to follow.

**For code specifically:** CocoIndex (already in Vivary as of PR #40) provides
structured active-context indexing — ASTs, call graphs, import graphs, hot context.
That's strictly better than RAG for code. The shipped `tropo query` command is
text/BM25-style graph search; semantic code retrieval belongs to the active-context
CocoIndex sidecar.

**For second brain / writing:** The tropo graph is the index. Future embeddings, if
added, should embed graph nodes rather than arbitrary chunks so the agent retrieves
structured entities and can traverse typed relationships.

**Future retrieval notes by workspace type:**

| Workspace | Retrieval approach | Role of LanceDB |
|---|---|---|
| Coding | CocoIndex active context first; tropo graph search for docs/decisions | Future persistence target for structured code context |
| Second brain | Graph traversal (tropo edges), with possible typed-node embeddings later | Future local index for graph-node retrieval |
| Writing | Text graph search now; typed-node vectors later if corpus scale needs it | Future local index for graph-node retrieval |

**Critical nuance for coding:** For coding workspaces, avoid a separate
tropo-to-vector pipeline for source code. CocoIndex owns structured code indexing;
tropo owns the typed workspace graph.

Naive chunked-text RAG on code achieves ~2% task accuracy vs. 50–80% for AST-based structured indexing (SWE-bench class). Future tropo typed-node embeddings would be materially better than naive RAG because node type is preserved as a filter dimension — a `decision` node and a `reference` node don't collapse into identical-looking text chunks.

Full GraphRAG (Microsoft-style community summarization) is overkill for local workspaces. A future tropo graph + LanceDB node-embedding layer can provide the same structural benefit without the cost.

---

## Storage tier model

Three tiers, one interface. Users never think about tiers — the wizard maps their answers.

```
file (default)  →  tropo's existing file-system graph. No new deps. Works for small workspaces.
embedded        →  LanceDB. In-process, disk-file, zero server. Unlocks indexed graph search now and future local vector retrieval.
cloud           →  Qdrant Cloud (primary) or Astra DB (enterprise). Requires account + API key.
```

`auto` = embedded (LanceDB at `.vivary/data/`). Recommended for anything beyond "just starting out."

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
to `embedded` (LanceDB) for indexed local search. Without migration, the LanceDB index
starts empty and agents can't find anything.

**Solution: `tropo migrate` command.**

```bash
tropo migrate --from file --to embedded
# Reads all nodes from the file-system graph
# Embeds them (requires an embedding model — either local or API)
# Writes to LanceDB at .vivary/data/
# Reports: N nodes migrated, M failed

tropo migrate --from embedded --to cloud --provider qdrant
# Reads from LanceDB, writes to Qdrant Cloud
```

**No automatic migration on install.** Migration is explicit and user-triggered. The command is idempotent (safe to re-run). Migration status is tracked in `.vivary/storage.toml` (a `migrated_at` timestamp).

**Embedding model for migration:** tropo delegates this to a configurable embedding function (default: local sentence-transformers or OpenAI API if key is set). This is a new `[embedding]` section in `.vivary/storage.toml`.

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
migrated_at = ""            # set by `tropo migrate` on completion

# For backend = "embedded" (or auto):
[storage.embedded]
path = ".vivary/data"
provider = "lancedb"        # lancedb | sqlite-vec

# For backend = "cloud":
# [storage.cloud]
# provider = "qdrant"       # qdrant | astra
# url = "https://..."
# api_key = "${VIVARY_CLOUD_API_KEY}"
# collection = "my-workspace"

[embedding]
provider = "local"          # local | openai | anthropic
# model = "all-MiniLM-L6-v2"         # for local
# api_key = "${OPENAI_API_KEY}"       # for openai
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
# Auto-pick best config, no questions asked:
create-vivary init my-workspace --auto

# Agent provides context to influence auto-pick:
create-vivary init my-workspace --auto --size large --privacy local

# Dry run — print what would be scaffolded, install nothing:
create-vivary init my-workspace --auto --dry-run --json

# Fully scripted with explicit choices:
create-vivary init my-workspace --preset coding --storage embedded --no-wizard

# Machine-readable output for agent consumption:
create-vivary init my-workspace --auto --json
# → { "preset": "coding", "storage": "embedded", "provider": "lancedb",
#     "installed": ["lancedb"], "config_path": ".vivary/storage.toml" }
```

**`--auto` decision logic (agent-callable, no human required):**

```
if size hint is "large" or file count > 5000   → embedded (LanceDB)
elif size hint is "small" or no signal          → file (no new deps)
elif privacy = "cloud"                          → cloud (Qdrant)
else                                            → embedded (LanceDB, safest default)
```

Agents inspecting a codebase can count files, detect languages, read existing STRATO.md, and pass `--size` / `--privacy` flags. The wizard outputs JSON so the calling agent can read back what was decided.

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
    Growing — hundreds of files or notes    → smart search enabled locally
    Large — huge codebase or years of notes → smart search enabled locally or cloud
    Not sure                                → smart search enabled locally

  [If "large" selected:]
  Where should your data live?
  ❯ On this computer — private, no accounts needed
    In the cloud — sync across machines, scales to any size

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
- `--auto` decision logic tested with simulated contexts

### Shipped in 0.2.0 — Migration command

- `tropo migrate --from X --to Y`
- Idempotent, reports stats
- `migrated_at` written to `.vivary/storage.toml`
- Embedding provider config in `[embedding]`

### Future — Cloud adapters (0.3.x)

- `QdrantBackend` (gated on `vivary-tropo[cloud]`)
- `AstraBackend` (gated on `vivary-tropo[astra]`)
- Env var interpolation in `storage.toml`

---

## Out of scope

- `vivary.toml` — settled.
- Weaviate, ChromaDB, Pinecone as primary backends.
- mem0 / Zep as storage primitives — layers above storage; document as optional integrations.
- Automatic migration on install — migration is always explicit via `tropo migrate`.
- Multi-backend writes simultaneously.
- Embeddings model ownership — tropo delegates; the graphify semantic layer (#16) owns the embedding strategy long-term.
- Chunked-text RAG — not this product. Future semantic retrieval should operate over
  typed nodes or active-context sidecars, not arbitrary chunks.

---

_Historical note: this plan was approved and shipped as the 0.2.0 data-layer slice.
Future cloud/vector work still requires fresh plan+alignment before implementation._
