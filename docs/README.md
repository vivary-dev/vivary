# Vivary documentation

Start here.

| Doc | What it covers |
|---|---|
| [GETTING-STARTED.md](GETTING-STARTED.md) | Install → create a workspace → run the loop. Begin here. |
| [LEARN-BY-DOING.md](LEARN-BY-DOING.md) | STE100 style guide library for people and agents; routes each real task to one concise procedure. |
| [guides/](guides/) | Canonical task guides for creation, agent connection, retrieval, governed records, adoption, and recovery. |
| [WALKTHROUGH.md](WALKTHROUGH.md) | Historical public 0.3.1 full-scaffold proof; retained as release evidence, not the 0.4.0 thin-init contract. |
| [COMMANDS.md](COMMANDS.md) | Full CLI reference and governed machine-readable envelopes for the role packages and optional adapters. |
| [MCP.md](MCP.md) | Optional local read-only MCP adapter contract, privacy boundary, installation, and verification. |
| [HOWTO.md](HOWTO.md) | Advanced recipes for types, review, CI, coordination, storage, and optional providers. |
| [SKILLS.md](SKILLS.md) | The agent skills: strato (bootstrap/heartbeat/self-improve), tropo, loops. |
| [ACTIVE-CONTEXT.md](ACTIVE-CONTEXT.md) | Optional CocoIndex-code sidecar for active semantic code context. |
| [LLM-ACTIVE-CONTEXT.md](LLM-ACTIVE-CONTEXT.md) | Copyable LLM instructions for graph-first CocoIndex-code retrieval. |
| [SEMANTIC-MEMORY.md](SEMANTIC-MEMORY.md) | Architecture and implemented adapter contract for Tropo-backed semantic memory. |
| [WHITE-PAPER.md](WHITE-PAPER.md) | Technical argument, minimal architecture, human-gate model, and proof standard. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The layer model (tropo → strato → ozone → exo) and the why. |
| [MIGRATION-STATUS.md](MIGRATION-STATUS.md) | Stable, optional, experimental, held, deprecated, and planned surface classifications. |
| [DECISIONS.md](DECISIONS.md) | Compact index of hard-to-reverse decisions and their canonical owners. |
| [OBSIDIAN.md](OBSIDIAN.md) | Optional Obsidian setup for fans (never required). |
| [SIGNALS.md](SIGNALS.md) | Public npm, PyPI, and GitHub metrics snapshots. |
| [RELEASE-WORKFLOW.md](RELEASE-WORKFLOW.md) | End-of-update release truth, docs/site sync, publishing, and post-copy checklist. |

## Project planning (repo only)

These are working documents for maintainers. They are not generated into the
Starlight guides.

| Document | What it covers |
|---|---|
| [bellamente-memory/](bellamente-memory/) | Reconciled contract for optional Bellamente agent LTM and its typed Vivary boundary. |
| [PRODUCT-ROADMAP.md](PRODUCT-ROADMAP.md) | Canonical outcome map behind the public [roadmap page](https://vivary.vercel.app/roadmap/). |
| [CONTENT-ROADMAP.md](CONTENT-ROADMAP.md) | Internal proof-led content and publishing plan. |

Deeper, per-package: [tropo SPEC](../packages/tropo/SPEC.md) (the normative
folder-as-type model), and each package's `README.md`.

## The one-paragraph mental model

A Vivary workspace is a thin local governed-context contract. `AGENTS.md` routes to one
bounded `.vivary/context.md` capsule; `STATE.md` is loaded only when current state
matters; real typed records are added lazily when work produces evidence. An agent runs
*Ask → retrieve → act → verify → learn → gate*, preserves provenance and receipts, and
stops at deliberate human gates. Tropo can compile those files into typed graph context;
Ozone and Exo remain optional. Everything is plain Markdown/TOML plus lightweight local
CLIs—no required editor, network service, provider, or lock-in.
