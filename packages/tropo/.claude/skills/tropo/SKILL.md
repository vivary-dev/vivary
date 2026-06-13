---
name: tropo
description: >-
  Manage a Markdown knowledge base or any repo's docs with tropo — a folder-as-type
  typed-knowledge layer where the filesystem IS the schema. Use when the user wants
  to validate/enforce document metadata, set up a typed vault or docs/ tree, see what
  a vault actually asserts, strip redundant frontmatter, add a document type or an
  overlay rule, or scaffold a tropo config. Triggers: "check the vault", "enforce a
  schema on my notes", "what types of docs do I have", "set up tropo here", "de-noise
  my frontmatter", "add a type", "lint my Markdown metadata", "tropo".
---

# tropo

`tropo` makes the **filesystem the schema**: a document's *type* is the folder it
lives in, and its metadata is only what cannot be derived from where it sits and
what it says. A clean note can have **zero frontmatter** and still be fully typed.
This skill teaches you to operate the CLI on the user's behalf. Read `SPEC.md` in
the tropo repo for the normative model.

## Prerequisites

- Python 3.11+ (`python`/`python3` on PATH) — uses stdlib `tomllib`, no installs.
- A `tropo.toml` at the tree root (or run `tropo init` to create one). Config is
  TOML; document frontmatter is YAML.
- Invoke as `tropo ...` if installed (`pip install .`), else `python tropo.py ...`.
  Detect by checking for `tropo.py` in the repo vs. `tropo` on PATH.

## The mental model

- **Folder-as-type.** Type = the nearest ancestor directory registered as a
  type's `folder`. `people/jeff.md` → `person`. No `type:` field, ever. Moving a
  file between type roots retypes it; nesting resolves to the nearest match.
- **Derive, don't declare.** `id`/`slug` from filename, `title` from the first
  `# H1`, `created`/`updated` from git (fs fallback). These never belong in
  frontmatter. An *index document* (`README.md`/`index.md`, or a file named after
  its folder) takes its id from the folder.
- **Signal-only frontmatter.** What remains is the irreducible per-type fields.
- **Packs** compose reusable type bundles; **overlays** (nested `tropo.toml`)
  tighten a subtree. Both may only *add* constraints — never remove (the
  tighten-only law).

## Commands

```bash
tropo                       # check the tree at the nearest tropo.toml (cwd)
tropo check PATH...         # check specific files/folders
tropo signal                # print ONLY the irreducible declared metadata, per doc
tropo types                 # the resolved, pack-composed type registry
tropo stats                 # document counts per type + health
tropo fix                   # strip frontmatter that merely repeats a derived value
tropo fix --dry-run         # preview what fix would remove
tropo init [DIR]            # scaffold a tropo.toml (optionally --packs a,b)
```

Flags: `--strict` (warnings→errors), `--json`, `--quiet`, `--root PATH`,
`--config PATH`. Exit codes: `0` clean · `1` errors · `2` config/usage problem —
gate CI on the exit code, don't parse text.

## Finding codes

| Code | Level   | Meaning |
|------|---------|---------|
| E001 | error   | frontmatter present but not valid YAML |
| E101 | error   | required field missing |
| E102 | error   | required field present but empty |
| E103 | error   | field value violates its type spec |
| E120 | error   | a pack/overlay tried to loosen an inherited rule (config aborts) |
| W201 | warning | untyped document (no ancestor type root) |
| W202 | warning | unknown field for this type |
| W210 | warning | declared field equals its derived value — pure noise (`fix` removes it) |
| W220 | warning | broken `ref` — target id not found in the tree |

> A file with **no frontmatter at all is valid** if its type has no required
> declared fields. That is the common, intended case — do not "fix" it by adding
> frontmatter.

## Recommended workflow

1. **Survey.** `tropo stats` for the type distribution and health; `tropo types`
   to see the active rules. `untyped` files sit outside every type root.
2. **See the truth.** `tropo signal` shows what the vault actually asserts, with
   all derived noise stripped — the fastest way to understand a tree.
3. **Check.** `tropo check --json` and group findings by `code`.
4. **Decide: fix files or fix rules.**
   - Flood of `W210` → run `tropo fix` to de-noise (safe, see below).
   - Flood of `W201` → either move files under a type root, or add a type.
   - Flood of `W202` → the schema is behind reality; add the field to the type.
   - `E101`/`E103` → genuine gaps in irreducible metadata; fill them *with the
     user* — never invent semantic values.
5. **Re-run until clean.** For CI, gate on exit code, optionally `--strict`.

## What `tropo fix` does — and never does

Does: removes frontmatter keys whose value exactly equals the derived value
(`W210`), and deletes a frontmatter block that becomes empty. That is the only
mechanical edit — it *removes noise*, it does not add anything.

Never: invents semantic field values, touches malformed YAML (`E001`), or edits a
value it didn't derive. After `fix`, remaining `E101`s are real and need a human.

**Run `fix` on a clean (committed) working tree** so the user can review the diff,
and prefer `--dry-run` first.

## Adding a type (the common request)

Edit `tropo.toml`. The table key is the type; `folder` is the directory basename
that roots it:

```toml
[types.meeting]
folder   = "meetings"
required = { attendees = "string-list" }
optional = { date = "date", project = "ref" }
```

Field specs: `string`, `date`, `datetime`, `slug`, `url`, `bool`, `number`,
`list`, `string-list`, `ref`, `ref-list`, `any`, `enum:a|b|c`. After editing, run
`tropo types` to confirm it parsed, then `tropo check`.

## Adding an overlay (tighten a subtree)

Drop a `tropo.toml` in a subdirectory that **only adds constraints** for that
subtree — a new required field, a narrowed enum, a nested type. It may not relax
an inherited rule (that aborts with `E120`). Use this to enforce stricter rules on
one project, area, or folder without touching the root config.

## Composing packs

`packs = ["dev-project"]` at the top of `tropo.toml` pulls in a bundled type
bundle (e.g. `decision`/`runbook`/`spec`). Local types and overlays merge on top,
tighten-only. `tropo init --packs dev-project` scaffolds this.

## Guardrails

- **Schema vs. file edits are different decisions.** Prefer editing the schema
  when files reflect a real convention; prefer editing files when they're truly
  malformed. When unsure, ask.
- **Don't fabricate field values.** Derived fields are computed; semantic fields
  are the user's to supply.
- **Large trees:** scope with `tropo check subfolder/` while iterating; run the
  whole tree only to confirm.
