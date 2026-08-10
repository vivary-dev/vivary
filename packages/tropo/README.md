# tropo

**A typed-knowledge layer for any folder of Markdown.** The filesystem *is* the
schema: a document's type is the folder it lives in, and its metadata is only
what can't be derived from where it sits and what it says.

`tropo` is the elegant successor to a frontmatter typechecker. Where the old
model made every file pay a ceremony tax — `type:`, `created:`, `updated:`,
`slug:` hand-declared on all of them — tropo derives all of that and asks you to
write down only the irreducible signal. A clean note can have **zero
frontmatter** and still be fully typed and valid.

> Status: **working engine (v0.5.1).** `tropo.py` implements spec v1 end-to-end —
> folder-as-type resolution, derivation, validation, packs, **overlays**, the
> `signal` report, **`fix`** (de-noise), **`init`**, the graph layer
> (`graph`/`blast`/`view`/`plan`), typed retrieval (`find`/`query`), read-only
> filesystem inventory (**`map`**), and the data layer (file → embedded
> migration). Cloud adapters are future work. An agent can drive the whole thing
> via [.claude/skills/tropo/SKILL.md](.claude/skills/tropo/SKILL.md).
> See [SPEC.md](SPEC.md).

## Quickstart

```bash
python tropo.py init my-vault                   # scaffold a tropo.toml (--packs dev-project)
python tropo.py check --root examples/vault     # validate the included example vault
python tropo.py find "folder as type decision" --root examples/vault --json
python tropo.py map --root examples/vault        # read-only filesystem inventory

# Unreleased source-only governed path; core is in the adjacent checkout package.
(
demo="$(python3 -c 'import tempfile; print(tempfile.mkdtemp(prefix="tropo-governed-"))')" &&
trap 'rm -rf -- "${demo:?}"' EXIT &&
python3 -c 'import shutil,sys; shutil.copytree("examples/vault", sys.argv[1], dirs_exist_ok=True)' "${demo:?}" &&
git -C "${demo:?}" init -q &&
git -C "${demo:?}" add -A &&
git -C "${demo:?}" -c user.name="Vivary Quickstart" -c commit.gpgsign=false \
 -c user.email="quickstart@vivary.invalid" commit -qm "governed quickstart" &&
PYTHONPATH=../core python3 tropo.py find "folder as type decision" \
  --root "${demo:?}" --governed --max-claims 12 --json
)
```

Requires Python 3.11+ (stdlib `tomllib`) and the first-party `vivary-core>=0.2.7`
contract seam. Neither package adds third-party runtime dependencies. Optional
extras: `python -m pip install "vivary-tropo[embedded]"` for LanceDB embedded storage and
backend-level experiments. Plain `tropo find` and default `tropo query` read the typed
graph directly without providers, network calls, or indexing. `tropo query --mode
vector` uses
zero-dependency computed vectors for file-backed workspaces; when optional embedded
storage is configured and current migrated vectors exist, it uses those stored rows
through the embedded backend. In both cases it preserves type/path/edge filters and
falls back to typed text search with an explicit JSON status when the vector index is
not trustworthy. `tropo query --mode semantic` is an optional-provider bridge: it only
runs when `.vivary/memory.toml` enables a supported semantic-memory provider,
currently the separate `vivary-memory-cognee` package. Tropo core does not bundle
Cognee, network calls, or provider indexing.
Cloud extras are reserved for future adapter work.

`tropo migrate --from file --to embedded --json` reports embedding persistence
explicitly. With no `[storage.embedding]` table, rows stay plain typed nodes. With
`enabled = true` and `provider = "local-hash"`, migrated rows include a `vector` plus
source and embedding fingerprints, so stored vector query can refuse stale rows
without re-chunking the workspace. Invalid embedding config and unsafe embedded
storage paths fail before any embedded backend write. Real file-to-embedded migration
replaces the embedded node snapshot, so deleted, renamed, newly excluded, or
vector-schema-changed nodes do not leave stale embedded rows behind.

Built-in packs are embedded in the single-file engine, so installed wheels can resolve
starter packs without a repo-local `packs/` directory. Workspace-local
`.tropo/packs/<name>.toml` files still take precedence.

TOML config and frontmatter parsing tolerate a single leading UTF-8 BOM, which keeps
Windows-created files from failing to load or being misread as body-only documents.
`tropo view --out` keeps generated HTML under the tropo root, rejects symlink targets,
and replaces output files without mutating hard-linked files outside the workspace.

For local debugging, pass `--receipt PATH` or set `VIVARY_RECEIPT_LOG=PATH` to append
a dependency-free JSONL run receipt. Receipts stay local and record only command
envelope data such as tool version, command, flag names, exit code, duration, Python,
and platform; they do not capture stdout, stderr, file contents, raw query text,
target ids, or paths.

`tropo find` is the friendly context-compression command: it returns a short packet of
typed nodes/files to open first, with reasons, snippets, and an approximate token
budget. `tropo query` is the lower-level filtered search primitive; it can filter by
type, path glob, or outbound edge and explain whether a match came from id/title,
frontmatter, path, body, edge context, or typed vectors. Semantic mode returns
provider hits as typed Vivary node ids instead of opaque chunks.

Add `--governed` to `tropo find` to opt into the first `vivary-core` adapter: a
read-only workspace scan becomes a bounded, fingerprinted Task Capsule. Plain
`tropo find` remains unchanged. The canonical flag rules, safety boundary, evidence
shape, privacy behavior, and bounds live in the
[command reference](https://vivary.vercel.app/commands/#tropo--the-typed-knowledge-graph).

Search mode mental model:

| Mode | Boundary |
|---|---|
| `text` | Default deterministic graph search; no setup. |
| `vector` | Local fuzzy ranking over typed graph nodes; no provider and falls back to `text` without explicit local vector policy. |
| `semantic` | Optional provider bridge, filtered back to known typed Vivary node ids. |

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
- **Dependency-light, CI-clean.** Tropo stays a single-file engine with one
  first-party core seam and honest exit codes.

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
