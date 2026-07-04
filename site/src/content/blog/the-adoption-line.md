---
title: "The adoption line: Vivary now works on your mess"
description: "Vivary only ever worked on an empty folder. That was a demo, not a tool. This release adds tropo map, create-vivary adopt, and doctor --trend so it works on the repo you already have."
date: 2026-07-06
author: "Jeff Kazzee"
tags: ["release", "adoption", "adopt"]
draft: true
---

For the first few months, Vivary only worked if you started from nothing.

`create-vivary init` scaffolds a beautiful, complete workspace: `AGENTS.md`,
`STATE.md`, a typed graph, skills, gates, all of it. But it assumes an empty
directory. Point it at a two-year-old codebase with four hundred files and a
`docs/` folder nobody's updated since March, and it has nothing to say. You'd
have to start a fresh folder next to your real project and slowly migrate
content over by hand, which is exactly the kind of tedious manual work Vivary
is supposed to save you from.

That's a demo, not a tool. Almost everyone who wants typed memory and gates for
an agent project already has a project. They have a repo, or a vault, or a pile
of client notes. They don't have a Tuesday free to rebuild it inside a new
scaffold.

I built Vivary to use myself, in every project I run: this codebase, my
writing, my notes. Nearly all of that was brownfield already. The adoption
line exists because I hit this gap on my own work first.

This release is about closing that gap. `vivary-tropo` moves to 0.4.1,
`create-vivary` and `@vivary/create` move to 0.3.1, and the theme of the whole
line is: Vivary should work on the mess you already have, not just the mess
you're about to make.

## Three pieces, one theme

**`tropo map`** is read-only reconnaissance. Before you touch anything, you can
ask Vivary to describe the shape of a repo: how many files, what's dense, what
already has an index, what's a de facto module with no router pointing at it.
No `tropo.toml` required, nothing written to disk. I'll write a whole post on
why this matters for agent context later this week, but the short version is
that an agent's first move in an unfamiliar codebase shouldn't be "read
everything and hope."

**`create-vivary adopt`** is the actual migration path. Point it at your
existing repo and it plans a set of additions: an `AGENTS.md`, a `STATE.md`, a
`tropo.toml` with excludes wide enough to not choke on your existing content,
and thin `modules/<name>/index.md` routers for markdown-heavy directories that
don't have one. It never touches a file that's already there. Dry-run is the
default; you have to pass `--yes` to write anything. I'll go deep on how that
invariant is verified in a follow-up post later this week.

**`doctor --trend`** is what happens after adoption, once the workspace is
live and evolving. It's opt-in drift tracking: it snapshots the workspace's
graph health and routing surface, and on the next run tells you what changed
since last time, as signed deltas. It's the thing that notices your module
count crept up without new indexes to match, which is how memory quietly rots.

Three commands, one shape: look before you touch, touch only by adding, then
watch for decay after you're live.

## Try it on your own repo

If you've got a project already set up with Claude Code, Codex, or another
coding agent, the fastest path is to hand it the setup prompt and let the
agent drive, with you approving each write:

```text
Set up Vivary (https://vivary.vercel.app) in this project.

1. Read https://vivary.vercel.app/getting-started/ and https://vivary.vercel.app/commands/ before running anything.
2. You need Python 3.11+ and uv (or pipx). Tell me if something is missing before installing it.
3. If this folder already has content, this is an adoption: run `uvx create-vivary adopt .`, show me the dry-run plan, and apply with `--yes` only after I approve. Adopt only adds files; it never touches existing ones.
   If this folder is new or empty, it is a fresh workspace: ask me which preset fits (coding / second brain / knowledge work / writing), then run `uvx create-vivary init . --preset <choice>`.
4. Verify with `uvx create-vivary doctor .` and `uvx --from vivary-tropo tropo check --root .`. Both must pass; show me the results.
5. Read the generated AGENTS.md, then follow it for all future work here.
```

That prompt does the greenfield/brownfield decision for you: it checks whether
the folder already has content and picks `adopt` or `init` accordingly. Either
way, nothing gets written without you seeing the plan first.

Prefer to drive it yourself:

```bash
# Look at the shape first, no writes
uvx --from vivary-tropo tropo map --root . --depth 2

# See what adopt would do
uvx create-vivary adopt . --json

# Apply it
uvx create-vivary adopt . --yes

# Verify
uvx create-vivary doctor .
uvx --from vivary-tropo tropo check --root .
```

Or install the CLIs directly:

```bash
pip install vivary
create-vivary adopt . --json
```

Or scaffold fresh with npm, if you're starting from nothing:

```bash
npm create @vivary@latest my-workspace
```

One version note, because I get this wrong in conversation more than I'd like:
there is no single "Vivary 0.4.1." The packages version independently.
`vivary-tropo` is 0.4.1. `create-vivary` and `@vivary/create` are 0.3.1.
`ozone` and `exo` didn't change in this line. Check the [command
reference](/commands/) for the exact flags on all four, and
[getting started](/getting-started/) if this is your first time touching any
of it.
