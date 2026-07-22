---
title: "Enable sidecars deliberately"
shortTitle: "Enable sidecars deliberately"
description: "A short source-grounded lesson on deliberately enabling the CocoIndex-code active-context and Obsidian sidecars."
order: 13
module: "07"
moduleTitle: "Optional sidecars"
status: "Optional sidecar"
minutes: 11
tags: ["sidecars", "active-context", "cocoindex", "obsidian"]
outcomes:
  - "Name the five explicit gates a CocoIndex-code sidecar must cross before it touches source code."
  - "Explain why a scaffold flag writing files is not the same as installing, indexing, or enabling MCP."
  - "State why Obsidian stays optional even after a vault is opened."
sources:
  - label: "Active context: the sidecar and the rule"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/ACTIVE-CONTEXT.md"
    locator: "\"The Rule\" and \"Install And Prove It\""
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Using Vivary with Obsidian (optional)"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/OBSIDIAN.md"
    locator: "\"The editor-free visual graph\" and \"The principle\""
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Agent skills: the active-context entry"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/SKILLS.md"
    locator: "\"active-context — optional semantic code retrieval\""
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
interactions:
  - id: "scaffold-scope"
    kind: "multiple-choice"
    prompt: "What does `--active-context cocoindex-code` do by itself, at scaffold time?"
    options:
      - text: "It writes an active-context skill and graph nodes, while doing nothing further."
        correct: true
        feedback: "Right: a scaffold flag only ever writes files; every other verb waits for its own gate."
      - text: "It installs CocoIndex-code and builds a semantic index during initial workspace scaffolding."
        feedback: "Install and index are separate, later gates — the scaffold flag never crosses them by itself."
      - text: "It enables MCP so an agent can call ccc directly after scaffolding."
        feedback: "Enabling MCP is one of five explicit gates. Scaffolding never trips it."
      - text: "It sends a sample of source text to prove the setup works."
        feedback: "Sending source text anywhere is itself a gate. The scaffold alone sends nothing."
    success: "Correct — the flag writes guidance and graph nodes, and nothing else."
    reveal: "ACTIVE-CONTEXT.md is explicit: the flag does not automatically install CocoIndex-code, initialize an index, run embeddings, enable MCP, or send source text anywhere. Those are gates that need their own approval."
  - id: "gate-check"
    kind: "multiple-choice"
    prompt: "A coding workspace was scaffolded with the sidecar flag last week. Which of these still needs an explicit approval today?"
    options:
      - text: "Running ccc index to build local embeddings today."
        correct: true
        feedback: "Right — indexing is one of the five gated verbs, and scaffolding a week ago didn't cross it."
      - text: "Reading the generated active-context skill file locally today."
        feedback: "Reading a file the scaffold already committed needs no gate — it's just a file."
      - text: "Calling tropo find for a small context budget."
        feedback: "tropo find is baseline graph retrieval. It never touches the sidecar's gates."
      - text: "Opening the workspace in plain Obsidian for reference."
        feedback: "Opening a folder in your own editor isn't a Vivary action at all."
    success: "Correct — indexing is a gate, not a side effect of scaffolding."
    reveal: "Install, initialize, index, enable MCP, and external embedding providers are the five gated verbs named in ACTIVE-CONTEXT.md's Rule. Nothing else on a Vivary sidecar checklist is."
  - id: "obsidian-status"
    kind: "multiple-choice"
    prompt: "Which statement matches Obsidian's documented status in a Vivary workspace?"
    options:
      - text: "Obsidian stays optional; tropo view renders the graph without it."
        correct: true
        feedback: "Right — OBSIDIAN.md calls tropo view the canonical graph visual, no plugin required."
      - text: "Obsidian becomes required after opening a vault inside the workspace."
        feedback: "Opening a vault changes nothing about what's required — Obsidian never becomes load-bearing."
      - text: "Obsidian's Dataview plugin directly enables MCP for the whole workspace."
        feedback: "Dataview is about in-app edge navigation. It has nothing to do with MCP."
      - text: "Obsidian replaces tropo view as the workspace's canonical graph visual."
        feedback: "It's the reverse: tropo view stays canonical; Obsidian is the optional fan layer on top."
    success: "Correct — Obsidian is a fan layer, never the graph's foundation."
    reveal: "\"Recommend Obsidian to fans, never require it\" — the same workspace has to run from a terminal alone."
  - id: "enablement-order"
    kind: "multiple-choice"
    prompt: "A coding workspace already has the sidecar scaffolded. rg keeps returning only naming coincidences for a real search task, and CocoIndex-code has never been installed. What should happen first?"
    options:
      - text: "Ask before installing, then decide which paths qualify."
        correct: true
        feedback: "Right — the rule is ask, then scope the paths, before any install command runs."
      - text: "Install and index every workspace path right away."
        feedback: "Skipping the ask breaks the rule — install and index are both explicit gates."
      - text: "Enable MCP so semantic search happens automatically now."
        feedback: "MCP is a separate, optional gate that comes after search already works over the CLI."
      - text: "Index everything since path sensitivity rarely matters here."
        feedback: "Unclear source sensitivity is exactly the case the guidance says to skip the sidecar, not index blindly."
    success: "Correct — ask, then scope, then install, in that order."
    reveal: "The order is ask → scope the paths → install → initialize/index → search → read the matched files → verify with tests and tropo check. MCP is optional and comes after, if ever."
---

> A scaffold flag is a light switch mounted in the wall. It doesn't turn on the lights, order the bulb, or wire the breaker — it just proves the wall can hold a switch.

## Why this exists

Two optional sidecars sit next to baseline Vivary: CocoIndex-code, a fuzzy semantic-search layer for coding workspaces, and Obsidian, a visual home for the graph. Both are opt-in. Neither redefines what counts as graph truth. The habit this lesson protects is a small but expensive one: reading "the flag is on" as "the capability is on." They are not the same claim, and CocoIndex-code in particular treats the gap between them as a hard rule, not a suggestion.

## How it works

`create-vivary init my-codebase --preset coding --active-context cocoindex-code` writes an `active-context` skill, `docs/active-context.md`, and graph nodes under `modules/active-context/`. That's it. Nothing installs, initializes, indexes, enables MCP, or reaches for an external embedding provider — those five verbs are separate, explicit gates. ACTIVE-CONTEXT.md's Rule states it flatly: agents ask before crossing any of them, unless the workspace already carries approval.

The retrieval order the generated skill follows, once approved, has a fixed shape: `tropo find` first, for a small typed context packet; `tropo graph` / `tropo blast` / `ozone impact` for workspace truth; only then `ccc search --refresh "<query>"` for fuzzy code candidates; then the matched files read directly; then tests and `tropo check` before anything ships. CocoIndex-code never gets to skip ahead of the graph — it supplements retrieval, it doesn't replace it.

Obsidian's shape is flatter. `--obsidian` drops a pre-colored `.obsidian/` starter config and installs nothing else. The canonical graph visual is `tropo view --out graph.html`, which needs no plugin and no editor. If you like Obsidian, its native graph draws `[[wikilinks]]` and tags — not Vivary's typed frontmatter edges — so the optional community Dataview plugin is what actually lets you navigate those edges inside the app. None of that changes what `tropo view` already shows.

## Don't conflate

`.cocoindex_code/` being gitignored is not proof that CocoIndex-code is local-only. It's bookkeeping about what gets committed, not a guarantee about what a tool reads or where it sends data. Deciding which paths CocoIndex-code may see is your own pre-index checklist — a human decision the docs name explicitly — not an automated privacy filter running underneath it. And a scaffold flag writing files is never the same claim as a capability being turned on; keep those two verbs — "wrote" and "enabled" — permanently separate in your head.

## Try it on a real workspace

Scaffold a coding preset with `--active-context cocoindex-code` and stop there. Read the generated skill and `docs/active-context.md` without running `ccc` at all — confirm for yourself that nothing outside the workspace folder changed. Then, if you want to go further, walk the five approvals in order: ask, scope the paths, install, initialize and index, search. Finish with `tropo check` and confirm the graph is still exactly what it was before you started.

## One-minute recall

From memory, recite the five CocoIndex-code gates — install, initialize, index, external embedding provider, enable MCP — and then say Obsidian's count: zero. The scaffold flag writes files either way; every other verb is a separate human approval.

## Sources

- [Active context: the sidecar and the rule](https://github.com/vivary-dev/vivary/blob/dev/docs/ACTIVE-CONTEXT.md) — "The Rule" and "Install And Prove It."
- [Using Vivary with Obsidian (optional)](https://github.com/vivary-dev/vivary/blob/dev/docs/OBSIDIAN.md) — "The editor-free visual graph" and "The principle."
- [Agent skills: the active-context entry](https://github.com/vivary-dev/vivary/blob/dev/docs/SKILLS.md) — the "active-context" skill's retrieval order and gate list.
