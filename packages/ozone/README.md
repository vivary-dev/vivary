# vivary-ozone

> Current published release: **0.2.0**. Development source: **0.3.1**, held for the final coordinated release train.

**The review layer** — the protective filter. Where `tropo` answers *"is each
document valid?"*, `ozone` reviews the **whole graph**: the relationship-level gaps a
per-document check can't see, and the **blast radius** of a change — everything that
depends on it. A review is graph-aware by construction because ozone reads tropo's
typed graph in-process (one graph implementation, never a fork).

The defining idea: **code review and editorial review are the same layer with
different rule packs.** Ozone ships deterministic packs over the Vivary workspace
vocabulary with no LLM or network calls. Medium-specific and semantic ("organize by
meaning") review layers can sit on top; semantic relatedness is graphify's job, not
Ozone's core.

## Try it locally

```bash
python ozone.py review --root <workspace>      # findings over the graph
python ozone.py review --root <workspace> --pack context-budget
python ozone.py review --root <workspace> --pack editorial
python ozone.py review --root <workspace> --pack all
python ozone.py review --root <workspace> --strict   # gate mode: exit 1 on warnings
python ozone.py impact <id> --root <workspace> # what depends on <id> (blast radius)
python ozone.py packs                          # list rule packs
python ozone.py review --root <workspace> --receipt .vivary/receipts.jsonl
python ozone.py verify request.json --governed --json --strict
```

`review` is **advisory by default** (exit 0) — a work-in-progress change legitimately
has nothing verifying it yet. Pass `--strict` to make it a gate (exit 1 when warnings
exist), e.g. pre-merge or in CI. `tropo check` remains the hard structural gate;
ozone is the relationship/impact review layered on top.

`ozone review` defaults to `--pack structure` for stable CI. Use
`--pack context-budget` to review context bloat surfaces, `--pack editorial` to review
writing-workspace coverage, or `--pack all` to run every deterministic pack.

### Governed evidence verification

`ozone verify REQUEST --governed` is the explicit experimental facade over
`vivary-core` receipt integrity, gate sufficiency, and dry-run context-repair
contracts. It preserves core's fingerprinted receipt and gate verdicts unchanged, so
Strato can consume the returned `gate_verdict` directly. A supplied workspace graph
adds a typed repair proposal; every proposal requires a gate and reports
`writes_performed: 0`.
The request is preflighted with an iterative JSON-work ceiling before recursive
canonical validation or Core loading. Oversized input returns the typed
`request_work_unbounded` refusal. Core owns the exact top-level capsule and receipt
field sets; Ozone reports deterministic `unknown_capsule_field:*` and
`unknown_receipt_field:*` reasons without adding a generic artifact-shape reason.
The capsule commits checkout IDs and paths, normalized repository nodes, and
`checkout_of` relationships that can drive repair proposals. Ozone recomputes that
topology commitment from the supplied graph, including inferred no-remote
linked-worktree groups.
Core also reprojects the complete graph from checkout paths, facts, and normalized
observation refusals. Every derived node, edge, conflict, unknown, omission,
deterministic ID, evidence field, effective worktree root, canonical allowlist, and
semantic fact commitment must match. Known fact values must match their fact-specific
type; unknown facts require a reason. The workspace fingerprint and graph timestamp
must match the request and capsule.
Ozone validates the complete receipt shape and requires its verified and unverified
claim lists to be disjoint. Together, the lists must contain exactly the capsule's claim
IDs. The claim lists must also match the check outcomes. `claims_verified` contains
every claim only when the check list is nonempty and every check passed. Otherwise,
`claims_unverified` contains every claim.
Each capsule conflict must retain its compiler-owned kind, repository, question, sides,
status, reason codes, and `review_required` decision. It must preserve at least two
checkout/path sides with head revision, head reference, last fetch, and evidence fields.

Receipt checks that share a capsule required-check name must also carry its exact
command. Declared `task.scope` roots must be absolute, nonblank, and bounded in count.
Optional `task.filters` entries must carry a nonblank `equals` or `includes` value,
whether or not the request supplies a graph. With a graph, claim identities,
graph-derived semantics, subjects, paths, profile filters, question signals, in-scope
graph unknowns, selection omissions, and observation refusals must match or
verification fails closed. Signal terms, fields, and paths must be strings.
Selection omissions cannot understate the graph-reconstructable minimum and match
exactly when their counts equal it. Opaque content can only raise the totals; bounded
over-budget entries remain capsule-attested but must name an in-scope checkout and a
safe checkout-relative content path. Unknown or reshaped omission variants are invalid.
Explicit task-required checks have unique nonblank names, remain visible in the capsule
without a graph, bind to an observed Git checkout execution root related to task scope,
and cannot rewrite evidence-derived commands. Without a graph, the capsule's effective
check list must equal that declaration exactly; without a declaration, it must be empty.
Otherwise Ozone returns `graph_required_for_effective_checks`, and the caller must
resubmit with the matching graph so Core can reconstruct derived checks. With a graph,
Ozone derives required checks and undetermined-check unknowns from graph evidence.
Ozone reconstructs the full claim list from graph candidates and retained content-match
candidates under the same task, filters, scope, and budget. Retained content-match
claims are validated through their capsule shape and signals; Ozone does not re-read
files.
Ozone bounds graph collections, claim-subject checkouts, scope paths, checkout-pair
scans, route evidence, scope-to-conflict comparisons, and canonical re-projection work
before it creates a repair proposal. Projected `neighbor_of` pairs must fit the
1,000-edge repair-graph ceiling. Remaining re-projection work counts graph JSON and
repeated checkout-path expansion, with a cap of 10,000,000 canonical-JSON work units.
Excess returns `repair_work_unbounded`.

The exact request, result, freshness, and exit-code contract lives in the
[command reference](https://vivary.vercel.app/commands/#governed-evidence-verification).

For local debugging, pass `--receipt PATH` or set `VIVARY_RECEIPT_LOG=PATH` to append
a dependency-free JSONL run receipt. The receipt target must not identify a file-backed
verification request, including through a hard-link alias. Ozone refuses run-receipt
output when `REQUEST` is `-`, because stdin does not expose enough source identity to
prove the target is distinct. Receipts stay local and record only command envelope data
such as tool version, command, flag names, exit code, duration, Python, and platform.
They do not capture stdout, stderr, file contents, target ids, local paths, or graph
content.

## The `structure` pack

Deterministic, topology-derived findings keyed on a node's workspace folder:

| rule | severity | fires when |
|---|---|---|
| `change-unverified` | warn | a `changes/` node has no `verification` edge |
| `change-ungated` | info | a `changes/` node has no `gates` edge |
| `module-unverified` | info | a `modules/` node has no `verification` edge |
| `orphan` | info | a node has no edges in or out |
| `broken-edge` | warn | an edge points at a missing node (tropo `check` enforces this) |

## The `context-budget` pack

Deterministic context-bloat findings over public routing/startup surfaces only. It
does not read private memory files such as `USER.md`, `MEMORY.md`, `memory/**`,
heartbeat reports, `.vivary/**`, or `.git/**`.

| rule | severity | fires when |
|---|---|---|
| `module-index-missing` | warn | a `modules/<name>/` directory has no `index.md` |
| `legacy-module-file` | warn | `modules/<name>.md` coexists with `modules/<name>/index.md` |
| `always-on-large` | info | a root routing contract exceeds its fixed line/char threshold |
| `module-index-large` | info | `modules/index.md` or `modules/*/index.md` exceeds 120 lines or 8000 chars |
| `bulk-load-cue` | info | public routing text tells agents to read/load/scan/open whole repos, docs trees, folders, or everything |
| `duplicate-routing-block` | info | an exact normalized routing block over 100 chars repeats across public routing surfaces |

## The `editorial` pack

Deterministic editorial coverage findings over writing folders only. It stays silent
for non-writing workspaces, and looks for graph coverage across `drafts/`,
`manuscripts/`, `reviews/`, `editorial-reviews/`, `edits/`, `revisions/`,
`outlines/`, `structures/`, and `beats/`.

| rule | severity | fires when |
|---|---|---|
| `draft-unreviewed` | warn | a `drafts/` or `manuscripts/` node has no linked review |
| `draft-unedited` | info | a draft/manuscript has no linked edit or revision |
| `draft-structure-missing` | info | a draft/manuscript has no linked outline, beat sheet, or structure note |
| `review-unlinked` | warn | a review is not linked to a draft or manuscript |
| `edit-unlinked` | warn | an edit/revision is not linked to a draft, manuscript, or review |

## Render

For a visual of a change's blast radius, reuse tropo's renderer:

```bash
python ../tropo/tropo.py view blast <id> --root <workspace> --out impact.html
```

## Requirements

Python 3.11+. In a repo checkout, Ozone loads the sibling Tropo and core packages
in-process. Packaged builds depend on `vivary-tropo>=0.3.0` and
`vivary-core>=0.2.4`.

---

Website & docs: <https://vivary.vercel.app/>
