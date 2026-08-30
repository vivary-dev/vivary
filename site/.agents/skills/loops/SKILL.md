---
name: loops
description: >-
  How to recognize when an agent loop fits, when it doesn't, and how to set one
  up safely. Use when the user asks "should I loop this", "set up a loop",
  "automate / run this repeatedly", "babysit my PRs", "run it on a schedule /
  unattended", mentions /loop, /goal, ralph, or a long-running batch over many
  items — or when you're about to do the same kind of task many times by hand and
  a loop might be better. Recommend loops; do not reach for one by default.
---

# Loops

A loop is **cron plus a decision-maker in the body**: a small program that prompts
the agent, reads what it produced, decides whether it's done, and if not prompts
it again. You author the loop and its *stopping behavior*; the model becomes a
subroutine. The work moves up an altitude — from doing the task to writing the
thing that does the task.

This skill is for deciding **whether to recommend a loop** and **how to set one up
safely**. Default behavior is a single focused pass — loops are a recommendation,
not a reflex.

## When to recommend a loop

Recommend one only when all three hold:

1. **Repeatable, long-running, or unattended** — babysitting PRs, polling a queue,
   a batch over many items, an overnight run.
2. **A reliable self-check exists** — the loop can verify its own work each tick
   (tests pass, build green, sources found, a validator confirms done). No
   feedback signal → no loop.
3. **State is durable** — the work can survive a restart (git-backed), so the loop
   doesn't assume the terminal stays open.

## When NOT to loop

- One-off or exploratory work, or anything ambiguous enough that the next step is
  a judgment call you'd want to make yourself.
- No trustworthy self-verification — an open loop with no feedback is a machine for
  confident mistakes.
- High blast-radius autonomous actions (anything near the hard gates).

## The spectrum (pick the right kind)

`ReAct` (reason→act→observe while-loop, human watching) → `AutoGPT` (self-prompting
toward a goal; famously ran forever) → `ralph` (pipe one fixed prompt repeatedly,
resetting context to anchor files each time) → `/goal` (ralph gated by a validator
that confirms done) → **orchestration** (loops supervising other loops, scheduled,
durable). Single-agent ralph is simple and cheap; multi-agent supervision is the
heavy end — only go there when the task genuinely needs it.

## Guardrails (mandatory if you set one up)

The interesting engineering is everything that keeps the loop from running off a
cliff. Every serious loop has:

- **Self-verification each tick** — write → run → read result → correct.
- **Hard stops** — a max iteration count, **no-progress detection**, and a token/$
  **budget ceiling**. Most of the job is making the loop halt. (Real teams have
  burned annual AI budgets in months to runaway loops.)
- **Skills, not re-derived prompts** — a loop that calls sharp, named skills
  compounds; one that re-derives everything just burns money. If a sub-task
  recurs, extract a skill and have the loop call it.
- **Durable state** — git-backed, crash-recoverable.

## The hard line: loops stop at the gates

A loop runs autonomously *inside the work* but must **stop for human approval at
the hard gates** (merge, publish, destructive ops, the read-only source repos —
see `AGENTS.md`). Autonomy in the body; alignment at the edges. A loop never
merges or publishes on its own.

## How to set one up

**Any runtime:** state the *intent* and the *stopping behavior* (not the steps);
define the per-tick self-check; set an iteration cap and a budget ceiling; point
it at a fixed set of anchor files; make state durable.

**Claude Code mechanisms:**
- `/loop` — run a prompt or skill on an interval or self-paced (e.g. *"babysit my
  PRs, auto-fix build issues, address review comments in a worktree"*).
- `/goal` — keep going until a validator confirms done.
- dynamic workflows — orchestrate many agents for one task.
- cloud + auto-mode permissions — unattended runs with the laptop closed.

**Codex mechanisms:** Codex has no built-in loop command. Drive iterations from
outside: re-invoke `codex exec` from a shell loop, cron / Task Scheduler, or CI
with an explicit iteration cap, and keep loop state in a file each run reads and
updates. Cloud tasks can be re-run for unattended iterations.

**Always (any runtime):** a way to self-verify end to end, plus the caps above.

## Recommend, then confirm

Loops are a recommendation. Propose the loop — what it does, its stopping
behavior, its budget — and get the human's go-ahead before kicking off an
autonomous or scheduled run. Starting one is a durable/outward action: it gets a
gate like any other.

---

*Concept from the 2026 Steinberger/Cherny "what is a loop" discourse: the loop,
not the model, is now the expensive part — so the discipline is feedback and
halting.*
