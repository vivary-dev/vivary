---
title: "Read the shape of a repo before you read the repo"
description: "Agents burn their context finding things. tropo map gives an agent the shape of a repo in one read-only command, before it opens a single file."
date: 2026-07-08
author: "Jeff Kazzee"
tags: ["tropo", "context", "guide"]
draft: false---

Drop an agent into an unfamiliar repo and watch what it does first. It lists a
directory. It opens a file. It greps for something. It opens three more files
because the first one referenced them. Twenty tool calls later it has a mental
model of maybe a third of the project, and it spent most of its context budget
building that model instead of doing the task you asked for.

That's the tax nobody prices in. Every "let me look around first" is tokens
that aren't going toward your actual change. The bigger the repo, the worse the
tax, and the worse agents get at paying it, because a large context window
isn't the same thing as a well-organized one.

`tropo map` is a read-only fix for exactly that first move. One command, no
config required, gives you the shape of a tree: how big, what's dense, what
already has a map, and what doesn't.

## What it looks like

```bash
$ tropo map --root . --depth 2
```

```
# tropo map: repo

163 file(s), 65 director(y/ies), depth ≤ 2

## Directories

| Path | Depth | Files | Size | Dominant extensions | Index? |
|---|---|---|---|---|---|
| . | 0 | 163 | 1.6MB | .md (89), .py (14) | yes |
| docs | 1 | 22 | 574.0KB | .md (18), .webp (4) | yes |
| packages/tropo | 2 | 6 | 128.4KB | .py (2), .md (2) | no |

## File extensions (top 10)
...

## Likely modules without an index

Directories at depth 1-2 with >= 5 files (recursive) and no `index.md`/`README.md`:

- packages/tropo
```

That's the whole idea in one screen. Root has an index (`README.md`), `docs/`
has one, and `packages/tropo` doesn't, despite having six files under it. If
you're an agent about to work in `packages/tropo`, that last line just told
you there's no router waiting for you: you're going in cold, so budget more
reads there and consider dropping an `index.md` when you leave.

The counts in the summary sections (totals, extensions, largest files,
missing-index detection) always cover the whole tree, even when `--depth`
limits which rows show up in the directory table. `--depth` trims what you
have to read, not what gets counted.

## No `tropo.toml` required

This is the part I'd get wrong if I were skimming: `map` doesn't need a Vivary
workspace at all. Run it against any repo, any notes vault, any docs tree,
adopted or not. It skips the usual junk (`.git`, `node_modules`,
`__pycache__`, `.venv`, `venv`, `dist`, `build`, `.astro`, `.next`, `target`),
and if it finds a `tropo.toml` by walking up from wherever you pointed it, it
also honors that config's `exclude` patterns. If it doesn't find one, it just
runs anyway. A missing or broken config never blocks the map.

That matters for the adoption story. Before you decide whether a repo should
become a `coding` or `second-brain` preset, before you run `create-vivary
adopt`, you can run `map` against it with nothing installed but the map
command itself. It's the look-before-you-touch step. More on the actual
touching in a follow-up post, Adopt, don't rebuild.

## `--json` is deterministic on purpose

```bash
tropo map --root . --json
```

Every key is sorted, ordering is stable, and the output is meant to be diffed.
That's not a throwaway detail. Say an agent is going to make a decision based
on the map: "there are 40 markdown files under `notes/` with no index, propose
a router." The map needs to be something you can run twice and get the same
answer, and something you can put in a test fixture without it flaking on key
order. Deterministic JSON is what makes `map` usable as a build block for
other tools instead of just a pretty printout for humans.

## Privacy details that are easy to miss

Two things about what actually gets printed, both intentional:

- The `root` field, and the markdown heading, show the mapped directory's
  **basename only.** If you run `tropo map --root
  /Users/jeff/client-work/acme-contract`, the report says `acme-contract`, not
  the absolute path. Every other path in the output is root-relative with
  forward slashes, even on Windows.
- **Excludes are honored at the file level, not just the directory level**,
  and they get rebased when your map root sits below the config root. If a
  `tropo.toml` up the tree says `exclude = ["docs/private"]`, and you run
  `tropo map docs`, that exclude still applies to `private/` even though
  you're mapping from one level down.

Neither of those is exciting until you're about to paste a map's output into a
chat with an agent, or a support ticket, or a README, and you realize it would
have leaked your home directory's username. It doesn't.

## Junction cycles don't lie to you

The other trust detail: directory junctions and symlink cycles are pruned by
real path. A repo with a symlink that loops back on itself, or a Windows
junction pointing somewhere it shouldn't, doesn't inflate your file count or
send `map` into a loop. This sounds like an edge case until you've actually
hit a real one in a monorepo with vendored submodules, at which point it's the
difference between a report you can trust and a report that tells you there
are eleven million files in your project.

## When to reach for it

Anytime an agent (or you) are about to work in a tree you don't already have a
mental model of. Before adoption. Before a big refactor. Before you ask an
agent to "go find where X lives" in a codebase it's never seen, hand it a
`tropo map` first, and it spends its budget on your actual question instead
of on orientation.

See the [command reference](/commands/) for the full flag list, or
[getting started](/getting-started/) if you haven't set up Vivary at all yet.
