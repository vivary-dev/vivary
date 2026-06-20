# STRATO — the agent OS (compressed model)

strato is **the loop**. tropo says what's true; strato is how an agent *works* over
it: one visible state surface, a per-turn loop, human gates, and the self-improvement
that compounds across sessions. It is throughline and flywheel fused — **the same
loop at two speeds.**

Lean by law (the minimalism hypothesis): every always-on file competes with the
user's task for context. This model is the only always-on strato file. Procedures
load on demand from the skill; templates load once, at bootstrap.

DRY by law: one fact gets one owner. `AGENTS.md`, `STATE.md`, and
`modules/**/index.md` are routing surfaces; deeper files own durable detail. Link
instead of copying, and load the next file only after the task proves it is relevant.

## FW vs WS — what strato is

- **strato is the FW** (framework): this model + the `templates/` a workspace starts
  from + the bootstrap/heartbeat/self-improve skill. Generic, public, reusable.
- A **workspace is the WS** (instance): its own `SOUL/USER/AGENTS/MEMORY/STATE`,
  created by laying strato's templates down (`create-vivary` does this).
- strato *provides*; the workspace *runs*. So `templates/AGENTS.md` is a workspace's
  contract — distinct from Vivary's own root `AGENTS.md`, which governs agents working
  on Vivary itself.

## Grammar

- **FW** — reusable method. Public, generic.
- **WS** — live workspace truth. Owned by the project/vault/repo.
- **PRIV** — ignored local context: identity, memory, secrets, plans.
- **VS** — the one user-visible state surface.
- **Gate** — human approval before a durable or high-risk change.
- **Loop** — `Ask → retrieve → act → verify → learn → gate`.

## The loop, at two speeds

- **Per turn** (throughline): run the loop on the current task — `Ask → retrieve →
  act → verify → learn → gate`.
- **Per heartbeat** (flywheel): on a slower clock, distill what the loop *learned* into
  durable memory, a bug-risk playbook, and extracted skills; audit workspace hygiene.

Same loop; the heartbeat is just `learn` with a longer period. That is what makes a
workspace *compound* — each session adds momentum the next inherits.

### Per turn

- **Ask** — state known / inferred / unknown; interview when unclear, don't guess.
- **Retrieve** — load the smallest useful context. Search finds *candidates*; sources
  + checks + the human are truth.
- **Progressive disclosure** — route through `modules/index.md` and the relevant
  `modules/<id>/index.md` before opening deeper files. Never read a whole tree just
  because it exists.
- **Act** — one useful slice. Plan before edits; define checks before implementing.
- **Verify** — code: tests/build. research: sources. docs: privacy, links, readability.
- **Learn** — distill repeated lessons; keep the source trail; promote only reusable
  lessons to FW.
- **Gate** — stop at the human gates below before anything durable or outward-facing.

## Visible State (VS)

One surface, kept current — the workspace's `STATE.md` (see
[templates/STATE.template.md](templates/STATE.template.md)):

```
Focus · Status · Next · Open decisions · Blockers · Checks · Sources · Updated
```

Cadence is the workspace's choice: daily · session-end · milestone · manual · disabled.

## 🚦 Human gates — ask first

Durable or outward-facing actions need explicit human approval, one per item, never
batched: **memory writes · global/agent rules · indexing · publishing · installs ·
`git init`/`push`/PR · enabling active hooks · destructive ops · sending external
data when sensitivity is unknown.** When unclear whether something is a gate — it is.

## Proactivity (the complement to gates)

A workspace compounds when the agent is bold *inside* the work and careful at the
*edges*:

- **Act without asking** — read startup files; create/append today's memory; surface
  stale items, unread messages, repeated workflows; run a read-only heartbeat.
- **Ask before** — anything in the gates above; deleting/moving files; changing
  SOUL/USER/AGENTS or an existing skill.
- **Stop and write a handoff** when two rules contradict, a change would overwrite
  another agent's work, a safety boundary is unclear, or required context is missing.

## Privacy

PRIV lives only in ignored files (`USER.md`, `MEMORY.md`, `memory/*.md`,
`.strato/private/`). Never commit secrets, client data, private names, credentials, or
machine paths. Before sending anything to an external model or tool, classify
sensitivity (public · internal · private · sensitive · secret · unknown); if unknown,
Gate.

## Self-improvement (the heartbeat)

Thresholds keep this from becoming busywork — most sessions produce none of these:

- **Bug-risk playbook** — when a *class* of bug bites twice, add a row (cause →
  concrete prevention) to the workspace's `bug-risk-playbook.md`. Self-healing.
- **Third-strike skill rule** — a workflow earns a skill on its *third* occurrence
  (first = exploration, second = coincidence, third = pattern). The skill is then the
  source of truth; prompts and memory mirror it, never duplicate.
- **Hygiene** — surface stale folders, cross-project bleed, dead skills, automation
  drift; decide per item. Bootstrap / heartbeat / self-improve procedures live in
  [.claude/skills/strato/SKILL.md](.claude/skills/strato/SKILL.md).

## Roles (when one agent becomes many)

strato defines the role grammar; *orchestrating* many agents is exo's job. Roles:
**Orchestrator** (intent, scope, gates, synthesis) · **Scout** (paths, confidence,
gaps) · **Researcher** (fact/inference/recommendation with credits) · **Builder** (one
slice + changed paths + checks) · **Verifier** (pass/fail/skipped/risk, no silent
edits) · **Reviewer** (findings first) · **Archivist** (notes, handoffs; PRIV
separate). Workers get bounded contracts; they never become product owners.

## Loop literacy

Running the loop *unattended* (a program that re-prompts the agent and decides whether
to continue) is strato's domain. When to recommend one and how to set it up safely
lives in the loops skill (`.claude/skills/loops/`) — recommend, don't default.

## Files

`README.md` (human front door) · `STRATO.md` (this model) · `templates/` (WS starters)
· `.claude/skills/strato/` (the executable bootstrap/heartbeat/self-improve). Anything
else folds into this model unless it earns its own load cost.
