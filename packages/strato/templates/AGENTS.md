# AGENTS.md — workspace contract

The contract every agent session in **this workspace** runs. Lean by law; the full
model is strato's `STRATO.md`. Read this on startup.

## Startup ritual (progressive disclosure; don't ask permission to read)

1. `SOUL.md` → 2. `USER.md` → 3. `STATE.md` → 4. today's & yesterday's
`memory/YYYY-MM-DD.md` → 5. `MEMORY.md`

Stop there unless the task needs more. Do not bulk-read `docs/`, `modules/`, or the
whole repo on startup.

## The loop (per turn)

`Ask → retrieve → act → verify → learn → gate.` State known / inferred / unknown;
confirm before guessing. One verified slice at a time.

This workspace **is a typed knowledge graph** — work it, don't just take notes in it:

- **retrieve** — see the graph with `tropo graph`; what depends on a node with
  `tropo blast <id>`. The graph is the first source of truth; grep notes second.
- **progressive disclosure** — use `modules/index.md` to choose the relevant module,
  then open only that module's `modules/<id>/index.md` before following deeper links.
  Every module directory needs an `index.md`; keep it small.
- **verify** — `tropo check` (strict — warnings fail) on what you touched, and
  `ozone review` for relationship gaps (an unverified change, a broken link) before a
  gate.
- **gate** — for a risky change, name its blast radius first (`ozone impact <id>`).
- **many agents** — coordinate with `exo` (`conflicts` / `board` / `roles`).

> Tooling: `pip install vivary-tropo vivary-ozone vivary-exo` (or run via `uvx`,
> e.g. `uvx vivary-tropo check`). No editor required — the graph is plain Markdown.

## Visible state

Keep `STATE.md` current (Focus / Status / Next / Open decisions / Blockers / Checks /
Sources / Updated) on the chosen cadence.

## Memory

- Daily notes at `memory/YYYY-MM-DD.md` — create today's if missing; append work,
  decisions, blockers, checks.
- Promote durable items to `MEMORY.md`. Write things down — mental notes don't survive
  a session restart.

## DRY law

One fact gets one owner. Put routing summaries in `AGENTS.md`, `STATE.md`, and
`modules/**/index.md`; put durable detail in the owning typed file; link instead of
copying. When a note repeats another source, either replace it with a link or promote
the repeated workflow into a skill.

## 🚦 Gates — ask first, one per item (never batched)

memory writes · global/agent rules · indexing · publishing · installs · `git
init`/`push`/PR · enabling active hooks · destructive ops · external data of unknown
sensitivity. When unsure whether something is a gate, it is.

## Self-improvement

When a *class* of bug bites twice → add a row to `bug-risk-playbook.md`. When a
workflow fires a third time → extract a skill (it becomes the source of truth; prompts
and memory mirror it). Run a heartbeat on the chosen cadence — see the strato skill.

## Privacy

PRIV lives only in `USER.md` / `MEMORY.md` / `memory/*` / `heartbeat-reports/*` /
`.strato/private/`
(gitignored). Never commit secrets, private names, credentials, or machine paths.
