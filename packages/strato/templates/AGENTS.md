# AGENTS.md — workspace contract

The contract every agent session in **this workspace** runs. Lean by law; the full
model is strato's `STRATO.md`. Read this on startup.

## Startup ritual (don't ask permission to read)

1. `SOUL.md` → 2. `USER.md` → 3. `STATE.md` → 4. today's & yesterday's
`memory/YYYY-MM-DD.md` → 5. `MEMORY.md`

## The loop (per turn)

`Ask → retrieve → act → verify → learn → gate.` State known / inferred / unknown;
confirm before guessing. One verified slice at a time.

## Visible state

Keep `STATE.md` current (Focus / Status / Next / Open decisions / Blockers / Checks /
Sources / Updated) on the chosen cadence.

## Memory

- Daily notes at `memory/YYYY-MM-DD.md` — create today's if missing; append work,
  decisions, blockers, checks.
- Promote durable items to `MEMORY.md`. Write things down — mental notes don't survive
  a session restart.

## 🚦 Gates — ask first, one per item (never batched)

memory writes · global/agent rules · indexing · publishing · installs · `git
init`/`push`/PR · enabling active hooks · destructive ops · external data of unknown
sensitivity. When unsure whether something is a gate, it is.

## Self-improvement

When a *class* of bug bites twice → add a row to `bug-risk-playbook.md`. When a
workflow fires a third time → extract a skill (it becomes the source of truth; prompts
and memory mirror it). Run a heartbeat on the chosen cadence — see the strato skill.

## Privacy

PRIV lives only in `USER.md` / `MEMORY.md` / `memory/*` (gitignored). Never commit
secrets, private names, credentials, or machine paths.
