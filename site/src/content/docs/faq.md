---
title: "FAQ"
description: "Common questions about Vivary."
---

New to all of this? Read [Concepts](/concepts/) first; it defines every term in plain
language. The quick beginner answers are right below.

### New here

**What does Vivary actually do?**
It sets up your project folder so an AI agent (Claude Code, Codex, and the like) has a
memory it can trust, a clear record of the current state, and guardrails before
anything risky. One command, all in plain text files you can read yourself.

**Do I need to be a programmer?**
No. If you can run one command in a terminal, you can scaffold a workspace. The
`coding` preset suits software projects, but `second-brain` and `writing` are for
notes and manuscripts.

**What's an "agent"? What's a "harness"?**
An *agent* is an AI tool that reads and changes your files for you. A *harness* (Claude
Code, Codex) is the program that runs it. See [harnesses,
explained](/blog/harnesses-explained/).

**Does my data leave my machine?**
Vivary itself never contacts a model; it only reads and writes local files. You can run
the whole thing with a [local model](/blog/run-vivary-with-local-models/) and keep
everything offline.

### What is Vivary, in one sentence?
A standard and scaffolder for agent-native workspaces: *a self-improving loop running
over a typed, navigable knowledge graph, with one visible state surface and human
gates.* In short, it gives an AI agent a working memory you can inspect.

### What are the four layers?
- **tropo** — the typed knowledge graph (what's true). The folder *is* the type.
- **strato** — the agent OS: the operating loop, visible state, memory, gates,
  self-improvement.
- **ozone** — review: graph-aware checks + blast-radius impact (optional).
- **exo** — coordination when one agent becomes many (optional, thinnest).

The **baseline is tropo + strato**; ozone and exo snap on as needed.

### Do I need Obsidian?
No. Nothing in Vivary depends on Obsidian — it's plain Markdown + YAML and works in any
editor or none. The visual graph renders editor-free with `tropo view`. Obsidian fans
get an opt-in setup (`create-vivary init … --obsidian`); see [OBSIDIAN.md](/obsidian/).

### Which agent runtimes does it work with?
Any. A workspace ships both `.claude/skills/` (Claude Code) and `.agents/skills/` +
`AGENTS.md` (Codex), and the contract is runtime-agnostic. No single-vendor lock-in.

### Why is `tropo check` "opinionated"? It keeps failing on warnings.
By design — the CLI is a gate, not a linter. Untyped docs, unknown/typo'd fields, broken
refs, and redundant frontmatter all fail by default, so the graph stays trustworthy.
Relax with `tropo check --lenient` (per run) or `[base] strict = false` (per vault). Run
`tropo fix` to clear the redundant-frontmatter (`W210`) noise in one shot.

### Why folder-as-type instead of a `type:` field?
One source of truth. A document's type is *where it lives* — move a file between folders
and it's retyped, no edit needed. A `type:` that just repeats the folder is noise, and
three ways to set one fact is harder to enforce, not easier. (There's a decision doc on
this in tropo's example vault.)

### How does Vivary avoid context bloat?
Root files and `index.md` files route; they do not store everything. Generated modules
live at `modules/<id>/index.md`, and the agent uses `modules/index.md` plus the graph
to choose which one to open. Durable detail should live once in the owning typed file,
skill, source file, or test.

### What's the difference between `tropo check` and `ozone review`?
`tropo check` validates **each document** (required fields, types, that refs resolve).
`ozone review` looks at the **relationships across the whole graph** — a change with
nothing verifying it, an orphaned node, a broken edge — the stuff a per-document check
can't see. Use both before merging.

### What is "blast radius"?
Everything that (transitively) depends on a node — what a change to it could touch.
`tropo blast <id>` / `ozone impact <id>`. It's the impact reasoning a text diff cannot
give, and it's the moat: review by *what it touches*, not just *what lines changed*.

### Does tropo support search?
Yes. `tropo query "auth module"` searches analyzed typed graph nodes with no extra
dependencies: id/title, frontmatter, path, body, and outbound edge context. Use
`tropo find` when you want a small "open these first" packet.

```bash
tropo query "auth module" --root my-workspace --k 5
tropo find "what should I read for auth?" --root my-workspace --budget 1200
```

LanceDB is still available as the explicit embedded storage backend for migrated node
rows, but public `tropo query` / `find` stay graph-first and zero-dependency in the
current command surface. Semantic/vector embeddings are not in scope for tropo — those
belong to a graphify-style layer that consumes the clean typed graph.

### Does tropo do semantic search / embeddings?
No, deliberately. tropo owns the **typed** graph (explicit links). Semantic
("organize by meaning") clustering is a separate, future job — a graphify-style layer
that *consumes* tropo's clean graph. Keeping embeddings out keeps the core zero-dependency
and deterministic.

### Can Vivary set up semantic memory or Cognee?
Yes, as optional setup policy. Use `create-vivary capabilities --preset knowledge-work
--json` to see what a preset can offer, then pass `--memory local` or `--memory cognee`
to `create-vivary init`. `local` writes local-only semantic-memory policy.
`cognee` writes Cognee policy, config, and verification docs, but it does not install
Cognee, index files, start a server, use an API key, or send data anywhere. Those
remain explicit gates.

### What is the wizard?
When you run `create-vivary init` on a terminal that supports input, it prompts you in plain English — no database jargon — to pick a storage tier (local file, local LanceDB, or cloud config) and optional semantic-memory policy. For scripted selection, pass `--no-wizard --storage embedded --memory local --yes` or use `--auto`; in human mode, the wizard asks and its answers drive storage and memory policy. Use `create-vivary wizard <target>` to reconfigure an existing workspace without re-scaffolding.

### How do agents self-configure a workspace?
```bash
create-vivary init . --preset coding --auto --size large --yes --json
```
`--auto` picks the best storage tier from explicit `--storage`, `--privacy`, and `--size` hints, `--yes` auto-confirms any installs, and `--json` outputs machine-readable results. No prompts, no human needed. Dry-run first with `--dry-run --json` to preview without writing or installing anything.
`--auto` does not choose Cognee by itself; Cognee requires an explicit `--memory cognee`
or wizard selection.

### Can Vivary use CocoIndex?
Yes, as an optional sidecar for coding workspaces. Scaffold it with
`create-vivary init my-codebase --preset coding --active-context cocoindex-code`.
That adds an active-context skill, docs, graph nodes, and `.cocoindex_code/` to
`.gitignore`. It does not auto-install CocoIndex-code, build an index, enable MCP, or
send source text anywhere. The generated skill asks before crossing those gates, then
uses the approved `ccc init` / `ccc index` / `ccc search --refresh` path alongside
`tropo find` / `tropo graph` / `tropo blast`. The copyable agent version lives in
[LLM-ACTIVE-CONTEXT.md](/llm-active-context/).

### Why are there package names like `vivary-tropo` but the command is `tropo`?
PyPI has no scopes and the bare names `tropo`/`ozone`/`exo` were taken, so the
*distributions* are `vivary-tropo` / `vivary-ozone` / `vivary-exo`. The *commands* you run
stay `tropo` / `ozone` / `exo`. On npm the scaffolder is `@vivary/create`.

### How do I install / run it?
`pip install vivary-tropo vivary-ozone vivary-exo create-vivary==0.2.7`, or run on demand with
`uvx vivary-tropo ...`, or scaffold with `npm create @vivary@latest`. Python 3.11+ only;
zero third-party dependencies.

### Can I use just tropo (the graph), without the rest?
Yes. tropo is a standalone typed-knowledge CLI for any Markdown tree — `pip install
vivary-tropo` and `tropo init`. The other layers are optional.

### What are the "human gates"?
Durable or outward-facing actions that need explicit, per-item human approval — never
batched: memory writes, publishing (PyPI/npm), `git push`/PR/merge, org/repo creation,
installs, enabling hooks, destructive ops, and sending data of unknown sensitivity. The
agent is bold *inside* the work and careful at the *edges*.

### What did the latest security-hardening batch cover?
The June 23 package set hardens local file boundaries:
`create-vivary` refuses symlinked or out-of-workspace scaffold destinations, `doctor`
checks active `.gitignore` rules for private files and heartbeat reports,
`tropo view --out` keeps generated HTML writes inside the tropo root, and `exo claim`
rewrites the workspace file without mutating hard-linked files outside it. See the
changelog for the exact package surfaces.

### Is it stable? What's the version?
Published packages are `vivary-tropo` **0.3.0**, `vivary-exo` **0.2.2**,
`create-vivary` / `@vivary/create` **0.2.7**, and `vivary-ozone` **0.2.0**. Use
0.2.7 for new scaffolds. It's young — APIs may move before `1.0`. File issues for
rough edges.

The versions differ on purpose: the layers are independently versioned. This release
changes tropo retrieval, ozone review packs, and the scaffolder's generated guidance;
it does not change exo.

### Where do I report bugs or ask for features?
GitHub: [github.com/vivary-dev/vivary](https://github.com/vivary-dev/vivary). See the
open issues for what's planned next.

### Is it free / open source?
Yes — MIT licensed.
