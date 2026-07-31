---
title: "Vivary for coding: give your agent the repo's memory"
description: "The coding preset's surfaces, blast radius before risky changes, the CI gate recipe, and adopting a workspace in place on a repo you already have."
date: 2026-07-24
author: "Jeff Kazzee"
tags: ["coding", "howto", "gates"]
draft: false---

If you've used an agent on a real codebase for more than a few sessions, you've
hit this: it re-reads the same files every time because nothing tells it what
it already knows. It re-derives an architectural decision you already made,
sometimes differently than last time. It touches a module without knowing
three other things depend on it. None of that is a model-quality problem. It's
a missing-memory problem, specific to code.

The `coding` preset is Vivary's answer for that specific shape of project.
Here's what it actually gives you and how the pieces fit together.

## The surfaces

Scaffold one and you get:

```bash
create-vivary init my-codebase --preset coding
```

- **`AGENTS.md`**: the contract. The loop the agent follows every turn
  (ask, retrieve, act, verify, learn, gate) and where the human gates sit.
- **`STATE.md`**: the one place that answers "where are we," so an agent
  starting a session doesn't have to reconstruct status from commit history
  and guesswork.
- **`modules/<name>/index.md`**: a directory router per module. The starter
  `codebase` module is one example; as the project grows, each real module
  gets its own thin index instead of one file trying to describe everything.
- **`changes/`**: typed records of in-flight or completed work, each one
  optionally carrying a `verification` edge (what proved it worked) and a
  `related_decisions` edge (why it was done this way).
- **`decisions/`**: the architectural calls, with a `status` (proposed,
  accepted, deferred, or superseded) and a date, so "why did we do it this
  way" resolves to a real document instead of a Slack thread nobody can find
  six months later.
- **`verification/`**: what actually proves a change is correct. The test
  run, the manual check, the specific command and its result.
- **`gates/`**: the human sign-off points. Merge, publish, destructive ops,
  written down as real graph nodes instead of tribal knowledge about "ask
  before you touch prod."

None of this replaces your actual code or your test suite. It sits alongside
the repo as typed memory about the repo: what it is, what changed, why, and
what proved it.

## Blast radius before risky changes

The single most useful command for a coding workspace, and the one that
does something a text diff structurally cannot:

```bash
tropo blast payments-module --depth 2
```

`tropo blast <id>` returns everything that transitively references the node
you're about to change, not just direct references, but references to
references, out to the depth you ask for. Before you touch a module that
three other modules and two open changes depend on, you know that before you
start, not after something breaks in a part of the codebase you weren't
thinking about.

`ozone impact <id>` is the related but distinct command. It's the blast
radius computed from ozone's read of the graph, annotated with distance and
the specific edge field each dependent came in by, which is useful when you
want to know not just *what* depends on something but *how*. I go deep on
both, with a walked example, in a follow-up post dedicated to blast radius.

Either way, the workflow is: before a change that touches something with
dependents, name the blast radius, look at what's in it, then decide whether
you're comfortable proceeding. That's a five-second command replacing what
used to be "grep for usages and hope you found them all."

## The CI gate recipe

Once a coding workspace has some history, wire the checks into CI instead of
running them by hand:

```bash
tropo check --root .              # strict: any warning fails
ozone review --root . --strict    # gate: exit 1 on any structural warning
```

`tropo check` validates every note and the graph: untyped files, broken
edges, redundant frontmatter, all fail by default. `ozone review` looks at
relationships across the whole graph: a `changes/` node with no
`verification` edge, an orphaned node with no connections at all, a module
with no index. It's advisory by default (exit 0) so it doesn't block on
info-level findings unless you ask it to; pass `--strict` to make it a hard
gate.

Exit codes are uniform across every Vivary CLI: `0` success, `1`
findings/errors, `2` usage error. Gating on the exit code in a workflow file
is the same pattern regardless of which command you're running. Every
command also takes `--json` if you want to parse specifics instead of just
gating on pass/fail.

## Adopting a workspace on a repo you already have

Almost nobody starts a coding project from an empty folder anymore. `adopt`
is built for that:

```bash
create-vivary adopt . --json      # dry-run: see the plan
create-vivary adopt . --yes       # apply it
```

It auto-detects `coding` as the preset for a code-file-majority repo, adds
`AGENTS.md`, `STATE.md`, and the rest of the shell only where those files
don't already exist, and widens `tropo.toml`'s excludes to cover your
existing content so adoption doesn't immediately fail its own `tropo check`.
If a directory name collides with a module the preset wants to own, say a
`codebase/` folder you already had, it skips creating a router there rather
than guessing. The full mechanics, including what "only adds" had to survive
under adversarial testing, are in [adopt, don't rebuild](/blog/adopt-dont-rebuild/).
Before you even run adopt, `tropo map --root . --depth 2` gives you a
read-only look at the repo's shape with nothing installed but the map command
itself. See [tropo map](/blog/tropo-map-read-the-shape/).

## What actually changes

The point isn't ceremony. It's that an agent working in this repo next
session doesn't start from zero. It reads `STATE.md` and knows where things
stand. It reads a module's `index.md` instead of the whole tree. Before a
risky change, it runs `tropo blast` and knows what else it could break. When
it's done, it writes a `changes/` entry with a real verification edge instead
of a commit message that says "should be fine." Multiply that across every
session on a long-lived project and the difference isn't subtle. It's the
gap between an agent that re-reads your repo every time and one that actually
remembers it.

[Getting started](/getting-started/) walks through the first setup; the
[command reference](/commands/) has the complete flag list for `tropo`,
`ozone`, and `create-vivary adopt`. If this is one of several projects you
run this way, that repetition across projects is worth its own post, coming
up next in this batch.
