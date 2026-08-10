# Vivary documentation

Start here.

| Doc | What it covers |
|---|---|
| [GETTING-STARTED.md](GETTING-STARTED.md) | Install → create a workspace → run the loop. Begin here. |
| [LEARN-BY-DOING.md](LEARN-BY-DOING.md) | Short, evidence-led first loop; routes to the full proof and exact command owners. |
| [WALKTHROUGH.md](WALKTHROUGH.md) | Public, generic proof of the product loop: scaffold, health, review, coordination, impact. |
| [COMMANDS.md](COMMANDS.md) | Full CLI reference and governed machine-readable envelopes for the role packages and optional adapters. |
| [MCP.md](MCP.md) | Optional local read-only MCP adapter contract, privacy boundary, installation, and verification. |
| [HOWTO.md](HOWTO.md) | Task recipes: add a type, see blast radius, review, CI, multi-agent, … |
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

A Vivary workspace is a folder where **the filesystem is the schema**: a document's type
is the folder it lives in (`tropo`), and typed frontmatter fields become a navigable
graph. An agent operates it with a per-turn loop — *Ask → retrieve → act → verify →
learn → gate* (`strato`) — retrieving from the graph, verifying with `tropo check` +
`ozone review`, naming blast radius before risky changes, and stopping at human gates.
`AGENTS.md` and module `index.md` files route progressively so durable detail lives
once instead of being copied everywhere. When one agent becomes many, `exo` coordinates
them. Everything is plain Markdown plus lightweight, provider-free CLIs — no editor,
network service, vendor, or lock-in.
