---
title: "Create a healthy workspace"
shortTitle: "Create a healthy workspace"
description: "A short source-grounded lesson on the documented greenfield Vivary workspace path."
order: 10
module: "06"
moduleTitle: "Workspace lifecycle"
status: "Baseline"
minutes: 11
tags: ["lifecycle", "greenfield", "create-vivary", "doctor"]
outcomes:
  - "Walk a brand-new folder through the documented greenfield sequence: install, init, generated artifacts, doctor, tropo check, ozone review, graph."
  - "State the non-interactive flag set that reproduces the wizard's storage and memory choices."
  - "Name the preset-structure ambiguity in the docs and explain why to verify it rather than resolve it."
sources:
  - label: "Getting Started — install through workspace creation"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/GETTING-STARTED.md"
    locator: "§§1-2 Install, Create a workspace, L29-140"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "Getting Started — health check through graph"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/GETTING-STARTED.md"
    locator: "§§3-4 Check that it's healthy, See the graph, L141-169"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
  - label: "HOWTO — Agent self-configure a workspace"
    url: "https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md"
    locator: "§ Agent self-configure a workspace, L179-198"
    sourceRef: "dev"
    verifiedAt: "2026-07-21"
interactions:
  - id: "wizard-default"
    kind: "multiple-choice"
    prompt: "You run create-vivary init on a terminal that supports input and pass no wizard flags. What happens next?"
    options:
      - text: "The wizard asks about storage and optional memory."
        correct: true
        feedback: "Correct. The wizard's job is storage and memory, nothing more."
      - text: "The wizard installs Cognee and enables network access."
        feedback: "Cognee install and network access stay explicit gates approved later, never automatic."
      - text: "The doctor command validates the new graph immediately."
        feedback: "Doctor is a separate step you run after init finishes, not part of the wizard."
      - text: "The capabilities command lists every optional sidecar first."
        feedback: "Capabilities is a separate discovery command; init does not run it for you."
    success: "Correct. The wizard's job is storage and memory, nothing more."
    reveal: "Scripted equivalent: the same two answers come from --no-wizard --storage embedded --memory local --yes, or --auto."
  - id: "preset-structure"
    kind: "multiple-choice"
    prompt: "Which statement matches what Getting Started actually says about presets, contradiction included?"
    options:
      - text: "Presets share structure, yet knowledge-work adds a router."
        correct: true
        feedback: "Correct. That sentence-to-sentence gap is the documented ambiguity — state it, don't paper over it."
      - text: "Presets share structure, and every preset ships identically."
        feedback: "The text calls out one preset's extra sources router in the very next sentence — not identical."
      - text: "Presets differ completely, sharing no structure or files."
        feedback: "Getting Started explicitly says the four presets share the same structure."
      - text: "Presets pick which optional layers ship by default."
        feedback: "This section names only the sources-router example, not an optional-layer selection rule."
    success: "Correct. That sentence-to-sentence gap is the documented ambiguity — state it, do not paper over it."
    reveal: "Don't resolve it: verify exact preset composition against generated output or implementation before you teach it as settled."
  - id: "health-next-step"
    kind: "multiple-choice"
    prompt: "create-vivary doctor just reported 0 broken edges. What is the next command in the documented health sequence?"
    options:
      - text: "Run tropo check to validate every note strictly."
        correct: true
        feedback: "Correct. tropo check validates documents; ozone review is the very next step, over relationships."
      - text: "Run ozone review to check graph relationships first."
        feedback: "Ozone review comes after tropo check in the documented sequence, not before it."
      - text: "Run tropo graph to render the visual output."
        feedback: "Viewing the graph is the last step, after both checks pass."
      - text: "Run exo board to list every open item."
        feedback: "Exo board is everyday coordination, not part of the doctor-to-graph health sequence."
    success: "Correct. tropo check validates documents; ozone review is the very next step, over relationships."
    reveal: "Order matters: tropo check catches per-document typing errors before ozone review spends effort on relationships between documents that aren't even valid yet."
---

> Init writes files. It does not earn trust. That takes three more commands and one honest look at the tree init actually generated.

## Why this exists

Most greenfield mistakes aren't dramatic — they're a workspace that looks finished because a scaffolder ran without errors. This lesson stays narrow on purpose: take a brand-new folder through the documented greenfield sequence, and know what each step actually writes, checks, or defers. Adopting an existing repo is a different lesson (0012, next); this one stops once you can prove a fresh workspace is healthy, not just accepted.

## How it works

The whole path compresses to one line: **route → init/preset → wizard or scripted capabilities → generated artifacts → doctor → tropo check → ozone review → graph.** Every arrow is a real command boundary, and skipping one means guessing instead of verifying — `ozone review` checks relationships that `tropo check` never touches, so running only the second still leaves risk invisible.

**Pick a route, then a preset.** Three install doors all need Python 3.11+ underneath: `pip install vivary` installs permanently, `uvx vivary-tropo --version` runs on demand with nothing installed, and `npm create @vivary@latest my-workspace` scaffolds with one npm command (needs uv or pipx too). Then `create-vivary init my-workspace --preset coding` picks starter content from `coding`, `second-brain`, `knowledge-work`, or `writing`.

**Configure storage and memory, by human or by flag.** On a terminal that supports input, `init` runs a short wizard asking about storage size, local-vs-cloud, and optional semantic memory. Passing `--no-wizard --storage embedded --memory local --yes`, or just `--auto`, skips the prompts and lets flags decide instead — same policy, different route. Agents with no human present can discover options (`create-vivary capabilities --preset knowledge-work --json`), preview before writing (`init … --auto --dry-run --json`), and apply fully non-interactively (`init . --preset coding --auto --size large --yes --json`). `--memory local` writes local-only policy and graph nodes; `--memory cognee` writes Cognee policy and verification docs — neither one installs anything, indexes files, or sends data anywhere. Those stay explicit gates you approve afterward.

**Read the tree before you trust it.** A completed `init` should be narratable, not just accepted: `AGENTS.md` is the contract the agent follows each turn, `STATE.md` answers "where are we?", `tropo.toml` holds the graph's rules, and `changes/ decisions/ verification/ gates/` form the starter graph. Two capabilities add files only when asked: `--active-context cocoindex-code` and `--memory local`/`--memory cognee`.

**Verify in a fixed order.** `doctor` confirms the workspace was created correctly, including that private context and heartbeat output are actually Git-ignored. `tropo check` validates every note against typing rules — strict mode fails on warnings too — but it checks documents, not the relationships between them. `ozone review` is the step that checks relationships across the whole graph: unverified changes, broken edges, orphans; advisory by default, a CI gate with `--strict`. Only after both pass does `tropo graph --json` or `tropo view --out graph.html` let you actually see what you built.

## Don't conflate

- **A preset is starter content, not a capability switch.** All four presets share the same structure — except the docs immediately complicate that claim by noting `knowledge-work` also ships a sources router the others don't. That's a real ambiguity in the current documentation. Don't resolve it for your reader; verify the actual generated output before teaching preset composition as settled.
- **Doctor is scaffold health, not graph validity.** It reports node/edge counts, broken links, and Git-ignore status — not whether individual documents are typed correctly.
- **`tropo check` is not `ozone review`.** One validates documents in isolation; the other validates relationships between them. Running only the first still leaves orphaned or contradictory relationships invisible.

## Try it on a real workspace

Scaffold a throwaway workspace with `create-vivary init test-ws --preset coding --auto --dry-run --json` first, read the plan, then drop `--dry-run` and apply it. Pick one generated file — `AGENTS.md`, `STATE.md`, or `tropo.toml` — and write its job in one sentence before you open it. Then run `doctor`, `tropo check`, and `ozone review` in that order and confirm each one reports something the previous step didn't.

## One-minute recall

1. Route you'd pick and why: `pip`, `uvx`, or `npm create`.
2. Name a preset, then state the ambiguity — same structure, or not? Don't resolve it.
3. Wizard or scripted: write the non-interactive flag set from memory.
4. Three generated files or folders, and the one job each holds.
5. The four-command health sequence: doctor → tropo check → ozone review → graph.

## Sources

- [Getting Started — install through workspace creation](https://github.com/vivary-dev/vivary/blob/dev/docs/GETTING-STARTED.md) (§§1-2, L29-140)
- [Getting Started — health check through graph](https://github.com/vivary-dev/vivary/blob/dev/docs/GETTING-STARTED.md) (§§3-4, L141-169)
- [HOWTO — Agent self-configure a workspace](https://github.com/vivary-dev/vivary/blob/dev/docs/HOWTO.md) (§ Agent self-configure a workspace, L179-198)
