---
title: "Navigate before opening"
shortTitle: "Navigate before opening"
description: "A short source-grounded lesson on choosing graph, view, blast, query/find, or map before opening a file."
order: 4
module: "01"
moduleTitle: "Tropo: graph truth"
status: "Baseline"
minutes: 10
tags: ["tropo", "navigation", "graph", "blast-radius"]
outcomes:
  - "Pick the smallest of five Tropo commands (map, graph, view, blast, find/query) that answers a specific question before opening any file."
  - "Run tropo blast on a load-bearing node before editing or removing it, not after."
  - "Describe what tropo find and tropo query actually search — typed graph text and structure, not a promised vector backend."
sources:
  - label: "Vivary Getting Started — See the graph"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/GETTING-STARTED.md"
    locator: "L157-177"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Vivary HOWTO — See what a change would touch; Query the knowledge graph"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md"
    locator: "L65-73, L152-164"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Vivary README — command reference pointer"
    url: "https://github.com/vivary-dev/vivary/blob/dev/README.md"
    locator: "L195"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Vivary Commands — tropo map, find, query, blast, view"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/COMMANDS.md"
    locator: "L29-81, L114-168"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
interactions:
  - id: "0005-unfamiliar-repo"
    kind: "multiple-choice"
    prompt: "You inherit a large, untyped repo with no tropo.toml. Before opening any file, what do you run?"
    options:
      - text: "Run tropo map for the filesystem shape."
        correct: true
        feedback: "Right. map is a read-only filesystem inventory that needs no tropo.toml at all — the first move on a tree Tropo doesn't know about yet."
      - text: "Run tropo graph for the filesystem shape."
        correct: false
        feedback: "tropo graph reads typed nodes; an untyped repo has none yet, so it has nothing to show."
      - text: "Run tropo blast for the filesystem shape."
        correct: false
        feedback: "Blast radius needs a graph id to trace, not a raw, untyped tree."
      - text: "Run tropo find for the filesystem shape."
        correct: false
        feedback: "find searches typed graph nodes; none exist yet without a tropo.toml."
    success: "Correct. An unfamiliar, untyped tree gets mapped before it gets a graph."
    reveal: "Compression: map works before Tropo has typed a single document."
  - id: "0005-browser-rendering"
    kind: "multiple-choice"
    prompt: "You want a self-contained file to open in a browser and click through the graph visually."
    options:
      - text: "Open tropo view for a clickable HTML rendering."
        correct: true
        feedback: "Right. view renders the graph, or one node's blast radius, as a single self-contained HTML file — no editor, no server, no plugin."
      - text: "Open tropo graph for a clickable HTML rendering."
        correct: false
        feedback: "graph --json is machine-readable text output, not a browser rendering."
      - text: "Open tropo map for a clickable HTML rendering."
        correct: false
        feedback: "map inventories files as a table; it does not draw the graph at all."
      - text: "Open tropo query for a clickable HTML rendering."
        correct: false
        feedback: "query returns search results as data, not a visual rendering you click through."
    success: "Correct. Only view renders a clickable, self-contained HTML file."
    reveal: "Rule: view is the human picture; graph is the machine one."
  - id: "0005-load-bearing-edit"
    kind: "multiple-choice"
    prompt: "You are about to retype or remove the note billing. What do you run first?"
    options:
      - text: "Run tropo blast billing before you touch it."
        correct: true
        feedback: "Right. blast names everything that transitively depends on billing — the kind of impact a plain text diff can't show you."
      - text: "Run tropo query billing before you touch it."
        correct: false
        feedback: "query finds mentions of billing; it does not trace which nodes transitively depend on it."
      - text: "Run tropo find billing before you touch it."
        correct: false
        feedback: "find prioritizes what to read first; it skips transitive dependents entirely."
      - text: "Run tropo map billing before you touch it."
        correct: false
        feedback: "map only inventories folders and files; it ignores graph edges entirely."
    success: "Correct. Blast radius is the impact a text diff can't show — check it first."
    reveal: "Habit: run blast before you edit a load-bearing node, never after."
  - id: "0005-budgeted-read-first"
    kind: "multiple-choice"
    prompt: "An agent asks \"what should I read first about release truth?\" inside a small token budget."
    options:
      - text: "Call tropo find with an explicit token budget."
        correct: true
        feedback: "Right. find is the default \"what should I read first\" command for humans and agents, and --budget trims its packet to fit."
      - text: "Call tropo query with an explicit token budget."
        correct: false
        feedback: "query is the lower-level filtered-search primitive; it has no --budget flag at all."
      - text: "Call tropo blast with an explicit token budget."
        correct: false
        feedback: "blast traces the dependents of one node id, not reading priority under a budget."
      - text: "Call tropo view with an explicit token budget."
        correct: false
        feedback: "view renders HTML for a browser; it returns no read-first packet or budget option."
    success: "Correct. find is the budgeted, human-friendly \"read this first\" packet."
    reveal: "Boundary: find is the default \"what should I read first\" command for humans and agents alike."
  - id: "0005-backend-claim"
    kind: "multiple-choice"
    prompt: "A teammate claims tropo find always ranks results with vector embeddings. What does the source actually say?"
    options:
      - text: "It searches typed graph nodes, not embeddings."
        correct: true
        feedback: "Right. find and query search analyzed typed graph nodes directly — id/title, frontmatter, path, body, and outbound edge context — and neither requires LanceDB."
      - text: "It searches typed graph nodes, always LanceDB."
        correct: false
        feedback: "Embedded LanceDB storage is a separate opt-in backend for migrated rows and future retrieval work, not the default search path."
      - text: "It searches typed graph nodes, always Cognee."
        correct: false
        feedback: "Cognee is a separate optional semantic-recall adapter, not what tropo find runs on by default."
      - text: "It searches typed graph nodes, always CocoIndex."
        correct: false
        feedback: "CocoIndex is the active-context sidecar for code search, not the graph/text retrieval find and query perform."
    success: "Correct. find and query search typed graph text and structure, not a promised vector backend."
    reveal: "Evidence: id/title, frontmatter, path, body, and edge context — that's the whole default search surface."
---

> Five commands let you see a repo before you touch it. Reaching for the wrong one burns your context budget; reaching for none burns a lot more.

## Why this exists

Your goal is to stop defaulting to opening files. Tropo ships five read-only lenses at different altitudes — a filesystem inventory, a machine graph, a browser rendering, an impact radius, and two kinds of text search. Each answers exactly one question. The primary walkthrough is [Getting Started, "See the graph"](https://github.com/vivary-dev/vivary/blob/dev/docs/GETTING-STARTED.md). The command-by-command recipes live in [HOWTO](https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md), and the full flag surface is the [README's command reference pointer](https://github.com/vivary-dev/vivary/blob/dev/README.md) to [docs/COMMANDS.md](https://github.com/vivary-dev/vivary/blob/dev/docs/COMMANDS.md).

## How it works

**Never open a file to answer a question a command can already answer.** Map the shape, read the graph, render the picture, trace the radius, or search the text — in that order of commitment. Getting Started names three of these together: *"`tropo graph --json` — the machine-readable view; `tropo view --out graph.html` — a self-contained visual graph; `tropo blast human-gates` — everything that depends on the 'human-gates' note."* It calls that last one **blast radius**: "the kind of impact a plain text diff can't show you."

Order the five lenses by how much you already know about the tree in front of you, from "I've never seen this repo" to "I know exactly which node I'm about to touch":

- **`tropo map`** — read-only inventory. A directory table, extension/size summary, largest files, and "likely modules without an index" — for any repo, vault, or docs tree. No `tropo.toml` required. First move on an unfamiliar tree, before Tropo even knows about it.
- **`tropo graph --json`** — the machine view. The whole typed graph as nodes (`id`, `type`, `path`) and edges (`from`, `field`, `to`, `broken`) — built for scripts, audits, and other tools, not for eyeballing.
- **`tropo view --out FILE`** — the human view. The same graph — or one node's blast radius — rendered as a single self-contained HTML file. Open it in any browser: no editor, no server, no plugin.
- **`tropo blast <id>`** — the impact radius. Everything that transitively refs one node. Run it before you edit or remove a load-bearing note, not after.
- **`tropo find` / `tropo query`** — text search. `find` returns a small, budgeted "what should I read first" context packet. `query` is the lower-level primitive: filtered by type, path glob, or edge, with explainable match reasons. Both return real graph ids, not guesses.

## Don't conflate

HOWTO is explicit about what `query` and `find` actually do: *"`tropo query` and `tropo find` search analyzed typed graph nodes directly: id/title, frontmatter, path, body, and outbound edge context. They do not require LanceDB. Embedded storage is a separate opt-in backend for migrated node rows and future local retrieval work."*

Precision matters here: these commands analyze the typed graph you built by placing files in folders — filesystem-and-frontmatter evidence — not a promise of vector or semantic ranking. Embedded LanceDB storage and Cognee semantic recall are separate, opt-in layers. Don't describe `find`/`query` as "semantic search" unless a specific workspace has explicitly enabled that sidecar; the default command searches text and structure it can already see.

## Try it on a real workspace

Choose one unfamiliar command from the ladder — the one you've been skipping in favor of just opening the file. Predict its output and scope before you run it, then run it against a real workspace and compare the prediction with [docs/COMMANDS.md](https://github.com/vivary-dev/vivary/blob/dev/docs/COMMANDS.md). If you were wrong about the scope, that's the gap this lesson exists to close.

## One-minute recall

1. Unfamiliar tree, no `tropo.toml` yet: write **map**.
2. Whole typed graph for a script or audit: write **graph --json**.
3. Something to click through in a browser: write **view**.
4. About to touch a load-bearing node: write **blast <id>** — always before, never after.
5. "What should I read first," budgeted: write **find**. Precise filtered search: write **query**.

Tomorrow, before you open a single file in any workspace, name out loud which of the five commands answers your actual question — before you touch the file tree.

## Sources

- [Vivary Getting Started — See the graph](https://github.com/vivary-dev/vivary/blob/dev/docs/GETTING-STARTED.md)
- [Vivary HOWTO — See what a change would touch; Query the knowledge graph](https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md)
- [Vivary README — command reference pointer](https://github.com/vivary-dev/vivary/blob/dev/README.md)
- [Vivary Commands — tropo map, find, query, blast, view](https://github.com/vivary-dev/vivary/blob/dev/docs/COMMANDS.md)
