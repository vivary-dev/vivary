# vivary-ozone

> Current published release: **0.2.0**. Development source: **0.3.0**, held for the final coordinated release train.

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

The exact request, result, freshness, and exit-code contract lives in the
[command reference](https://vivary.vercel.app/commands/#governed-evidence-verification).

For local debugging, pass `--receipt PATH` or set `VIVARY_RECEIPT_LOG=PATH` to append
a dependency-free JSONL run receipt. Receipts stay local and record only command
envelope data such as tool version, command, flag names, exit code, duration, Python,
and platform; they do not capture stdout, stderr, file contents, target ids, local
paths, or graph content.

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
`vivary-core>=0.2.2`.

---

Website & docs: <https://vivary.vercel.app/>
