---
title: "Memory that doesn't rot"
description: "A flat notes.md degrades silently and nothing tells you. A typed graph fails loudly, and doctor --trend tells you when it's drifting even before it fails."
date: 2026-07-13
author: "Jeff Kazzee"
tags: ["tropo", "memory", "deep-dive"]
draft: true
---

Every agent project I've worked on eventually grows a `notes.md` or a
`STATE.md` or a `context.md`, some flat file where decisions and status live.
For the first two weeks it's great. Then it starts lying to you, and the worst
part is nothing tells you when that happens.

I want to walk through exactly how that rot happens, and then show the
mechanism Vivary uses instead, because "typed graph" is an abstract phrase
until you've seen the failure mode it's solving.

## How a flat note rots

Here's a realistic `STATE.md`, six weeks into a project:

```markdown
# State

Working on the billing refactor. Stripe webhook handling is done.
Need to update the retry logic next. Auth module still uses the old
session format, don't touch until Q3 migration.

Decision: use Postgres for the events table (see notes from the
meeting on the 12th, ask Sarah if you can't find them).
```

Every sentence in that file is a landmine, six weeks later:

- "Stripe webhook handling is done." Done as of when? Is it still done? A
  file has no way to say "this fact expires."
- "Need to update the retry logic next." Did someone do that already and
  forget to update this line? There's no way to know without asking a human.
- "See notes from the meeting on the 12th, ask Sarah." That's not a
  reference, that's a broken link with extra steps. Sarah left the company in
  April.
- "Don't touch until Q3 migration." Is it Q3 yet? Did the migration happen?
  The file doesn't say, and nobody's job is to keep it current.

Nothing about this file is malformed. It reads fine. An agent (or a human)
picks it up, believes it, and acts on stale information, because flat text has
no mechanism to tell you which parts of it are still true. It can only be
re-read and trusted, or re-read and second-guessed, and there's no way to tell
which posture is correct from the file alone.

## The same information, typed

Here's the same content as Vivary's typed graph would hold it: not more
prose, structured facts with a validator behind them.

`changes/billing-refactor.md`:
```yaml
---
project: acme-billing
status: active
slice: stripe webhook and retry handling
related_modules: [billing]
related_changes: [use-postgres-events]
verification: [retry-logic-tests]
---
Stripe webhook handling shipped. Retry logic is next.
```

`decisions/use-postgres-events.md`:
```yaml
---
project: acme-billing
status: accepted
date: 2026-06-12
related_modules: [billing]
rationale: query patterns need joins against the orders table; a document
  store would force denormalization
---
Events table uses Postgres.
```

`modules/auth/index.md`:
```yaml
---
project: acme-billing
status: blocked
module_area: authentication
related_changes: [use-postgres-events]
---
Frozen until the Q3 session-format migration lands. Do not touch.
```

The difference isn't verbosity, it's that every fact above is now a typed
field a machine can check. "Is the billing change verified?" is
`related edge -> verification`, not a sentence you have to trust. "Is auth
still blocked?" is a `status` field a validator can check against the live
graph, not a qualitative "don't touch" that nobody remembers to update.
"Where's the Postgres decision from?" is a graph edge, `related_changes:
[use-postgres-events]`, that either resolves to a real document or doesn't.

## Where rot gets caught, not just avoided

Run `tropo signal` on either doc and it prints only the *irreducible*
metadata: the fields that couldn't be derived from where the file lives and
what it says. Everything else is noise stripped away. That alone is a rot
check: if a field shows up in `signal` that's identical to what the folder
structure or content already implies, `tropo check` flags it as `W210`
(redundant frontmatter) and `tropo fix` removes it. Flat notes have no
equivalent instinct; nothing in a `.md` file objects to redundant, stale, or
contradictory statements, because nothing is checking.

The typed graph does object, and loudly, via two failure modes flat notes
can't produce:

- **`W201`, untyped document.** A file sitting outside any registered type
  folder gets flagged. In a flat-notes world, a stray `random-thoughts.md`
  just exists forever, ignored or half-trusted. In tropo, it's visible as
  "this isn't graph-typed," which is either a bug to fix or a deliberate
  exclusion you name.
- **`W220`, broken edge.** A `ref` field pointing at a document id that
  doesn't exist. That's the machine-checkable version of "ask Sarah, she
  left in April." The reference either resolves or it fails `tropo check`,
  full stop. Under Vivary's default strict mode, every warning fails the
  check, so a broken reference doesn't quietly sit in the graph waiting to
  mislead someone.

That's the leverage of folder-as-type plus frontmatter-as-signal: the type
is inferred from where a file lives (`decisions/0001.md` is a `decision`,
no metadata needed to say so), and the frontmatter only has to carry what
can't be derived. Less to write, and everything that is written is
something `tropo check` can actually validate.

## `doctor --trend`: catching rot before it's a failure

`W201`/`W220` catch rot that's already broken something. `doctor --trend`
catches rot that hasn't broken anything yet, which is the more dangerous kind
because nothing is failing loudly to get your attention.

```bash
create-vivary doctor . --trend
```

The first run has nothing to compare against, so it just records a baseline
in `.vivary/doctor-state.json` and says so. Every run after that reports
**signed deltas** against the prior run: graph health, module-index count, and
file count under `modules/`, framed as a short "trend vs `<date>`" section (or
a `trend` object with `prior`/`current`/`deltas` in `--json`).

That's the thing a flat `notes.md` structurally cannot give you: a same-shape
comparison over time. "You added 14 files under `modules/` since the 12th, but
0 new module indexes" is a sentence only possible because there's something
countable and typed to compare against its own past. A corrupt or unreadable
state file doesn't crash the run either. It degrades to "first recorded run"
with a visible `trend_warning`, and gets overwritten with a fresh baseline, so
a bad write doesn't wedge your CI gate.

This is also exactly the shape of check you'd wire into CI once a workspace
matures: run `doctor --trend` on a schedule, commit or cache
`.vivary/doctor-state.json`, and let drift show up as a diff in a PR instead
of as a surprise three months later when someone asks "wait, when did we stop
maintaining module indexes?"

## The actual claim

Typed memory doesn't mean more ceremony than a flat file. The examples above
are roughly the same amount of text. The difference is that every fact in the
typed version is sitting in a field a validator can check, instead of a
sentence a human has to remember to keep honest. Rot doesn't stop happening;
people will always let things go stale. But it stops happening silently.

If you haven't set any of this up yet, [getting started](/getting-started/)
walks through scaffolding the graph, and the [command reference](/commands/)
has the full `tropo check` / `signal` / `doctor --trend` flag list. For the
shape-before-you-touch step that usually comes first on an existing project,
see [tropo map](/blog/tropo-map-read-the-shape/).
