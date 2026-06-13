# CLAUDE.md

**Read [AGENTS.md](AGENTS.md) first — it is the contract for every agent and it
governs you.** This file only adds Claude Code specifics. Starting fresh? Begin
from [HANDOFF.md](HANDOFF.md).

## Ultraplan — how Claude satisfies the plan+alignment gate

AGENTS.md requires a written, human-approved plan before any merge (runtime-
agnostic). **Ultraplan is Claude's mechanism for it** — it lives here, not in
AGENTS.md. It maps to **plan mode**:

- For any substantial change or branch you intend to merge, **enter plan mode**,
  build the ultraplan (intent · blast radius · verification · out-of-scope ·
  alignment), and present it via **ExitPlanMode for explicit approval _before_
  implementing or merging.**
- Do not merge on implied approval. "Looks good" on the work ≠ approval of the
  plan. The human signs off on the plan; the merge follows the signed-off plan.
- If the implementation drifts from the approved plan, stop and re-align — present
  the delta and get approval again. Never merge-then-explain.
- For large or risky changes, you may use a planning subagent / the Plan agent to
  draft the ultraplan, but the human approval gate is the same.

## Loops — Claude's mechanisms

AGENTS.md says *work in loops when possible*. Claude's tools for it:

- **`/loop`** — run a prompt or skill on an interval or self-paced (e.g. "babysit
  my PRs, auto-fix build issues, address review comments in a worktree").
- **`/goal`** — keep going until a validator confirms the task is done.
- **dynamic workflows** — orchestrate many agents for one task.
- **cloud + auto-mode** — run unattended with the laptop closed.

Always give the loop a way to **self-verify end to end**, and cap it (iterations,
no-progress, budget). The loop still honors every AGENTS.md hard gate — it stops
for the plan+alignment merge gate and for publishing. Don't loop across the edges.

## Skills

`tropo` ships an agent skill at
[packages/tropo/.claude/skills/tropo/SKILL.md](packages/tropo/.claude/skills/tropo/SKILL.md)
— use it to drive the knowledge-graph CLI (check / signal / fix / types / stats).

## Keep it lean

This file and AGENTS.md are always-on. Honor the minimalism law — if you're
tempted to add process here, put the depth in `docs/` and link it instead.
