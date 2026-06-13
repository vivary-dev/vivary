# tropo

**A typed-knowledge layer for any folder of Markdown.** The filesystem *is* the
schema: a document's type is the folder it lives in, and its metadata is only
what can't be derived from where it sits and what it says.

`tropo` is the elegant successor to a frontmatter typechecker. Where the old
model made every file pay a ceremony tax — `type:`, `created:`, `updated:`,
`slug:` hand-declared on all of them — tropo derives all of that and asks you to
write down only the irreducible signal. A clean note can have **zero
frontmatter** and still be fully typed and valid.

> Status: **working engine (v0.1).** `tropo.py` implements spec v1 end-to-end —
> folder-as-type resolution, derivation, validation, packs, **overlays**, the
> `signal` report, **`fix`** (de-noise), **`init`**, and the graph layer
> (`graph`/`blast`/`view`/`plan`). An agent can drive the whole thing via
> [.claude/skills/tropo/SKILL.md](.claude/skills/tropo/SKILL.md).
> See [SPEC.md](SPEC.md).

## Quickstart

```bash
python tropo.py init my-vault                   # scaffold a tropo.toml (--packs dev-project)
python tropo.py types  --root examples/vault    # the resolved type registry
python tropo.py check  --root examples/vault    # validate (exit 0 clean / 1 errors)
python tropo.py signal --root examples/vault    # print ONLY the irreducible metadata
python tropo.py graph  --root examples/vault    # emit typed nodes + edges
python tropo.py view   --root examples/vault --out graph.html
python tropo.py fix    --dry-run                 # preview redundant-frontmatter removal
python tests/test_tropo.py                       # run the test suite
```

Requires Python 3.11+ (stdlib `tomllib`), zero third-party dependencies.

## Overlays — tighten a subtree

Drop a `tropo.toml` in any subdirectory to add stricter rules for that subtree
only (a new required field, a narrowed enum, a nested type). It may only *add*
constraints, never remove them — so you can always reason about a document
top-down. See [examples/vault/projects/tropo/tropo.toml](examples/vault/projects/tropo/tropo.toml),
which requires every decision under that project to record its `deciders`.

## The one idea

```
people/jeff.md          →  type = person   (the folder says so)
projects/tropo/README.md →  type = project  (nearest registered ancestor)
meetings/2026-06-12.md  →  type = meeting
```

No `type:` field. No hand-written dates. The *path* carries the type; **git and
the filesystem carry the dates**; the **first `# H1`** carries the title. What's
left in frontmatter is the handful of fields that are genuinely irreducible —
a person's `relationship`, a meeting's `attendees`, a decision's `status`.

**Frontmatter is the exception, not the rule.**

## Before / after

A person note, the old way:

```markdown
---
type: person
created: 2026-06-12
updated: 2026-06-12
slug: jeff
title: Jeff
relationship: self
---
# Jeff
```

The tropo way — same information, no noise:

```markdown
---
relationship: self
---
# Jeff
```

`type` comes from `people/`. `created`/`updated` come from git. `slug` comes from
the filename. `title` comes from the H1. Only `relationship` is irreducible, so
only `relationship` is written down.

## Why it's not just a second-brain tool

The config resolves by **walking up the tree** — like `git`, `tsconfig`, or
`pyproject.toml`. Drop one `tropo.toml` at a repo root and *that repo* gains a
typed-knowledge layer: `decisions/`, `runbooks/`, `specs/`, `adr/` become
enforceable document types with derived metadata and CI-checkable rules. Same
engine, same grammar, whether it's a personal vault or a codebase's `docs/`.

tropo is a **portable convention plus a tiny engine**, not anyone's particular
vault. Types ship as composable [packs](SPEC.md#packs); a subfolder can
[overlay](SPEC.md#overlays) tighter rules without redefining anything.

## Graphify-friendly repo maps

Use the `repo-graph` pack when a repository or control vault wants Markdown
notes that double as Graphify-readable nodes:

```toml
packs = ["repo-graph"]
```

It defines folder-backed types for `modules/`, `changes/`, `decisions/`,
`verification/`, and `gates/`, while allowing explicit graph fields such as
`id`, `related_modules`, `related_changes`, and `verification`. This is a
deliberate bridge: Tropo validates the node shape, Markdown/wiki links remain
human-readable, and Graphify can index the relationships.

## Design tenets

- **Signal over noise.** If a value can be derived, never make a human write it.
- **Location is type.** The directory tree is the type hierarchy.
- **Tighten, never loosen.** Overlays and packs may add constraints, not remove
  them.
- **Zero-dependency, CI-clean.** The engine stays a single file with an honest
  exit code, the one virtue worth keeping from its predecessor.

## Layout

```
tropo/
├─ README.md            you are here
├─ SPEC.md              the normative model + config format reference
├─ tropo.toml            the project's own (dogfooded) config
└─ examples/
    └─ vault/           a tiny tree showing zero-frontmatter notes
```

## License

MIT — see [LICENSE](LICENSE).
