# tropo

**A typed-knowledge layer for any folder of Markdown.** The filesystem *is* the
schema: a document's type is the folder it lives in, and its metadata is only
what can't be derived from where it sits and what it says.

`tropo` is the elegant successor to a frontmatter typechecker. Where the old
model made every file pay a ceremony tax — `type:`, `created:`, `updated:`,
`slug:` hand-declared on all of them — tropo derives all of that and asks you to
write down only the irreducible signal. A clean note can have **zero
frontmatter** and still be fully typed and valid.

> Status: **working engine (v0.2).** `tropo.py` implements spec v1 end-to-end —
> folder-as-type resolution, derivation, validation, packs, **overlays**, the
> `signal` report, **`fix`** (de-noise), **`init`**, the graph layer
> (`graph`/`blast`/`view`/`plan`), typed retrieval (`find`/`query`), and the
> data layer (file → embedded migration). Cloud adapters are future 0.3.x work. An
> agent can drive the whole thing via [.claude/skills/tropo/SKILL.md](.claude/skills/tropo/SKILL.md).
> See [SPEC.md](SPEC.md).

## Quickstart

```bash
python tropo.py init my-vault                   # scaffold a tropo.toml (--packs dev-project)
python tropo.py types  --root examples/vault    # the resolved type registry
python tropo.py check  --root examples/vault    # validate — opinionated: warnings fail too (--lenient to relax)
python tropo.py signal --root examples/vault    # print ONLY the irreducible metadata
python tropo.py graph  --root examples/vault    # emit typed nodes + edges
python tropo.py view   --root examples/vault --out examples/vault/graph.html
python tropo.py fix    --dry-run                 # preview redundant-frontmatter removal
python tropo.py find "folder as type decision" --root examples/vault --json  # read-this-first packet
python tropo.py query "meeting notes" --root examples/vault --type meeting --explain
python tropo.py migrate --from file --to embedded --root my-vault --yes  # switch to LanceDB
python tests/test_tropo.py                       # run the test suite
```

Requires Python 3.11+ (stdlib `tomllib`), zero third-party dependencies for the core.
Optional extras: `pip install vivary-tropo[embedded]` for LanceDB full-text search.
Cloud extras are reserved for the 0.3.x adapter work.

Built-in packs are embedded in the single-file engine, so installed wheels can resolve
starter packs without a repo-local `packs/` directory. Workspace-local
`.tropo/packs/<name>.toml` files still take precedence.

TOML config and frontmatter parsing tolerate a single leading UTF-8 BOM, which keeps
Windows-created files from failing to load or being misread as body-only documents.
`tropo view --out` keeps generated HTML under the tropo root, rejects symlink targets,
and replaces output files without mutating hard-linked files outside the workspace.

`tropo find` is the friendly context-compression command: it returns a short packet of
typed nodes/files to open first, with reasons, snippets, and an approximate token
budget. `tropo query` is the lower-level filtered search primitive; it can filter by
type, path glob, or outbound edge and explain whether a match came from id/title,
frontmatter, path, body, or edge context. Both commands stay zero-dependency and read
the typed graph directly.

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

For multi-agent coordination, add the opt-in `coordination` pack:

```toml
packs = ["repo-graph", "coordination"]
```

It declares top-level `assignee = "string"` without changing the default workspace
schema. `exo claim <id> --agent <handle>` uses that field for graph-native work
ownership.

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

---

Website & docs: <https://vivary.vercel.app/>
