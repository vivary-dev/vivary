# AGENTS.md — Vivary runtime contract

The contract for **any** agent working in this repo (Claude Code, Codex CLI, …).
Lean by law — depth lives in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[HANDOFF.md](HANDOFF.md). Read those once; don't reload them every turn.

## Mission

Vivary is a **standard + scaffolder for agent-native workspaces** — the
`create-t3-app` of agent workspaces. The baseline it encodes: *a self-improving
loop over a typed knowledge graph, with one visible state surface and human
gates.* Modules: **tropo** (knowledge), **strato** (agent OS), **ozone**
(review), **exo** (orchestration).

## Design law (non-negotiable)

**Minimalism.** Every always-on file competes with the user's task for context. A
layer or file that is expensive to load is *wrong*. Fewer files, fewer words, more
room for the work. This file obeys its own law — keep it that way.

## The loop

`Ask → retrieve → act → verify → learn → gate.` State known / inferred / unknown
and confirm before guessing. Do one verified slice at a time.

## 🚦 Hard gates — STOP and get the human

These are not optional and are not batchable. One explicit human approval per item.

1. **Plan + alignment before merge** (see below) — no branch merges without it.
2. **Publishing / outward actions** — npm or PyPI publish, GitHub org/repo
   creation, `push`, opening a PR. Each, explicitly, per item.
3. **Destructive ops** — delete, force-push, history rewrite.
4. **The four source repos are read-only** — loam, braincheck, throughline,
   flywheel. Copy from them; never modify them.

## Plan + alignment before merge

**Human and agent must be aligned — in writing — before anything merges.** Before
merging a branch or landing a substantial change, produce a written plan and get
explicit human approval. The plan states:

1. **Intent** — what changes and why; which layer/module and how it serves the
   baseline thesis.
2. **Blast radius** — everything it touches: files, packages, the knowledge graph,
   downstream layers. (Use tropo's graph/blast once it exists.)
3. **Verification** — how we'll know it's right: tests, checks, a sandbox run.
4. **Out of scope** — what this deliberately does *not* do.
5. **Alignment** — "I think I know / I am inferring / I do not know — confirm or
   correct." The human confirms or corrects.

No merge until the human has approved the plan **and** the delivered change matches
it. If the work diverged from the approved plan, re-align before merging — don't
merge and explain after.

*How* you produce the plan is runtime-specific; your runtime overlay names the
mechanism (for Claude Code, see CLAUDE.md → "ultraplan").

## Constraints

- **No nested git repos.** Vivary is one repo; packages are plain subdirectories.
- **Supply chain.** Before any install, check `~/dev/agents/.shared/deny-list-npm.json`
  and run `npm`/`pnpm audit`. Vet new dependencies; prefer pinned pre-compromise
  versions.
- **Platform.** Windows / PowerShell (`$null`, never `nul`; bash also available).
  `tropo` needs Python 3.11+ (stdlib `tomllib`).
- **CI is billing-locked** on this account — jobs are created but never run.
  Verify locally; a red CI is not a code defect.

## Verify

```bash
cd packages/tropo && python tests/test_tropo.py        # 22/22
python tropo.py check --root examples/vault            # clean
```
