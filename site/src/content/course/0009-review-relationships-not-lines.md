---
title: "Review relationships, not lines"
shortTitle: "Ozone"
description: "A short source-grounded lesson on choosing tropo check, ozone review, or ozone impact."
order: 8
module: "04"
moduleTitle: "Ozone: graph-aware review"
status: "Optional layer"
minutes: 10
tags: ["ozone", "review", "graph-aware", "ci"]
outcomes:
  - "Match each review question to its tool: is this one document valid (tropo check), is the graph around it healthy (ozone review), what would changing this node touch (ozone impact / tropo blast)."
  - "State that ozone review is advisory by default and only becomes a merge gate with --strict."
  - "Name what --pack context-budget flags, and what it explicitly never reads."
sources:
  - label: "Vivary Commands — the ozone review layer: check vs. review vs. impact"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/COMMANDS.md"
    locator: "§ozone — the review layer, L305-320"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Vivary HOWTO — Review the graph before a gate"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md"
    locator: "§Review the graph before a gate, L75-91"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Vivary HOWTO — Use Vivary in CI; Run Vivary as a CI gate"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md"
    locator: "§Use Vivary in CI, L223-235; §Run Vivary as a CI gate, L235-260"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Vivary Concepts — blast radius, defined"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/CONCEPTS.md"
    locator: "§The words, defined, L33-35"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
interactions:
  - id: "0009-per-document"
    kind: "multiple-choice"
    prompt: "Which command validates one document's required fields, types, and that its refs resolve?"
    options:
      - text: "tropo check — one document at a time."
        correct: true
        feedback: "Right — check validates frontmatter and the graph per document, opinionated and strict by default."
      - text: "ozone review — the whole graph at once."
        feedback: "ozone review looks across the whole graph's relationships, not one document's own fields."
      - text: "ozone impact — one node's blast radius only."
        feedback: "impact traces what depends on a node id; it doesn't check that node's own required fields."
      - text: "ozone packs — lists the available rule packs."
        feedback: "packs only lists what review packs exist; it validates nothing itself."
    success: "Correct — tropo check owns per-document validation; nothing else in the review layer does."
    reveal: "tropo check = one document. ozone review = the graph between documents."
  - id: "0009-whole-graph"
    kind: "multiple-choice"
    prompt: "Which command flags an unverified change, an orphaned node, and a broken edge — anywhere in the graph, not just the files you touched?"
    options:
      - text: "ozone review — scoped to the whole graph."
        correct: true
        feedback: "Right — where tropo check asks \"is each document valid?\", ozone reviews the whole graph and a change's impact."
      - text: "tropo check — scoped to one document alone."
        feedback: "tropo check has no relationship view; it validates one document, not the connections between them."
      - text: "ozone impact — scoped to one node's dependents."
        feedback: "impact traces one node's blast radius, not every orphan or broken edge in the graph."
      - text: "tropo blast — scoped to one node's dependents."
        feedback: "blast reports one node's transitive dependents, not graph-wide orphans or edges."
    success: "Correct — ozone review is the only one of the four scoped to the whole graph's relationships."
    reveal: "Plain ozone review is advisory; --pack context-budget and --pack all widen the sweep, and --strict is what turns a warning into a failing build."
  - id: "0009-ci-gate"
    kind: "multiple-choice"
    prompt: "You're wiring the merge gate: it must fail the build on any relationship warning anywhere in the graph, not just files the PR touched. Which command belongs in CI?"
    options:
      - text: "ozone review with the --strict flag enabled."
        correct: true
        feedback: "Right — --strict turns the advisory relationship check into a gate: exit 1 on any warning."
      - text: "tropo check with the --strict flag enabled."
        feedback: "tropo check is already strict by default and only ever sees one document at a time."
      - text: "ozone impact run before every single merge."
        feedback: "impact traces one node's blast radius; it doesn't gate the whole graph's relationships."
      - text: "ozone review with no flag at all."
        feedback: "Without --strict, ozone review stays advisory — exit 0 even with warnings, so it won't fail the build."
    success: "Correct — --strict is what makes ozone review a merge gate instead of an advisory pass."
    reveal: "The CI line is tropo check, then ozone review --strict — per-document gate, then relationship gate."
---

> A diff shows you what changed. It has never once told you what depends on it, what nothing verifies, or what quietly broke three files away — for that you need a different tool, and pointing the wrong one at the problem just burns a review cycle.

## Why this exists

Route each review question to the tool built to answer it: is this one document valid, is the graph around it healthy, and what would changing this node actually touch? Confusing the three either lets a real gap through, or wastes a review cycle checking a layer that was never going to catch it.

## How it works

Three commands, three different failure modes, one line each in the source:

- **`tropo check` · per document.** *"Validate frontmatter + the graph. Opinionated: warnings fail by default."* It confirms required fields are present, types match `tropo.toml`, and every reference resolves — one document at a time. Under strict mode, the default, any warning fails the run.
- **`ozone review` · whole-graph relationships.** *"Where `tropo check` asks 'is each document valid?', `ozone` reviews the whole graph and a change's impact."* It's **advisory by default** — exit 0 even with warnings — and `--pack context-budget`, `--pack all`, or `--strict` change what it covers and whether it can fail a build.
- **`ozone impact <id>` · blast radius.** *"The blast radius of a node — what (transitively) depends on it, with distance and the edge field it came in by."* Same reasoning as `tropo blast`, framed for review. Run it before you edit anything load-bearing; a text diff cannot give you this at all.

HOWTO pairs the first two directly: *"`tropo check` validates each document; `ozone review` checks the relationships between them. Use both before you merge."* And it's specific about the pack that catches routing bloat — `--pack context-budget` "flags missing `modules/*/index.md` routers, legacy `modules/*.md` files that coexist with directory indexes, oversized public routing surfaces, exact duplicated routing blocks, and wording that tells agents to bulk-load whole repos or docs trees. It does not read private `USER.md`, `MEMORY.md`, `memory/**`, or heartbeat reports."

The CI line follows directly from that: `tropo check` (strict by default, warnings fail), then `ozone review --strict` (the relationship gate). HOWTO's own copy-paste CI job runs exactly that pair before it calls a workspace clean.

## Don't conflate

- **`tropo check` can't see the graph.** A document can pass every field check and still be an orphan nothing links to, or a "fix" nothing verified.
- **`ozone review` can't fix a malformed document.** It assumes each document is already individually valid; it reasons about edges and coverage, not required fields or types.
- **Advisory is not the same as gated.** Plain `ozone review` reports problems and still exits 0. Only `--strict` turns that same command into something CI can fail on.
- **`--pack context-budget` flags routing bloat, not private files.** It never reads `USER.md`, `MEMORY.md`, `memory/**`, or heartbeat reports — that boundary holds even inside the review layer.

## Try it on a real workspace

Before you touch a load-bearing node, run all three in order: `tropo check` on the document, `ozone review` on the graph around it, `ozone impact <id>` on the node itself. Compare what each one actually catches — that's the fastest way to feel the line between "this document is malformed" and "this document is fine but the graph around it isn't."

## One-minute recall

1. Left column: **`tropo check`** — per document, strict by default.
2. Middle column: **`ozone review`** — whole graph; `--pack context-budget` and `--pack all` widen it.
3. Right column: **`ozone impact`** / **`tropo blast`** — one node's blast radius, run before you edit it.
4. Underneath all three: the CI line — **`tropo check`, then `ozone review --strict`.**

Tomorrow, before you reopen a review doc, name which command would catch an orphaned node that still has perfectly valid frontmatter — and which flag would make that catch fail a build.

## Sources

- [Vivary Commands — the ozone review layer: check vs. review vs. impact](https://github.com/vivary-dev/vivary/blob/dev/docs/COMMANDS.md)
- [Vivary HOWTO — Review the graph before a gate](https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md)
- [Vivary HOWTO — Use Vivary in CI; Run Vivary as a CI gate](https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md)
- [Vivary Concepts — blast radius, defined](https://github.com/vivary-dev/vivary/blob/dev/docs/CONCEPTS.md)
