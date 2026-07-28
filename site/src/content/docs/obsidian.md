---
title: "Obsidian (optional)"
description: "Optional Obsidian setup for fans, never required."
editUrl: "https://github.com/vivary-dev/vivary/edit/dev/docs/OBSIDIAN.md"
---

**Obsidian is optional and never required.** A Vivary workspace is plain Markdown +
YAML — it works in any editor, or none. This page is for people who *like* Obsidian
and want a nice visual home for the graph. Nothing in Vivary depends on it.

## The editor-free visual graph: `tropo view`

The precise, typed knowledge graph — the real edges, coloured by type — renders to a
single self-contained HTML file, no editor or plugin needed:

```bash
tropo view --root . --out graph.html   # or: uvx vivary-tropo view ...
# open graph.html in any browser
```

That is the canonical Vivary graph visual. Use it anywhere.

## If you love Obsidian

Open the workspace folder as a vault. Two things worth knowing:

1. **Opt-in starter config.** Scaffold with `--obsidian` and create-vivary drops a
   minimal `.obsidian/` (graph nodes pre-coloured by Vivary type: modules, changes,
   decisions, verification, gates). Obsidian's own ephemeral UI state is gitignored.

   ```bash
   create-vivary init my-workspace --preset coding --obsidian
   ```

2. **Edges in Obsidian's graph.** Obsidian's native graph draws `[[wikilinks]]` and
   tags. Vivary's edges live in **typed frontmatter** (`related_modules: [codebase]`)
   so tropo can validate them — Obsidian won't draw those as graph lines out of the
   box. To navigate them in-app, install the community **Dataview** plugin; for the
   true typed-graph picture, use **`tropo view`** (above). Node colouring by type
   works either way.

## The principle

Recommend Obsidian to fans, never require it. The same workspace must work for
someone on plain `vim` + a terminal, in Claude Code, or in Codex: the lightweight
CLIs operate over plain files without a provider or network service, and governed
Tropo composes only the first-party `vivary-core` seam. The visual graph (`tropo
view`) needs nothing but a browser.
