# Vivary documentation

Start here.

| Doc | What it covers |
|---|---|
| [GETTING-STARTED.md](GETTING-STARTED.md) | Install → create a workspace → run the loop. Begin here. |
| [WALKTHROUGH.md](WALKTHROUGH.md) | Public, generic proof of the product loop: scaffold, health, review, coordination, impact. |
| [COMMANDS.md](COMMANDS.md) | Full CLI reference for `tropo` · `ozone` · `exo` · `create-vivary`. |
| [HOWTO.md](HOWTO.md) | Task recipes: add a type, see blast radius, review, CI, multi-agent, … |
| [SKILLS.md](SKILLS.md) | The agent skills: strato (bootstrap/heartbeat/self-improve), tropo, loops. |
| [ACTIVE-CONTEXT.md](ACTIVE-CONTEXT.md) | Optional CocoIndex-code sidecar for active semantic code context. |
| [LLM-ACTIVE-CONTEXT.md](LLM-ACTIVE-CONTEXT.md) | Copyable LLM instructions for graph-first CocoIndex-code retrieval. |
| [SEMANTIC-MEMORY.md](SEMANTIC-MEMORY.md) | Architecture and optional adapter plan for semantic memory providers such as Cognee. |
| [PRODUCT-ROADMAP.md](PRODUCT-ROADMAP.md) | High-leverage product backlog for context compression, maps, recall, and optional integrations. |
| [HARNESS-STRATEGY.md](HARNESS-STRATEGY.md) | Research-backed path from workspace standard to a portable Task Capsule, receipt, and gated-learning loop. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The layer model (tropo → strato → ozone → exo) and the why. |
| [OBSIDIAN.md](OBSIDIAN.md) | Optional Obsidian setup for fans (never required). |
| [SIGNALS.md](SIGNALS.md) | Public npm, PyPI, and GitHub metrics snapshots. |
| [RELEASE-WORKFLOW.md](RELEASE-WORKFLOW.md) | End-of-update release truth, docs/site sync, publishing, and post-copy checklist. |
| [FAQ.md](FAQ.md) | Common questions. |

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
them. Everything is plain Markdown + zero-dependency CLIs — no editor, no vendor, no
lock-in.
