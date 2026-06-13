# Vivary — handoff (start a fresh chat here)

This document is self-contained. A new session can pick up Vivary from this file
alone. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) alongside it.

_Written 2026-06-13._

---

## TL;DR

Vivary is a **standard + scaffolder for agent-native workspaces** — the
`create-t3-app` of agent workspaces. It composes standalone, atmosphere-named
modules into a normalized workspace (second brain / coding / writing), on any
agent runtime and any stack.

The baseline = **a self-improving loop over a typed knowledge graph, with one
visible state surface and human gates.** Design law: the framework must cost
almost nothing to load (throughline's minimalism hypothesis).

**Right now:** `packages/tropo` works (knowledge-graph CLI ported from loam, 22
tests passing). Everything else is stubs + docs. The repo is local-only (git
initialized, no remote).

---

## How we got here (so the reasoning isn't lost)

This started as "install braincheck's second-brain skill," became **loam** (a
folder-as-type typed knowledge layer, now public at
github.com/Jeff-Kazzee/loam), then the scope expanded: loam is just one layer of
a larger **agent workspace ecosystem**. Jeff pulled in three more of his own
repos and asked to distill all four into one baseline.

### The four source repos (DO NOT MODIFY — copy only)

| Repo | Role | Becomes |
|---|---|---|
| [braincheck](https://github.com/Jeff-Kazzee/braincheck) | frontmatter typechecker, declaration-first | **retired ancestor** of tropo |
| [loam](https://github.com/Jeff-Kazzee/loam) | folder-as-type typed knowledge graph | **`@vivary/tropo`** (already ported) |
| [throughline](https://github.com/Jeff-Kazzee/throughline) | "Tiny Agent OS": visible State Surface, the `Ask→retrieve→act→verify→learn→gate` loop, FW/WS/PRIV grammar, human gates, MEMORY/USER templates | **`@vivary/strato`** |
| [flywheel](https://github.com/Jeff-Kazzee/flywheel) | bootstrap (SOUL/USER/AGENTS/MEMORY) + heartbeat audit + self-improvement (bug-risk playbook, third-strike skill rule, plugin packaging) | **`@vivary/strato`** |

**Key insight:** throughline and flywheel are the *same loop at two speeds* —
throughline runs it per-turn, flywheel distills it on a heartbeat. Jeff chose to
**fuse them into one `strato` package**, not keep them separate.

### Naming journey (why "Vivary")

We hit "the bare word is taken" three times. The verified findings:

- **loam** — PyPI + npm both taken; "LOAM" is a robotics acronym. Dropped as a
  system name (the loam *repo* stays as Jeff's public experiment).
- **Trellis** — taken by `mindfold-ai/Trellis`, a Claude Code agent harness (a
  direct competitor), and Sprout Social's agent. Rejected.
- **garden / grove / greenhouse / orchard** — Google **Agent Garden** owns the
  metaphor; most are claimed (Orchard CMS, Canopy fintech). Rejected.
- **rhizome** — taken, and collides *in our own domain* (ztellman/rhizome is a
  graph-viz lib; RhizomeDB). Rejected.
- **terroir** — PyPI taken (terraform tool). Rejected.
- **vivarium** — real Python microsim framework on PyPI + the `github.com/vivarium`
  org. Contested.
- **welkin** — "Welkin Health" company on PyPI; org taken. Rejected.
- **✅ Vivary** — archaic word for *vivarium*. **Free on npm and PyPI.** GitHub
  bare login is a dead "Vivary Golf Club" (★0) → org needs a handle variant.

**Namespace strategy:** the brand owns the scope; modules are scoped
(`@vivary/tropo`, PyPI `vivary-tropo`), so taken bare module names don't matter.

---

## Current state of this repo (`~/dev/vivary`)

```
vivary/
├─ README.md              vision
├─ AGENTS.md              runtime contract for any agent (plan+alignment merge gate)
├─ CLAUDE.md              Claude Code overlay (ultraplan = Claude's mechanism for it)
├─ HANDOFF.md             this file
├─ docs/ARCHITECTURE.md   full model
├─ LICENSE                MIT
├─ packages/
│  ├─ tropo/              WORKING — ported from loam, renamed loam→tropo, 22 tests pass
│  │                       includes packs/repo-graph.toml (WIP toward the graph layer)
│  ├─ strato/             STUB — README only (throughline + flywheel to be fused here)
│  ├─ ozone/              STUB — README only (review: code + editorial)
│  └─ exo/                STUB — README only (multi-agent orchestration)
└─ sandboxes/             empty — throwaway workspaces to test `create vivary` against
```

`packages/tropo` is loam's engine verbatim with a clean `loam`→`tropo` rename
(`tropo.py`, `tropo.toml`, command `tropo`, `CONFIG_NAME="tropo.toml"`). Its
`SPEC.md` / `README.md` are loam's docs renamed — content is correct but the
*framing* still reads as a standalone tool; it needs a pass to position it as
`@vivary/tropo`.

---

## Open decisions (need Jeff or a call)

1. **GitHub org handle** — bare `vivary` is taken. Recommended `vivary-dev`; alts
   `usevivary`, `getvivary`, `vivarylabs`. Org NOT created yet.
2. **`create-vivary` npm name** — not yet verified (almost certainly free since
   `vivary` is).
3. **Config filename** — tropo currently uses `tropo.toml` (inherited from
   `loam.toml`). Decide: per-module config vs. one workspace-level `vivary.toml`.
4. **Is `strato` one package or two?** Jeff chose **one** (fuse throughline +
   flywheel). Confirm before splitting.
5. **`create vivary` presets** — second brain / coding / writing. Define what each
   lays down.

## Known-but-unbuilt design (high-value, already thought through)

- **The type-inference ladder for tropo.** loam is folder-as-type *only*, which
  couples organization to type. We designed (but did not build) a resolution
  ladder: explicit `type:` in frontmatter → optional filename convention
  (`msa.contract.md`) → folder-as-type default. Folder stays the zero-noise
  default; declare type only when structure can't carry it. A redundant `type:`
  that repeats the folder is flagged as noise (W210), same as any derived field.
- **The graph layer for tropo (the moat).** tropo's `ref`/`ref-list` fields are
  *already* typed edges, so it's secretly a graph. Build: `tropo graph` (emit
  JSON), `tropo blast <id>` (blast radius = inbound-edge closure), `tropo plan`
  (simulate proposed changes, render the delta without touching disk), `tropo
  view` (self-contained HTML of the graph / blast radius / plan), and a semantic
  graph-diff (nodes retyped, edges broken/created) that beats a text diff. The
  `packs/repo-graph.toml` WIP and graphify integration feed this. **loam = the
  parser; graphify = the reasoner** (graphify consumes tropo's clean graph; do
  NOT put embeddings in tropo — that's where minimalism dies).
- **Overlays + `fix` already exist in tropo** (from loam): nested config tightens
  a subtree (tighten-only law, E120); `tropo fix` strips frontmatter that repeats
  a derived value. Packs compose type bundles.

---

## Recommended next steps (in order)

1. **Fuse throughline + flywheel → `packages/strato`.** One model: visible State
   Surface + compounding memory + the `Ask→…→gate` loop + human gates + the
   heartbeat/third-strike/playbook self-improvement. Honor the minimalism law —
   this should be tiny to load. Start from throughline's `THROUGHLINE.md`
   compressed model and flywheel's three modes (bootstrap/heartbeat/self-improve).
2. **Build tropo's graph layer** (`graph`/`blast`/`view`) — the headline value-add.
3. **Add the type-inference ladder** to tropo so it isn't folder-only.
4. **Design `create vivary`** + the three presets.
5. **Reframe tropo's docs** from standalone-loam to `@vivary/tropo`.
6. **Naming/publishing** (needs Jeff's explicit go-ahead, per item): pick the org
   handle, create the org, verify `create-vivary`, publish.

---

## Constraints & rules (carry these forward)

- **Do NOT modify the four source repos.** loam/braincheck/throughline/flywheel
  stay as Jeff's published originals. Vivary copies from them.
- **Minimalism is the design law.** If a layer is expensive to load, it's wrong.
- **No nested git repos.** Vivary is ONE repo; packages are plain subdirectories,
  not their own `.git`. (Jeff's standing rule.)
- **Plan + alignment before merge** (see [AGENTS.md](AGENTS.md)). No branch merges
  without a written, human-approved plan (intent · blast radius · verification ·
  out-of-scope · alignment); human and agent aligned in writing, never
  merge-then-explain. Claude's mechanism for this gate is **ultraplan** (plan mode)
  — see [CLAUDE.md](CLAUDE.md).
- **Publishing is gated per item.** npm/PyPI publish, GitHub org/repo creation,
  pushes, PRs — each needs Jeff's explicit chat confirmation. Don't batch.
- **Supply chain.** Before any install, check `~/dev/agents/.shared/deny-list-npm.json`
  and run `npm/pnpm audit`. Vet new deps.
- **GitHub Actions is billing-locked** on the Jeff-Kazzee account — CI jobs are
  created but never run. Verify locally; a red CI is not a code defect.
- **Platform:** Windows 11 / PowerShell (use `$null`, not `nul`; bash also
  available). Python 3.11+ (tropo needs stdlib `tomllib`).

## Verify the current state

```bash
cd ~/dev/vivary/packages/tropo
python tests/test_tropo.py          # 22/22
python tropo.py check  --root examples/vault    # clean
python tropo.py signal --root examples/vault    # the irreducible-metadata report
```
