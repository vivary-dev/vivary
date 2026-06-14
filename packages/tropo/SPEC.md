# tropo — specification

This is the normative model and config-format reference for `tropo`. It is
written to be implementable from scratch and stable enough to build an engine,
a CI action, and editor tooling against. Version: **spec v1 (draft)**.

Keywords **MUST**, **SHOULD**, **MAY** are used in the RFC 2119 sense.

---

## 1. Concepts

- **Document** — a Markdown file (`.md`, `.markdown`) inside a tropo tree.
- **Tree** — the directory subtree governed by a resolved `tropo.toml`.
- **Type** — a named kind of document (`person`, `project`, `decision`). A
  document has exactly one type, or is **untyped**.
- **Type root** — a folder whose basename is registered as a type's `folder`.
  Its descendants inherit that type until a nearer type root overrides it.
- **Derived field** — metadata the engine computes from the path, the
  filesystem, git, or the document body. Never required in frontmatter.
- **Declared field** — metadata that must appear in YAML frontmatter because it
  cannot be derived (the *signal*).
- **Pack** — a reusable bundle of type definitions, composed by name.
- **Overlay** — a nested `tropo.toml` that tightens the rules for its subtree.

The governing principle: **a field is declared only if it cannot be derived.**

---

## 2. Type resolution (normative)

Given an absolute document path `P` inside a tree rooted at `R` (the directory
containing the governing `tropo.toml`):

1. Let `A` be the list of ancestor directories of `P`, from the one containing
   `P` up to and including `R`, nearest first.
2. For each directory `d` in `A`, in order: if `basename(d)` equals the
   `folder` of some registered type `T`, then `P` has type `T`. **Stop.**
3. If no ancestor matches, `P` is **untyped**.

Consequences, by design:

- **Moving** a file between type roots **retypes** it. No edit required.
- **Renaming** a type root renames the type for everything under it.
- **Nesting** is first-class: `projects/tropo/decisions/0001.md` resolves to
  `decision` because `decisions/` is the nearest registered ancestor, even
  though it sits inside a `project` root.
- A type's `folder` MAY occur at any depth. `decisions/` works at the tree root
  and inside any project alike.

> Resolution is purely by **basename**, not full path. `folder = "people"`
> matches every directory named `people`, anywhere in the tree. To restrict a
> type to one location, give it a unique folder name.

---

## 3. Derivation

Derived fields are computed on demand and are **never** valid in frontmatter
unless explicitly overriding the derived value. The base derivations:

| Field     | Source (in order of preference)                                   |
|-----------|-------------------------------------------------------------------|
| `id`      | filename slug — **except an _index document_** (see below)         |
| `slug`    | same as `id`                                                      |
| `title`   | first `# H1` in the body → else humanized `id`                    |
| `created` | first git commit touching the file → else filesystem birth time   |
| `updated` | last git commit touching the file → else filesystem mtime         |

**Index documents.** A file named `README.md`, `index.md`, `_index.md`, or named
identically to its containing folder is the folder's *index document* and takes
its `id` from the **folder**, not the filename. `projects/tropo/README.md` has id
`tropo`, because a folder-shaped entity *is* its folder — that is also the id other
documents `ref` it by. Non-index files keep their filename slug as id.

Rules:

- An author **MAY** override a derived field by writing it in frontmatter; the
  written value wins and the engine **MUST NOT** flag it as redundant unless it
  exactly equals the derived value (then warn — it is noise).
- If a derivation source is unavailable (e.g. no git history), the engine falls
  through the preference list. `created`/`updated` therefore always resolve.
- Derived dates use `YYYY-MM-DD` in the local timezone of the run unless the
  config sets `base.timezone`.

---

## 4. Fields and validation

### 4.1 Field-type vocabulary

A field spec is a string naming a type:

| Spec            | Accepts                                                       |
|-----------------|--------------------------------------------------------------|
| `string`        | any scalar string                                            |
| `date`          | `YYYY-MM-DD`                                                 |
| `datetime`      | ISO-8601 with time/zone                                      |
| `slug`          | `^[a-z0-9._-]+$`                                              |
| `url`           | absolute URL                                                 |
| `bool`          | `true` / `false`                                             |
| `number`        | integer or float                                             |
| `list`          | a YAML sequence of any scalars                               |
| `string-list`   | a YAML sequence of strings                                   |
| `ref`           | a `slug` pointing at another document's `id` (link target)   |
| `ref-list`      | a sequence of `ref`                                          |
| `enum:a\|b\|c`  | one of the listed literals                                   |
| `any`           | anything (escape hatch)                                      |

To make a field tolerant of extra precision (e.g. a date that carries a time),
prefer `string` or `any` over the strict type.

### 4.2 Validation outcomes

| Code | Level   | Meaning                                                       |
|------|---------|---------------------------------------------------------------|
| E001 | error   | frontmatter present but is not valid YAML                     |
| E101 | error   | required field missing                                        |
| E102 | error   | required field present but empty                              |
| E103 | error   | field value violates its type spec                            |
| E110 | error   | declared field overrides a derived field with a *different*, invalid value |
| E120 | error   | overlay/pack attempts to **loosen** an inherited rule (forbidden) |
| W201 | warning | untyped document (no ancestor type root) — allowed unless `base.allow_untyped = false` |
| W202 | warning | unknown field for this type                                  |
| W210 | warning | declared field exactly equals its derived value (pure noise) |
| W220 | warning | broken `ref` — target `id` not found in the tree             |

A document with **no frontmatter at all is valid** if its type has no required
declared fields (E001 is only for a *present but malformed* block). This is the
common, intended case.

Exit codes (for CI): `0` clean · `1` errors found · `2` config/usage problem.

---

## 5. Configuration

### 5.1 Why TOML for config, YAML for content

Config is `tropo.toml`; document metadata is YAML frontmatter. The split is
deliberate: the **config surface and the content surface are different things**,
and giving them different syntaxes keeps each unambiguous. TOML has no
significant-whitespace footguns and a closed, explicit grammar — right for
rules. YAML is what notes already use — right for prose-adjacent metadata.

### 5.2 Resolution by walk-up

To govern a document at path `P`, the engine walks up from `P`'s directory to
the filesystem root collecting every `tropo.toml` it finds. The **nearest** is
the tree root `R`. Configs found *above* `R` do not apply. Configs found in
subdirectories *between* `R` and `P` are **overlays** (§5.5).

A single `tropo.toml` at a repo root is the whole setup. That is the portable,
drop-in case.

### 5.3 File shape

```toml
version = 1

# Compose reusable type bundles. Resolved left-to-right; local types below win.
packs = ["personal", "dev-project"]

[base]
# Fields the engine derives — never required, never noise in frontmatter.
derive       = ["id", "title", "created", "updated"]
# Fields any document MAY carry regardless of type.
optional     = { tags = "string-list", aliases = "string-list", status = "string" }
allow_untyped = true          # W201 instead of E for files outside any type root
strict        = true          # opinionated default: warnings fail `check` (see below)
timezone      = "local"       # or an IANA name, e.g. "America/New_York"

# --- Type definitions ----------------------------------------------------
# Table key is the TYPE name; `folder` is the directory basename that roots it.

[types.person]
folder   = "people"
required = { relationship = "enum:self|family|friend|colleague|other" }
optional = { company = "string", email = "url", links = "url" }

[types.project]
folder   = "projects"
required = { status = "enum:idea|active|paused|shipped|archived" }
optional = { repo = "url", target_ship = "date" }

[types.decision]
folder   = "decisions"        # valid at the root OR nested in a project
required = { status = "enum:proposed|accepted|superseded", date = "date" }
optional = { supersedes = "ref", superseded_by = "ref" }

[types.meeting]
folder   = "meetings"
required = { attendees = "string-list" }
optional = { date = "date", project = "ref" }
```

Field tables (`required` / `optional`) map **field name → field spec** (§4.1).
A type with no `required` table accepts zero-frontmatter documents.

### 5.4 Packs

`packs = [...]` names bundles resolved in this order, first match wins:

1. `./.tropo/packs/<name>.toml` (project-local packs)
2. packs shipped with the tropo distribution (`packs/<name>.toml`)

A pack file is a partial config containing only `[types.*]` (and optionally
`[base]` additions). Composition merges packs left-to-right, then merges the
local config last. **Later definitions may add or tighten; they may not loosen**
(see §5.6) — a violation is `E120` at config-load time and aborts with exit `2`.

### 5.5 Overlays

A `tropo.toml` in a subdirectory of the tree root is an **overlay**: it applies
only to its subtree and may **only tighten** the inherited rules — add a
required field, narrow an enum, add a new nested type. It may not remove a
required field or widen a type. This mirrors how a nested `CLAUDE.md` overlay
constrains, never relaxes, the rules above it.

### 5.6 The tighten-only law

Across packs, local config, and overlays, every merge step **MUST** be a
*tightening* of what came before:

- adding a type — OK
- adding a required or optional field — OK
- moving a field from optional → required — OK (tighter)
- narrowing an enum (removing literals) — OK
- moving required → optional, removing a field, widening an enum, or relaxing a
  type spec — **forbidden (E120)**

This single invariant is what makes composition safe: you can always reason
about a document by reading rules top-down, knowing nothing below ever takes a
constraint away.

---

## 6. CLI surface

```
tropo            # check the tree rooted at the nearest tropo.toml (cwd)
tropo check PATH...   # check specific files or folders
tropo fix             # strip frontmatter that merely repeats a derived value (de-noise)
tropo signal          # print ONLY the irreducible declared metadata, per document
tropo types           # print the resolved, merged type registry
tropo stats           # document counts per type + health summary
tropo graph           # emit the typed graph: documents as nodes, refs as edges
tropo blast ID        # what (transitively) refs ID — its blast radius
tropo view [graph|blast ID]  # self-contained HTML render of the graph or a radius
tropo plan SPEC.toml  # simulate a change (remove/retype/break/add) — render the delta
tropo init [DIR]      # scaffold a tropo.toml (optionally --packs a,b)
```

Global flags: `--config PATH`, `--root PATH`, `--json`, `--lenient`
(allow warnings without failing), `--strict` (force warnings→errors, overriding a
lenient config), `--quiet` (errors only), `--dry-run` (fix preview), `--depth N`
(blast hop limit), `--out FILE` (view target), `--packs a,b` (init).

**`check` is opinionated by default: any warning fails it** (exit `1`). The CLI is a
gate, not a linter — untyped docs (`W201`), unknown fields (`W202`), broken refs
(`W220`), and redundant frontmatter (`W210`) all fail unless you opt out. Relax with
`--lenient` per run or `base.strict = false` in `tropo.toml`; `--strict` forces it
back on. `strict` is **tighten-only** under overlays: a nested config may turn it on,
never off. (When a `W210` is present, `check` hints to run `tropo fix`.)

`tropo fix` is deliberately minimal: it removes `W210` noise (a declared field
equal to its derived value) and deletes a frontmatter block that becomes empty.
It **never** invents semantic values, touches malformed YAML, or edits a value it
did not derive — de-noising is the whole job, in keeping with signal-over-noise.

`tropo signal` is the namesake report: it walks the tree and prints, per
document, only the fields that are *not* derivable — the literal signal, with
the noise removed. It is the fastest way to see what a vault actually asserts.

`tropo graph` treats a document's `ref`/`ref-list` fields as **typed edges**: the
tree is already a graph, so this just makes it navigable. Nodes are documents
(keyed by `id`); each edge carries the field it came from. An edge whose target
matches no `id` is reported `broken` (the W220 condition). Whole-tree always —
an edge may originate anywhere.

`tropo blast ID` is the **blast radius**: every document that, directly or
transitively, `ref`s `ID` — i.e. what a change to it could touch (the inbound-edge
closure). `--depth N` caps the hops. Cycles terminate and a node never appears in
its own blast radius. This is the impact reasoning a line diff cannot give.

`tropo view` renders the graph — or a single blast radius — as **one
self-contained HTML file**: inline SVG, inline data, no CDN, no library, in
keeping with the zero-dependency engine. The whole-graph view lays nodes on a
circle; `view blast ID` uses concentric rings (the target at the centre, each
ring a hop further out). `--out FILE` writes it; otherwise the HTML goes to
stdout.

`tropo plan SPEC.toml` simulates a proposed change to the graph and renders the
**delta** — without ever touching disk. The change-spec is a small TOML file:

```toml
remove = ["old-decision"]            # delete nodes (and their outbound edges)
retype = { draft = "decision" }      # change a node's type
break  = [{ from = "a", to = "b" }]  # delete matching edges (field optional)
add    = [{ from = "x", field = "depends_on", to = "y" }]   # add edges
```

The engine builds the current graph, applies the spec to a copy, and reports the
**semantic diff**: nodes added / removed / retyped, edges added / removed, and
the actionable `edges_newly_broken` — edges that *survived* the change but now
point at nothing (e.g. their target was removed). It also lists the documents
*affected* (those in a changed node's blast radius). `plan` exits non-zero when
the change would introduce broken edges, so it works as a pre-merge gate. This
is the impact reasoning a text diff cannot give.

---

## 7. Decided / open

**Decided — folder aliases.** A type MAY be rooted by several folder names:
`folder = ["people", "contacts"]`. Every listed basename maps to the type; a
basename mapping to two different types is a config error (exit `2`).

Open questions, tracked, not yet decided:
- **Body-derived fields beyond title.** e.g. first paragraph → `summary`. Useful
  but risks turning prose into schema. Deferred.
- **Cross-tree `ref` resolution.** `ref`/`ref-list` validation is within one
  tree for v1. Linking across trees is out of scope until there is a manifest.
- **Pack distribution.** Bundled-only for v1; a fetch-by-URL pack registry is a
  later concern and must not compromise the zero-dependency engine.
