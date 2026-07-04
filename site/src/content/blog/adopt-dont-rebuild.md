---
title: "Adopt, don't rebuild"
description: "create-vivary adopt brings Vivary to a repo you already have. Dry-run by default, an explicit write gate, and an invariant we tried hard to break before shipping it: it only ever adds files."
date: 2026-07-10
author: "Jeff Kazzee"
tags: ["adopt", "release", "trust"]
draft: true
---

The single scariest thing a scaffolding tool can do is touch a file you
already had. Not create a new one, not fail loudly, touch one of yours and get
it wrong. That's the failure mode that makes people afraid to run a tool
against a real project instead of a throwaway folder.

`create-vivary adopt` exists to bring Vivary to a repo, vault, or notes folder
you already have, without becoming that failure mode. The product promise is
one sentence: **adopt only adds files.** It never moves, renames, edits, or
overwrites anything that was already there. If a file it would have created
already exists (`README.md`, `AGENTS.md`, `CLAUDE.md`, anything), it's
skipped and reported "exists, kept."

A promise like that is worth exactly as much as the testing behind it, so
here's what actually backs it up.

## Dry-run first, write only on request

```bash
create-vivary adopt . --json      # analyze only, writes nothing
create-vivary adopt . --yes       # apply the plan
```

Unlike `create-vivary init`, which writes immediately, `adopt` defaults to
dry-run. You get a full plan: what would be created, what already exists and
gets kept, follow-ups (like privacy lines missing from an existing
`.gitignore`), candidate modules it found, and any collisions it's skipping.
Nothing touches disk until you pass `--yes`. That's the write gate, and it's
not a suggestion, it's the only way any file gets written.

## What "only adds" actually covers

Three cases had to hold, not just the easy one:

**Existing top-level files.** Point `adopt` at a repo that already has a
`README.md`. It doesn't append to it, doesn't rewrite it to match Vivary's
template, doesn't touch it at all. It shows up in the plan as "exists, kept."

**Pre-existing content inside Vivary's own graph folders.** This is the
sneaky one. Say your repo already has a `decisions/` folder with your own
markdown files in it, written before you'd ever heard of Vivary, and `adopt`
wants to treat `decisions/` as a typed graph folder. Those pre-existing files
get excluded from the typed graph by exact path in `tropo.toml`, reported
under `excluded_pre_existing`, so `tropo check` doesn't flag your old notes as
malformed typed documents. They stay exactly as they were; they're just not
graph-typed until you deliberately add frontmatter and remove the exclude
later.

**Module collisions.** Say a brownfield directory's name collides with a
module the chosen preset already owns: you have a `codebase/` folder, and the
`coding` preset wants to create its own `codebase` module. `adopt` doesn't
create a router for the existing one and doesn't let the preset's starter
module get silently overwritten either. It reports the collision under
`skipped_module_collisions` and moves on.

## How we tried to break it

An "only adds" claim is easy to state and easy to get subtly wrong, so the
adversarial pass for this release specifically went after it: hostile
fixtures designed to catch exactly the kind of bug that a promise like this
tends to hide. Read-only files in the target tree. Files at paths that would
collide with generated ones. Before/after byte comparisons on anything adopt
was supposed to leave alone, not just "did it run without crashing."

That review found real gaps, and they got fixed before merge, not after. That
part matters more to me than the clean version of the story would: the point
of an adversarial pass isn't to confirm everything's fine, it's to find the
places it isn't, while there's still time to fix them. If I only told you "we
tested it and it's great," you'd have no way to tell that from marketing. The
honest version is: we went looking for the ways this breaks, found some, and
closed them before anyone outside the review saw the code.

Same hardening also handles the obvious hostile inputs: symlinked targets and
paths that resolve outside the workspace root both get refused, the same
protection `init --force` already had.

The result, per this release's verification: `create-vivary` full suite green
post-merge, `init` byte-parity against 0.2.8 verified across five flag
configurations, and only-adds/dry-run purity verified against those hostile
fixtures. `vivary-tropo` sits at 83 of 83 tests passing on Python 3.11 and
3.14. None of that is a guarantee nothing will ever surprise us. It's the
difference between "should work" and "we tried to break it and here's what we
found."

## What adopt actually writes

When you do run `--yes`, here's the shape of what lands:

- `AGENTS.md`, `STATE.md`, and the rest of the agent-OS shell, only for pieces
  that don't already exist.
- A `tropo.toml` with an `exclude` list widened to cover your pre-existing
  brownfield content, so adoption doesn't immediately fail its own `tropo
  check`.
- Thin `modules/<name>/index.md` routers for markdown-heavy directories (5+
  files, no existing `index.md`/`README.md`) it finds during analysis. The
  directory itself is never touched, just a router pointing at it.
- A `.gitignore` follow-up if one already exists: `adopt` leaves it alone and
  lists the privacy lines it's missing instead of editing it for you.

An adopted workspace passes `create-vivary doctor` and `tropo check` the same
way a freshly-scaffolded one does, with one honest exception: if your repo
already had a `.gitignore` missing Vivary's privacy lines, `adopt` won't edit
a file you own, so it reports the exact lines you need as a follow-up instead.
Add them and `doctor` passes clean. That was the deliberate bar: adoption
isn't a lesser path, but it also won't silently rewrite your files to hit a
green check.

## Greenfield or brownfield: the decision is simple

If the folder is empty or new, you want `init`. If it already has content, you
want `adopt`. `create-vivary` can even make that call for you: point the
[setup prompt](/getting-started/) at an agent and it checks the folder first.
Doing it by hand is one look at whether `ls` returns anything:

```bash
# Empty or new folder
create-vivary init my-workspace --preset coding

# Already has content
create-vivary adopt . --json    # see the plan
create-vivary adopt . --yes     # apply it
```

`adopt` also auto-detects a preset if you don't pass one (`coding` for a
code-file majority, `second-brain` for a markdown-file majority), and tells
you which one it picked and why, in both the human and `--json` output.

Want to see what `adopt` is looking at before it plans anything? That's
[tropo map](/blog/tropo-map-read-the-shape/), the read-only step that comes
before this one. Full flag reference is in [commands](/commands/#adopt--point-vivary-at-your-mess).
