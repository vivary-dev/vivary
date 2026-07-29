---
title: "Command reference"
description: "Every CLI across Vivary: tropo, strato, ozone, exo, create-vivary, and optional adapters."
editUrl: "https://github.com/vivary-dev/vivary/edit/dev/docs/COMMANDS.md"
---

This is the full, technical list of every command. If you're just starting, you only
need a handful (`create-vivary init`, `doctor`, `tropo check`); the [getting started
guide](/getting-started/) walks through those. Come back here for the details.

Every CLI across the four atmospheric layers uses Python 3.11+ and no third-party
runtime dependency; the optional governed paths compose the first-party `vivary-core`
contract seam. Command names are `tropo` / `strato` / `ozone` / `exo`; the scaffolder
remains `create-vivary`, regardless of installation method.

- **Install (PyPI):** `pip install vivary`
- **Run without installing (uv):** `uvx --from vivary-tropo tropo check`, `uvx --from vivary-ozone ozone review`, …
- **Scaffold (npm):** `npm create @vivary@latest my-workspace` / `npx @vivary/create@latest my-workspace`
- **From a repo checkout:** `python packages/tropo/tropo.py check`, etc.

Features called out as **unreleased** are present on the `dev` branch and generated
site docs, but are not available from the current PyPI/npm packages until the next
release-train PR bumps and publishes them.

Exit codes are uniform: **`0`** success · **`1`** findings/errors · **`2`** usage/config
error. Gate CI on the exit code; don't parse text. Every command takes `--json` for
machine-readable output.

Every core CLI also accepts `--receipt PATH`, or the equivalent
`VIVARY_RECEIPT_LOG=PATH`, to append one local JSONL run receipt after the command
finishes. This is **not telemetry**: Vivary does not send receipts anywhere, does not
start a background process, and does not record stdout, stderr, environment variables,
file contents, raw query text, target ids, or local paths. Receipts record only a small
debug envelope: schema version, tool/version, command, flag names, argument count,
exit code, duration, Python version, and platform. Receipt targets must be regular
files; symlink targets, symlink/junction directory ancestors, directory targets, and
Windows device names are refused.

Install the `vivary` meta package when you want a human-readable pull surface over
those receipts:

```bash
tropo check --root . --receipt .vivary/receipts.jsonl
vivary logs .vivary/receipts.jsonl
vivary logs .vivary/receipts.jsonl --failed --tail 10 --json
vivary logs email .vivary/receipts.jsonl --to support@example.com --out .vivary/support.eml
```

`vivary logs email` writes a local `.eml` draft or prints a `mailto:` URL. It does not
connect to SMTP, call an API, upload logs, or send mail by itself.

**The CLI is the agent API.** Every command an agent needs to run Vivary is here — no
MCP server, no special protocol. Commands that interact or install also accept `--yes`
(auto-confirm all prompts), `--auto` (agent selects from explicit storage/privacy/size
hints), and `--dry-run` (inspect without side effects). See
[SPEC-data-layer.md](https://github.com/vivary-dev/vivary/blob/dev/docs/SPEC-data-layer.md) for the full agent CLI contract and the new
storage/migration commands.

---

## vivary — local visibility helpers

```
vivary logs [PATH] [--json] [--tail N] [--failed]
vivary logs email [PATH] --to EMAIL [--subject TEXT] [--out FILE]
                  [--json] [--tail N] [--failed]
```

The `vivary` meta package installs the four core CLIs and adds a tiny local helper for
the receipt files they emit. `vivary logs` summarizes a JSONL receipt file as text or
JSON. `vivary logs email` creates a redacted support email draft from the same
whitelisted receipt fields. Unknown fields, malformed lines, stdout/stderr-like fields,
file contents, raw query text, target ids, and local paths are not copied into the
summary.

| Command | Job |
|---|---|
| `logs [PATH]` | Read local JSONL receipts from `PATH`, `VIVARY_RECEIPT_LOG`, or `.vivary/receipts.jsonl` and print a summary. |
| `logs --failed --tail 10` | Show only recent failed receipts. |
| `logs --json` | Return `{summary, records}` for agents and bug-report tooling. |
| `logs email ... --out FILE` | Write a local `.eml` draft; directory targets, symlink targets, symlink/junction ancestors, and Windows device names are refused. |
| `logs email ...` | Without `--out`, print a `mailto:` URL for the user's mail client. |

## tropo — the typed knowledge graph

```
tropo [command] [paths...] [--lenient | --strict] [--json] [--quiet]
                [--depth N] [--max-entries N] [--out FILE] [--packs a,b]
                [--root DIR] [--config PATH] [--receipt PATH]
                [--type TYPE] [--path GLOB] [--edge FIELD[:TARGET]]
                [--snippet N] [--explain] [--mode text|vector|semantic] [--budget N]
```

A document's **type is the folder it lives in** (`decisions/0001.md` → type
`decision`). Metadata is only what can't be derived from where a file sits and what it
says. `tropo.toml` declares the types.

| Command | What it does |
|---|---|
| `check [paths]` | Validate frontmatter + the graph. **Opinionated: warnings fail by default.** Default command. |
| `signal [paths]` | Print only the *irreducible* metadata per doc — the literal signal, noise stripped. |
| `types` | Print the resolved, merged type registry. |
| `stats` | Document counts per type + a health summary. |
| `graph [--json]` | Emit the typed graph: nodes (`id`,`type`,`path`) + edges (`from`,`field`,`to`,`broken`). |
| `blast <id> [--depth N]` | The **blast radius** of `<id>`: everything that (transitively) refs it — what a change could touch. |
| `view [graph \| blast <id>] [--out FILE]` | Render the graph (or one radius) as a single self-contained HTML file. `--out` must stay inside the tropo root, refuse symlink targets, and rewrite the workspace output path without mutating hard-linked files outside the workspace. |
| `plan <change.toml>` | Simulate a change (remove/retype/break/add) and show the graph delta. |
| `fix [--dry-run]` | Strip redundant frontmatter (`W210` — a field equal to its derived value). The only mechanical edit tropo makes. |
| `init [DIR] [--packs a,b]` | Scaffold a `tropo.toml` (optionally composing reusable type packs). |
| `find <text> [--budget N] [--k N] [--json]` or `find <text> --governed [--max-claims N] [--json]` | Human-friendly retrieval. Plain mode returns typed nodes/files with reasons and snippets under an approximate token budget. Experimental governed mode runs Tropo's read-only workspace scan through `vivary-core` and returns a bounded, fingerprinted Task Capsule with evidence, conflicts, unknowns, omissions, and required checks. |
| `query <text> [--k N] [--mode text\|vector\|semantic] [--type TYPE] [--path GLOB] [--edge FIELD[:TARGET]] [--snippet N] [--explain] [--json]` | Filtered graph search over typed nodes. Default `text` searches id/title, frontmatter, path, body, and outbound edge context. `vector` uses dependency-free local typed vectors when `.vivary/storage.toml` enables them, prefers stored embedded vectors when current rows exist, and otherwise falls back to text search. `semantic` calls an explicitly configured optional semantic-memory provider and returns typed node ids. |
| `migrate --from file --to embedded [--dry-run] [--json]` | Move file-backed graph data into the configured embedded backend. When local vector policy is explicitly enabled, migrated rows also include typed-node vectors and provenance metadata. Cloud migration, non-file sources, backend installation, and `migrated_at` tracking are future 0.3.x work. |
| `map [--root PATH] [--depth N] [--max-entries N] [--json]` | Read-only filesystem inventory of a repo/vault/docs tree — no `tropo.toml` required. See [Filesystem map](#filesystem-map-tropo-map) below. |

`tropo find` is the default "what should I read first?" command for humans and agents.

`tropo find --governed` is the first opt-in `vivary-core` adapter. It scans only the
resolved Tropo root, passes that same normalized path as the explicit allowlist and
capsule scope, performs no fetch, write, index mutation, provider call, or memory
operation, and reports anything unproved as an unknown or omission. `--max-claims`
sets the capsule's non-negative claim bound (default `24`). Governed mode rejects every
plain/query retrieval modifier it does not consume: `--budget`, `--k`, `--mode`,
`--type`, `--path`, `--edge`, `--snippet`, and `--explain`. Conversely,
`--max-claims` requires `--governed`, and both governed flags are valid only with
`find`; invalid combinations exit `2` rather than being ignored. Plain `tropo find`
remains unchanged when the flag is absent.
Derived required checks use checkout-scoped names and carry both the normalized `cwd`
where the command must run and the exact observation that justified it. A standalone
`tropo.toml` derives `tropo check`; `create-vivary doctor` is derived only when the
observed root also carries the scaffold identity markers `AGENTS.md` and `STRATO.md`.
Governed search drops one-letter ASCII contraction fragments, uses NUL-framed Git
output, treats every path passed to `git check-ignore` as literal, excludes tracked
paths covered by repository ignore policy or an explicit readable global/system
`core.excludesFile`, and refuses a Tropo root nested inside a larger Git worktree
rather than leaking sibling checkout facts.
Every default Git command used by checkout observation or content retrieval disables
repository-configured filesystem monitors. Workspace markers and package scripts pass
through the same fail-closed ignore-policy filter as content and dirty paths.
Reparse-point and multiply linked markers are rejected; a bounded package manifest is
read only through a descriptor whose identity is verified around the open. Ignored or
externally linked manifests cannot leak facts or derive commands. Core brackets content
with checkout observations; dirty or privacy-filtered checkouts also require two
identical content scans inside a stable bracket. A changed bracket retries once.
Persistent mutation reports content unavailable, while an unobservable dirty state
reports `dirty_state_unknown`; neither case compiles mixed-state facts and content.
Unicode terms and content remain supported; unrankable non-content facts become
explicit omissions instead of aborting the capsule. Question extraction preserves
order, deduplicates terms, and searches at most the first `16`; core then caps matched
bytes, lines per file, claims, and omission detail.
`tropo query` is the lower-level filtered search primitive. By default both are
graph/text retrieval, not the CocoIndex active-context sidecar. On the unreleased
`dev` branch, `tropo query --mode vector` is a dependency-free typed-vector mode:
it preserves type/path/edge filters and returns typed Vivary node ids without
installing an embedding provider. Enable it explicitly in `.vivary/storage.toml`:

```toml
[storage.embedding]
enabled = true
provider = "local-hash"
dimensions = 128
```

When the workspace is configured for embedded storage and current migrated vectors
exist, JSON output reports `vector.source: "stored"` and `vector.index: "embedded"`.
Stored-vector query validates compact metadata first and asks the backend for a
bounded candidate set. If the embedded index is empty, stale, missing vectors,
dimension mismatched, too large for conservative validation, or unavailable, `--mode
vector` reports `status: fallback`, `fallback: "text"`, and a `detail` string, then
returns deterministic typed text results.
Workspaces that enable local vectors without embedded storage still use computed
graph-node vectors and report `vector.source: "computed"`. Without local vector
config, `--mode vector` falls back to the normal typed text search.

`tropo query --mode semantic` is an optional-provider bridge: it requires
`.vivary/memory.toml` to enable a supported semantic-memory provider, and today that
means the separate `vivary-memory-cognee` package must be installed and indexed by
the user. It does not add Cognee or network calls to `vivary-tropo` core. Use
`create-vivary init ... --active-context cocoindex-code` when a coding workspace
needs semantic code candidates.

`tropo migrate --from file --to embedded --json` reports an `embedding` object.
Without `[storage.embedding]`, the status is `disabled` and rows stay plain typed
nodes. With `enabled = true` and `provider = "local-hash"`, each migrated row gets a
`vector` plus `embedding_provider`, `embedding_dimensions`, `embedding_version`,
`embedding_scope`, `embedding_text_fingerprint`, and `source_fingerprint`. Bad
embedding config fails before backend writes. Root and nested `exclude` rules,
symlink/junction pruning, and out-of-root path checks run before any text is
embedded. Embedded storage paths must stay inside the workspace and avoid symlink or
junction-backed directories. Real file-to-embedded migration replaces the embedded
node snapshot, so deleted, renamed, or newly excluded nodes do not leave stale
embedded rows.

Simple rule: start with plain `tropo find` or `tropo query`. Reach for the other
modes only when the plain graph search is not enough.

| Mode | Use it when | What changes |
|---|---|---|
| `text` (default) | You want deterministic local search over the typed graph. | No setup, no index, no provider, no network. |
| `vector` | You want local "close wording" ranking over graph nodes, but still no provider. | Requires explicit `[storage.embedding] provider = "local-hash"`; embedded workspaces use stored vectors when current, otherwise deterministic text fallback. |
| `semantic` | You already chose and indexed an optional semantic-memory provider. | Calls that provider, then filters hits back to known typed Vivary node ids. |

Useful retrieval flags:

| Flag | Effect |
|---|---|
| `--type TYPE` | Restrict to a document type; repeat for multiple allowed types. |
| `--path GLOB` | Restrict to path globs such as `decisions/*`; repeatable and slash-normalized for Windows paths. |
| `--edge FIELD[:TARGET]` | Require an outbound graph edge field, optionally pointing at a target id. |
| `--snippet N` | Include up to `N` snippet characters per result; `0` disables snippets. |
| `--explain` | Include stable match reasons such as title/id, frontmatter, path, body, or edge context. |
| `--mode text\|vector\|semantic` | `query` only: use dependency-free graph/text search, dependency-free local typed-vector search, or call the configured optional semantic-memory provider. |
| `--budget N` | `find` only: approximate token budget for the returned context packet. |
| `--governed` | `find` only, unreleased source: opt into the experimental Tropo scan → `vivary-core` evidence graph → bounded Task Capsule path. |
| `--max-claims N` | `find --governed` only, unreleased source: maximum capsule claims; must be a non-negative integer (default `24`). |

```bash
tropo find "where is release truth owned" --root . --budget 800 --json
tropo query "release truth" --type decision --path "decisions/*" --explain --json
tropo query "agent workspace" --edge affects:agent-workspace
# Unreleased dev branch until the next package publish:
tropo find "where is release truth owned" --root . --governed --max-claims 12 --json
tropo query "release truth" --mode vector --json
tropo query "release truth" --mode semantic --json
```

### Strictness (the `check` gate)

`check` is **strict by default** — untyped docs, unknown fields, broken refs, and
redundant frontmatter all fail it. Relax when you need to:

```bash
tropo check                 # strict: any warning fails (exit 1)
tropo check --lenient       # warnings shown, exit 0
tropo check --quiet         # hide warnings, errors only
```

Or persistently per vault, in `tropo.toml`: `[base] strict = false`. `--strict` forces
it back on (overrides a lenient config). `strict` is *tighten-only* across nested
configs — a sub-folder may turn it on, never off.

### Finding codes

| Code | Level | Meaning |
|---|---|---|
| `E000` | error | file can't be read |
| `E001` | error | frontmatter isn't valid YAML / not a mapping |
| `E101` | error | required field missing for the type |
| `E102` | error | required field is empty |
| `E103` | error | field value violates its type spec |
| `W201` | warn | untyped document (no ancestor folder is a registered type) |
| `W202` | warn | unknown field for the type (typo? add it to the schema) |
| `W210` | warn | field equals its derived value (noise — run `tropo fix`) |
| `W220` | warn | ref points at no document id (broken edge) |

(Under the default strict mode, every `W2xx` fails the check.)

### Filesystem map (`tropo map`)

```
tropo map [PATH | --root PATH] [--depth N] [--max-entries N] [--json]
```

Read-only inventory of a large repo, vault, docs tree, or file system — no
`tropo.toml` required, and nothing is ever written. Meant to let an agent
understand the shape of a tree without opening hundreds of files: a directory
table, extension and size summary, existing index/routing files, and folders
that look like modules but have no `index.md`/`README.md`.

| Flag | Effect |
|---|---|
| `PATH` / `--root PATH` | Tree to inventory (default: current directory) — give one or the other, not both; extra positional paths are an error. Does **not** need a `tropo.toml`. |
| `--depth N` | Directory-table depth, root = depth 0 (default: `3`). Counts (totals, extensions, largest files, missing-index detection) always cover the *whole* tree regardless of `--depth` — only the table rows are limited. |
| `--max-entries N` | Cap the number of directory rows — the markdown table and the JSON `directories` array alike (default: unlimited). Summary sections are never capped. |
| `--json` | Emit a single JSON object with sorted keys and deterministic ordering (stable to diff and safe to cite). |

The output is safe to share: the `root` field (and the markdown heading) is the
mapped directory's **basename only** — the absolute local path never appears.
Every other path is root-relative with forward slashes.

Skipped: `.git`, `node_modules`, `__pycache__`, `.venv`, `venv`, `dist`,
`build`, `.astro`, `.next`, `target`, plus any `exclude` patterns from a
`tropo.toml` found by walking up from the map root (the same `is_excluded`
mechanism `check`/`graph` use, applied to directories **and** individual
files) — a missing or invalid config never blocks the map. When the map root
sits below the config root, path-anchored excludes are rebased onto the map
root, so `exclude = ["docs/private"]` still hides `private/` when you run
`tropo map docs`. Directory junctions and symlink cycles are pruned by real
path, so a looping tree never inflates counts. Individual **files** that are
themselves symlinks or reparse points are skipped for the same reason — each is
an alternate route to content the walk may already have counted. Hard-linked
files are **not** skipped: a hard link is an ordinary directory entry, so both
paths are counted. That means totals are a count of *paths* and size is the sum
of per-path sizes — `map` does not report disk usage, and two hard links to one
file contribute twice. To leave something out of the map deliberately, use
`exclude` or the skipped-directory list above; link type is not a privacy
control. `map` reads no file contents — only names, sizes and structure.
"Likely modules without an index" = directories at depth 1-2 with 5 or more
files (recursive count) and no `index.md`/`README.md`.

```
$ tropo map --root . --depth 2
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

### `tropo.toml`

```toml
[base]
derive       = ["id", "title", "created", "updated"]   # never required, never noise
optional     = { tags = "string-list", status = "string" }   # any doc MAY carry these
allow_untyped = true     # W201 instead of error for files outside any type root
strict        = true     # warnings fail check (the opinionated default)
timezone      = "local"

packs = ["dev-project"]  # compose reusable type bundles

[types.decision]         # table key = the TYPE name
folder   = "decisions"   # the directory basename that roots it
required = { status = "enum:proposed|accepted|superseded", date = "date" }
optional = { supersedes = "ref", related_modules = "ref-list" }
```

Field specs: `string`, `slug`, `date`, `datetime`, `url`, `string-list`, `any`,
`enum:a|b|c`, and the graph types **`ref`** / **`ref-list`** (these become edges).

Built-in packs: `dev-project`, `repo-graph`, and `coordination`. Local
`.tropo/packs/<name>.toml` files take precedence over bundled packs. Use
`coordination` when exo should be allowed to write `assignee`:

```toml
packs = ["repo-graph", "coordination"]
```

---
## strato — the policy layer

```console
strato decide --governed [--json] [--strict] <REQUEST.json|->
```

`decide` is an explicit experimental facade over `vivary-core`'s pure budget,
capsule/receipt-gate, and next-loop policy. It does not persist loop state, execute
actions, or accept free-form approvals. `--governed` is required; `-` reads one JSON
request from standard input.

The request envelope is `vivary.strato-decision-request/v0`:

```json
{
  "schema": "vivary.strato-decision-request/v0",
  "policy_version": "vivary.strato-policy/v0",
  "actor": {"kind": "agent", "id": "agent:example"},
  "authority_class": "contributor",
  "workspace": {"fingerprint": "sha256:..."},
  "scope": {"project": "example", "paths": ["/workspace"]},
  "requested_at": "2026-07-26T12:00:00Z",
  "decision_at": "2026-07-26T12:00:00Z",
  "capsule": {
    "schema": "vivary.task-capsule/v0",
    "capsule_id": "capsule_...",
    "fingerprint": "sha256:...",
    "task": {
      "question": "What is the next safe loop step?",
      "scope": ["/workspace"]
    },
    "workspace": {
      "fingerprint": "sha256:...",
      "repair_topology_fingerprint": "sha256:...",
      "observed_at": "2026-07-26T12:00:00Z"
    },
    "claims": [],
    "conflicts": [],
    "unknowns": [],
    "omissions": [],
    "required_checks": [],
    "budget": {"max_claims": 8}
  },
  "state": {"turns_used": 0, "actions_used": 0},
  "limits": {"max_turns": 8, "max_actions": 32}
}
```

`capsule` must be a complete Task Capsule. Its `capsule_id` must match the
deterministic identifier derived from its task question, optional filters, and workspace
fingerprint; its body must reproduce its claimed fingerprint without non-canonical or
numerically lossy values. `budget.max_claims` must be an integer from `0` through
`9007199254740991`, the largest integer that round-trips through JavaScript without
loss. A capsule altered after compilation, given a fabricated identity, or missing
compiler-owned Task Capsule fields such as `budget` is an invalid envelope and never
reaches core policy. Compiler callers must omit `task.scope` or provide a non-empty list
of non-empty path strings. `scope.project` is a non-empty audit label. `scope.paths`
must contain absolute roots and match `capsule.task.scope`; core's path equivalence
normalizes separators, ignores root order, and folds case on Windows. A missing or
broader capsule scope fails closed. Both `requested_at` and caller-supplied
`decision_at` are required. The request, capsule observation, and any receipt must be
no more than **300 seconds** old at `decision_at`, ordered consistently, and
timezone-aware. Passing the clock in the request keeps the facade pure and makes
future/stale decisions deterministic.

`receipt` is optional. `verdict` is optional only with a receipt; a receiptless verdict
is rejected instead of silently ignored. When both are present, core independently
binds and validates them before the verdict can clear a gate. Actor kinds are `human`,
`agent`, and `worker`; authority classes are `contributor` and `owner`, and only a
human actor may claim `owner`. These vocabularies and their reason codes come from
core's authority policy. Unknown envelope fields are rejected; the Python facade also
rejects non-string mapping keys without coercing or sorting them. Free-form text such
as `"status": "approved"` cannot satisfy a human gate.

By default, output is a short text summary. `--json` emits either a validated
`vivary.strato-decision/v0` document with identity fields plus core's `decision`,
`reason_codes`, `budget`, and `gate`, or a `vivary.strato-decision-refusal/v0`
document with refusal reason codes and no unvalidated identity fields. Malformed JSON,
an invalid envelope, or an input too deeply nested to evaluate safely exits `2`;
recursive input uses the explicit `request_too_deeply_nested` refusal reason. A valid
evaluation is advisory and exits `0`; with `--strict`, a valid `blocked` or
`request_gate` decision exits `1`, so CI can gate on the exit code without parsing
output.

Envelope reason codes distinguish invalid shapes and policy versions, authority
refusals, workspace/scope mismatches, stale/future evidence, and a verdict submitted
without its receipt. Core's loop, budget, gate, receipt-integrity, and Ozone-verdict
reason codes pass through unchanged.

---


## ozone — the review layer

```
ozone [review | impact <id> | packs] [--root DIR] [--json] [--strict]
      [--pack structure|context-budget|editorial|all] [--receipt PATH]
ozone verify REQUEST --governed [--json] [--strict] [--receipt PATH]
```

Where `tropo check` asks "is each document valid?", `ozone` reviews the **whole graph**
and a change's impact. It reads tropo's graph in-process (one graph, no fork).

| Command | What it does |
|---|---|
| `review` | Run a deterministic review pack. Defaults to `--pack structure` for stable CI; use `--pack context-budget` for context bloat, `--pack editorial` for writing workspaces, or `--pack all` for every pack. **Advisory by default** (exit 0); `--strict` makes it a gate (exit 1 on warnings). |
| `impact <id>` | The blast radius of a node — what (transitively) depends on it, with distance + the edge field it came in by. |
| `packs` | List the available rule packs. |
| `verify REQUEST --governed` | Verify a governed capsule, receipt, and named gate through core's pure integrity/sufficiency contracts. Optionally include a workspace graph for bounded dry-run repair proposals. |

### Governed evidence verification

`verify` is opt-in and read-only:

```bash
ozone verify request.json --governed --json --strict
```

`REQUEST` is a JSON file, or `-` for stdin:

| Field | Contract |
|---|---|
| `schema` | Exactly `vivary.ozone-verification-request/v0`. |
| `workspace` | Exactly `{"fingerprint": "..."}`; must match the capsule. |
| `verified_at` | Caller-supplied timezone-aware instant. |
| `capsule` | Complete `vivary.task-capsule/v0`; its body fingerprint and deterministic ID are recomputed before core delegation. |
| `receipt` | Execution Receipt bound to the capsule. Omission or malformed/tampered evidence cannot produce a sufficient aggregate result. |
| `gate` | Named gate with core-owned `required_checks`, `require_claims_verified`, `max_unresolved_conflicts`, and `max_unresolved_unknowns` constraints. |
| `graph` | Optional matching `vivary.workspace-graph/v0`. When present, Ozone returns a bounded `vivary.context-repair-proposal/v0`; every proposal has `requires_gate: true`, and `writes_performed` is always `0`. |
Repair `checkout_of` endpoints must reference existing `checkout` and `repository`
nodes. The capsule's `workspace.repair_topology_fingerprint` commits the normalized
repository nodes and `checkout_of` relationships that can drive repair proposals;
Ozone recomputes it from the supplied graph before delegation. This binds remote-backed
and inferred no-remote linked-worktree groups without trusting a copied workspace
fingerprint label. Every divergent conflict has at least two sides and covers every
checkout related to its repository. The graph's conflict set must match the capsule's
preserved conflicts exactly; a graph cannot omit a conflict or a conflict side to turn
conflicting checkout truth into a deduplication proposal.
Claim IDs, claim facts, graph node IDs, and conflict IDs that repair expansion can
repeat are limited to 128 bytes in JSON string encoding.

A `claims_over_budget` omission must list exactly
`min(omitted_count, 16)` entries. This matches core's compiler cap.
Requests whose total checkout-pair scan count, potential repair count, route-proposal
evidence count, or derived estimate exceeds its matching core ceiling are refused
before delegation.

Envelope-level validation rejects future or stale timestamps, workspace mismatches,
non-canonical or unknown fields, invalid shapes, and deeply nested request documents
with a typed `vivary.ozone-verification-refusal/v0`, never a traceback.
In default plain-text output, reason fragments are JSON-escaped before they are written
so valid JSON field names cannot cause a terminal encoding failure.
Malformed or tampered receipt evidence inside an otherwise accepted envelope is not an
envelope refusal: core's receipt and gate verdicts describe the failure, and the valid
aggregate outcome is `insufficient`.

A valid result is `vivary.ozone-verification/v0`. Its `receipt_verdict`,
`gate_verdict`, and optional `repair_proposal` are the raw fingerprinted core
documents, not rewritten copies. Pass `gate_verdict` unchanged to Strato's `verdict`
field. `--strict` exits `1` when a valid evaluation is `insufficient`;
invalid request documents and refused request envelopes exit `2`; advisory mode exits
`0` for a valid evaluation. The
`--receipt PATH` CLI flag records Ozone's privacy-preserving local run envelope; the
evidence receipt itself belongs inside `REQUEST`.

### The `structure` pack

| Rule | Severity | Fires when |
|---|---|---|
| `change-unverified` | warn | a `changes/` node has no `verification` edge |
| `change-ungated` | info | a `changes/` node has no `gates` edge |
| `module-unverified` | info | a `modules/` node has no `verification` edge |
| `orphan` | info | a node has no edges in or out |
| `broken-edge` | warn | an edge points at a missing node (tropo `check` enforces this) |

### The `context-budget` pack

`context-budget` reviews only public routing/startup surfaces:
`AGENTS.md`, `CLAUDE.md`, `STRATO.md`, `STATE.md`, `SOUL.md`, `README.md`,
`modules/index.md`, and `modules/*/index.md`. It does not read private memory files
such as `USER.md`, `MEMORY.md`, `memory/**`, heartbeat reports, `.vivary/**`, or
`.git/**`.

| Rule | Severity | Fires when |
|---|---|---|
| `module-index-missing` | warn | a `modules/<name>/` directory has no `index.md` |
| `legacy-module-file` | warn | `modules/<name>.md` coexists with `modules/<name>/index.md` |
| `always-on-large` | info | a root routing contract exceeds its fixed line/char threshold |
| `module-index-large` | info | `modules/index.md` or `modules/*/index.md` exceeds 120 lines or 8000 chars |
| `bulk-load-cue` | info | public routing text tells agents to read/load/scan/open whole repos, docs trees, folders, or everything |
| `duplicate-routing-block` | info | an exact normalized routing block over 100 chars repeats across public routing surfaces |

### The `editorial` pack

`editorial` reviews writing workspaces using graph edges only. It stays silent for
non-writing workspaces, and looks for coverage across `drafts/`, `manuscripts/`,
`reviews/`, `editorial-reviews/`, `edits/`, `revisions/`, `outlines/`,
`structures/`, and `beats/`.

| Rule | Severity | Fires when |
|---|---|---|
| `draft-unreviewed` | warn | a `drafts/` or `manuscripts/` node has no linked review |
| `draft-unedited` | info | a draft/manuscript has no linked edit or revision |
| `draft-structure-missing` | info | a draft/manuscript has no linked outline, beat sheet, or structure note |
| `review-unlinked` | warn | a review is not linked to a draft or manuscript |
| `edit-unlinked` | warn | an edit/revision is not linked to a draft, manuscript, or review |

```bash
ozone review --root .            # advisory report
ozone review --root . --strict   # gate: exit 1 if any warning (CI / pre-merge)
ozone review --root . --pack context-budget
ozone review --root . --pack editorial
ozone review --root . --pack all --json
ozone impact human-gates --root . --json
```

---

## exo — the coordination layer

```
exo [conflicts | board | claim <id> --agent <handle> | roles] [--root DIR] [--json]
    [--receipt PATH]
```

The outermost, thinnest layer — engaged only when one agent becomes many. Graph-native
and deterministic; it doesn't run agents, it coordinates them. `claim` is the only
writer, and it refuses to write unless the workspace declares `assignee` through
`packs = ["coordination"]`.

| Command | What it does |
|---|---|
| `conflicts` | Among **active** work items (changes with `status: active`), flags pairs that share an outbound target — two in-flight changes touching the same node. |
| `board` | Work items grouped by `status` (and `@assignee` if the workspace declares one). |
| `claim <id> --agent <handle>` | Claim a work item under `changes/` by setting top-level `assignee`; optional leading `@` is accepted and stripped before storage. Refuses symlinked or out-of-workspace work item files and replaces the workspace file instead of truncating hard-linked targets. |
| `roles` | The bounded worker contracts: Orchestrator · Scout · Researcher · Builder · Verifier · Reviewer · Archivist. |

```bash
exo conflicts --root .    # who would collide
exo board --root .        # what's in flight
exo claim local-ci-baseline --agent connie --root .
exo roles                 # the role grammar
```

JSON output for `claim` includes `id`, `path`, `assignee`, `previous_assignee`, and
`changed`.

---

## create-vivary — the scaffolder

```
create-vivary init <target> [--preset coding|second-brain|knowledge-work|writing] [--force] [--obsidian]
                           [--active-context cocoindex-code]
                           [--storage auto|file|embedded|cloud] [--provider lancedb|sqlite-vec|qdrant|astra]
                           [--memory none|local|cognee]
                           [--auto] [--yes] [--dry-run] [--json]
                           [--size small|medium|large] [--privacy local|cloud] [--receipt PATH]
create-vivary wizard <target> [--storage auto|file|embedded|cloud] [--provider lancedb|sqlite-vec|qdrant|astra]
                              [--memory none|local|cognee] [--yes] [--dry-run] [--json] [--receipt PATH]
create-vivary capabilities [--preset coding|second-brain|knowledge-work|writing] [--json]
                            [--receipt PATH]
create-vivary doctor <target> [--json] [--trend] [--repair] [--yes] [--receipt PATH]
create-vivary adopt <target> [--preset coding|second-brain|knowledge-work|writing] [--yes] [--json]
                           [--receipt PATH]
```

| Command | What it does |
|---|---|
| `init <target>` | Lay down a complete workspace: the agent contract, the strato shell (SOUL/USER/STATE/MEMORY), runtime skills, a `tropo.toml`, a starter typed graph, and optional storage or semantic-memory config based on flags/wizard answers. |
| `wizard <target>` | Re-run the setup wizard on an existing workspace to reconfigure storage and optional semantic-memory policy. |
| `capabilities` | List optional capabilities for a preset: storage, semantic memory, and preset-specific sidecars. |
| `doctor <target>` | Validate the strict common workspace shell, the inferred published module contract, active privacy ignore rules, module directory indexes, tropo graph health, declared capability config, backend reachability, and semantic-memory status. |
| `adopt <target>` | Bring Vivary to an existing repo or vault. Only adds files that don't already exist; never moves, renames, edits, or overwrites anything. Dry-run by default. |

| Flag | Effect |
|---|---|
| `--preset coding\|second-brain\|knowledge-work\|writing` | Which starter graph to seed (default `coding`). |
| `--force` | Overwrite existing scaffold files and remove stale generated files, but still refuses symlinked destination parents or paths that resolve outside the target workspace. |
| `--obsidian` | Also drop an opt-in Obsidian vault config (graph coloured by type). |
| `--active-context cocoindex-code` | For `coding` workspaces, add CocoIndex-code sidecar profile (skill, docs, graph nodes, gitignore). Does not auto-install or enable MCP. |
| `--storage auto\|file\|embedded\|cloud` | Storage backend to configure. `auto` = LanceDB locally. Default: `file` (no new deps). Cloud writes config only; the tropo cloud backend is future 0.3.x work. |
| `--provider lancedb\|sqlite-vec\|qdrant\|astra` | Which implementation to use for the selected tier. `lancedb` is the shipped embedded provider. |
| `--memory none\|local\|cognee` | Optional semantic-memory policy. Default: `none`. `local` writes local-only policy. `cognee` writes gated Cognee policy and graph docs, but does not install Cognee or index content. |
| `--auto` | **Agent mode.** Skip all interactive prompts; pick the best option from explicit `--storage`, `--privacy`, and `--size` hints. |
| `--yes` | Auto-confirm installs and confirmations. Safe to combine with `--auto` for fully non-interactive agent use. |
| `--dry-run` | Print what would be scaffolded and installed; do not write, install, or clean stale files. |
| `--json` | Machine-readable output. Reports `ok`, `root`, `preset`, `storage`, `provider`, `memory`, capability metadata, `installed`, `files`, config paths, and `dry_run`. |
| `--size small\|medium\|large` | Hint for `--auto` storage decisions. Agents can pass this after inspecting the repo. |
| `--privacy local\|cloud` | Hint for `--auto` storage decisions. |
| `--repair` | Doctor-only. Include a conservative guided repair plan. Dry-run by default; writes nothing without `--yes`. |
| `--yes` | With `doctor --repair`, apply deterministic safe repairs, rerun doctor, and keep a nonzero exit if the workspace is still invalid. |

`doctor` always requires active ignore rules for `USER.md`, `MEMORY.md`, `memory/*`,
and `.strato/private/`. Published workspaces can predate `heartbeat-reports/*` or
`*.vivary-tmp`; without declared semantic memory, Doctor reports those missing newer
rules as warnings and names the line to add. A published semantic-memory profile makes
`heartbeat-reports/*` strict while leaving its newer `*.vivary-tmp` gap as an upgrade
warning. A current semantic-memory profile makes all six rules strict. Comments,
negations, and unrelated patterns that merely contain those names do not count.

If `.vivary/memory.toml` exists, `doctor` reports semantic memory as `disabled`,
`healthy`, `configured`, `unavailable`, `misconfigured`, or `privacy-failed` without
requiring optional Cognee support to be installed.

### Doctor compatibility and declared configuration

Doctor separates a **strict common baseline** from an **inferred workspace-contract
shape**. The baseline is the exact 15 files shared by the published v0.1 workspace:
`README.md`, `AGENTS.md`, `SOUL.md`, `STRATO.md`, `STATE.md`, `USER.md`, `MEMORY.md`,
`bug-risk-playbook.md`, `tropo.toml`, `.gitignore`, `templates/AGENTS.md`, and the four
runtime skill files under `.claude/skills/{strato,loops}/SKILL.md` and
`.agents/skills/{strato,loops}/SKILL.md`. Missing any of these is an error for every
supported workspace, including a legacy one.

`compatibility.workspace_contract` identifies `legacy-v0.1` when the workspace has the
flat `modules/agent-workspace.md` layout and no modern index, or `indexed-v0.2+` when
either modern index exists. An indexed workspace must have both `modules/index.md` and
`modules/agent-workspace/index.md`; a partial indexed layout is an error. A legacy
workspace is healthy without those two files: they appear only as recommendations,
with the non-writing adopt preview `create-vivary adopt <workspace> --preset <preset>`
(`adopt` is dry-run unless `--yes` is supplied). If `README.md` declares a supported
`Preset:`, Doctor puts that preset in its recommendation; otherwise it uses the explicit
`<preset>` placeholder. A workspace carrying neither published module signature is not
silently upgraded into an error solely for that absence.
It is only a preview: `adopt` never moves, converts, or removes a flat module, so any
legacy-to-indexed conversion remains a separate human decision.

The `compatibility` object is versioned with `"schema_version": 1`. It contains
`workspace_contract`, `baseline_missing`, `contract_missing`,
`declared_capability_problems`, `recommended_missing`, and `recommended_upgrade`.
`baseline_missing` is always the common v0.1 contract; `contract_missing` applies only
after Doctor has inferred the indexed contract; recommendations never make `ok` false.

When a storage or semantic-memory config is declared, Doctor validates its recognized
published or current profile. Embedded storage needs nonempty `path` and `provider`;
Qdrant cloud storage needs nonempty `provider`, `url`, `api_key`, and `collection`;
Astra needs nonempty `provider`, `endpoint`, `api_key`, and `collection`. Unknown cloud
providers are errors.

Local memory needs `state_path`, `allow_network`, and `require_explicit_index`. The
published Cognee profile adds `api_key_env`; its empty value remains a valid explicit
opt-out. The current Cognee profile also emits `allow_without_api_key` and
`allow_telemetry`; if either current-profile field is present, both are required and
type-checked. Both profiles require `enabled`, `provider`,
`mode = "semantic-provider"`, and every `[memory.privacy]` field. The three privacy
booleans must stay fail-closed. `private_paths` must retain the four-path published
floor (`USER.md`, `MEMORY.md`, `memory/**`, and `heartbeat-reports/**`); the current
template adds `.strato/private/**`, but Doctor accepts the published v0.3.1 profile
without it. A published profile missing the newer `*.vivary-tmp` ignore receives an
upgrade warning; the same gap remains an error for a current memory profile.
`memory.enabled = true` with `memory.provider = "none"` is a misconfiguration, not an
enabled no-op.

Plain `doctor` (including `--json`) is read-only, including legacy recommendations and
failing reports. It exits `0` exactly when `errors` is empty and `1` otherwise;
warnings do not change the exit code. `doctor --trend` is the explicit state-write
exception, and `doctor --repair --yes` is the explicit repair-write exception.

`doctor --repair` is guided and conservative for both published module contracts.
Plain `doctor` stays read-only.
`doctor --repair --json` reports `repair.actions` without writing. Each action has
`kind`, `status`, `path`, `summary`, and `applied`, with extra details when useful.
`doctor --repair --yes --json` applies only deterministic safe repairs, then reruns
doctor and returns that final report. Safe repairs are limited to regenerating missing
ignored private/runtime placeholders (`USER.md`, `MEMORY.md`, `memory/.gitkeep`,
`heartbeat-reports/.gitkeep`), appending missing privacy ignore lines, and removing
simple single-line W210 redundant derived metadata. Non-workspace targets, symlinked,
junctioned, hardlinked, non-file, and non-UTF-8 repair targets are refused or kept as
manual guidance. Lower-level `.gitignore` negations that unignore private paths are
reported as manual cleanup instead of being papered over by another root ignore block.
Complex YAML W210 cases, broken refs (W220), exo active-work conflicts, and missing
coordination-pack setup are manual guidance only; they are never auto-mutated.

`doctor --trend` is opt-in and is the only thing that writes `.vivary/doctor-state.json`
(plain `doctor` stays read-only). It compares this run's graph health, module-index
count, and file count under `modules/` against the prior recorded run and reports
signed deltas — a short "trend vs `<date>`" section in human mode, or a `trend` object
(`prior`/`current`/`deltas`) in `--json` mode. The first `--trend` run on a workspace
has no prior state, so it reports "first recorded run" and just writes the baseline. A
corrupt or unreadable state file is treated the same way — a warning, not a failure —
and gets overwritten with a fresh one.

When `--storage embedded` (or `auto`) is selected and `vivary-tropo[embedded]` is not yet installed, `init` installs it via `pip` before continuing unless `--dry-run` is set. In `--json` mode, `"installed": ["lancedb"]` reports what was added. Without `--yes`, a single confirmation prompt fires before any pip install. For scripted storage selection, pass `--no-wizard --storage embedded --yes` or use `--auto`; in human mode, the wizard asks and its answers drive storage. `--auto` never selects Cognee by itself.

### `adopt` — point Vivary at your mess

`adopt` brings the Vivary scaffold to a repo or vault that already exists, without
disturbing anything already there.

| Flag | Effect |
|---|---|
| `--preset coding\|second-brain\|knowledge-work\|writing` | Starter graph to seed. Default: auto-detected — `coding` for a code-file majority, `second-brain` for a markdown-file majority. `--json`/text output states the chosen preset and the reason. |
| `--yes` | Write the planned files. Without it, `adopt` only analyzes and prints a plan (**dry-run is the default**, unlike `init`). |
| `--json` | Machine-readable output: `{mode, root, preset, preset_reason, would_create, kept, followups, candidate_modules, excluded_pre_existing, skipped_module_collisions}`, plus `doctor` when `--yes` was passed. `mode` is `"dry-run"` or `"applied"`. |

`adopt` never moves, renames, edits, or overwrites any existing file. If a file it
would create already exists, it is skipped and reported "exists, kept" — this
includes `README.md`, `AGENTS.md`, `CLAUDE.md`, and any other file already at that
path. If `.gitignore` already exists, `adopt` leaves it untouched and instead prints
a manual follow-up listing the privacy lines it's missing, drawn from the same set
`doctor` checks:

```gitignore
USER.md
MEMORY.md
memory/*
!memory/.gitkeep
heartbeat-reports/*
!heartbeat-reports/.gitkeep
.strato/private/
*.vivary-tmp
```

Only the missing lines are printed, so paste what you get rather than the whole
block. One case is **not** fixable this way: if a lower-level `.gitignore` unignores
a private path, Git gives the deeper rule precedence and no root-level line can
override it. `adopt` reports those separately, naming the paths still exposed and
telling you to remove the nested negations — adding more root-level rules would not
help, and neither would answering a negation with another negation.

The analyze phase does a light, read-only inventory of the tree (skipping `.git`,
`node_modules`, `__pycache__`, `.venv`, `venv`, `dist`, `build`, `.astro`, `.next`,
`target`, and dotdirs) and looks for **candidate modules**: depth 1-2 directories
with 5 or more Markdown files and no `index.md`/`README.md` of their own. Each
candidate gets a thin router at `modules/<name>/index.md` that links to the existing
directory — the directory itself is never touched. If a candidate's name collides
with a module the chosen preset already owns (for example a brownfield `codebase/`
under the `coding` preset), no router is created for it and the collision is
reported under `skipped_module_collisions`; the preset's own starter module doc is
never overwritten by a router.

Adopt uses the same symlink- and out-of-root-hardened write path as `init`, and an
adopted workspace passes `create-vivary doctor` and `tropo check` (adopt writes a
`tropo.toml` whose `exclude` list is widened to cover pre-existing brownfield
content, so it isn't flagged as untyped noise).

Pre-existing content inside Vivary's graph folders (`modules/`, `changes/`,
`decisions/`, `verification/`, `gates/`) is handled the same way: each
pre-existing Markdown file there is excluded from the typed graph by exact path
(reported under `excluded_pre_existing` and as a manual follow-up), while
everything adopt itself writes stays graph-visible. A pre-existing `modules/`
sub-directory without an `index.md` additionally gets a thin router index (still
only adding a file), because doctor requires every module directory to carry one.
To bring an excluded file into the graph later, add the frontmatter its type
needs and remove its exclude entry from `tropo.toml`.

```bash
# See what adopt would do, without writing anything:
create-vivary adopt . --json

# Apply it:
create-vivary adopt . --yes

# Force a preset instead of the auto-detected one:
create-vivary adopt ~/notes --preset second-brain --yes
```

## vivary-cognee

`vivary-cognee` ships from the optional `vivary-memory-cognee` package. It is not part
of core Vivary and does not run unless a workspace explicitly configures
`--memory cognee`, installs the adapter, and approves provider writes.

```bash
vivary-cognee doctor --root . [--json]
vivary-cognee index --root . [--dry-run] [--yes] [--json]
vivary-cognee recall "<query>" --root . [--k N] [--json]
vivary-cognee forget --root . --yes [--json]
```

| Command | What it does |
|---|---|
| `doctor` | Reports Cognee adapter readiness, typed node count, manifest path, and stale/healthy/unavailable status without importing Cognee runtime. |
| `index` | Builds privacy-filtered typed Tropo node packets and sends them to Cognee. Requires `--yes` unless `--dry-run` is set, and requires `memory.cognee.allow_network = true` before provider runtime calls. |
| `recall <query>` | Calls Cognee recall when network/provider runtime is explicitly allowed and the manifest identity matches the current graph, then returns only hits that contain known Vivary node ids from the current typed graph. |
| `forget` | Removes the workspace dataset from Cognee provider memory. Requires `--yes` and explicit provider runtime allowance. |

The adapter uses `tropo` graph truth for ids, types, paths, and edges. Provider state
under `.vivary/memory/cognee/` is rebuildable cache, not source truth. The generated
Cognee policy starts with `allow_network = false`; that is an enforced gate so
doctor/dry-run receipts can prove readiness without importing provider runtime or
making embedding or LLM calls. Runtime provider calls also require `api_key_env` or
the explicit local-provider setting `allow_without_api_key = true`. Third-party
Cognee telemetry is disabled by default unless the workspace explicitly sets
`allow_telemetry = true`.
Approved index replaces the prior workspace-bound dataset, and recall refuses stale
or missing manifests so provider results cannot outrun Tropo graph truth. Dataset
names include a workspace path hash even when a label is configured. Tropo refuses
workspace-local `vivary_cognee.py` adapter imports for semantic query mode; installed
adapters must resolve outside the workspace and current working tree, and must expose
the hardened `vivary-memory-cognee` `0.1.1+` adapter contract.

```bash
# Human flow — interactive wizard:
create-vivary init my-workspace

# Agent flow — fully non-interactive:
create-vivary init . --preset coding --auto --size large --privacy local --yes --json

# Inspect available optional pieces for a preset:
create-vivary capabilities --preset knowledge-work --json

# Inspect without doing anything:
create-vivary init my-workspace --auto --dry-run --json

# Existing examples:
create-vivary init my-workspace --preset knowledge-work --memory local
create-vivary init my-workspace --preset writing
create-vivary init my-notes --preset second-brain --memory cognee --no-wizard --dry-run --json
create-vivary init my-codebase --preset coding --active-context cocoindex-code
create-vivary doctor my-workspace
# expected for a plain coding workspace: doctor: ok (9 node(s), 28 edge(s), 0 broken)
```

The four presets share the same agent-OS shell and differ only by starter graph. Each
starter module is a directory index (`modules/<id>/index.md`) so AGENTS can route to a
small surface before deeper context:

| Preset | Module | First change | Verification |
|---|---|---|---|
| `coding` | `codebase` | `local-ci-baseline` | `local-checks` |
| `second-brain` | `knowledge-base` | `capture-routine` | `retrieval-smoke` |
| `knowledge-work` | `workbench` + `sources` | `workbench-first-artifact` | `workbench-proof` |
| `writing` | `manuscript-system` | `draft-review-loop` | `editorial-review` |

---

See [GETTING-STARTED.md](/getting-started/) for a first run, [HOWTO.md](/howto/) for
task recipes, [SKILLS.md](/skills/) for the agent skills, and the
[homepage FAQ](https://vivary.vercel.app/#faq).
