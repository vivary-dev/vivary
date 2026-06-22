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

## Loops

Loops are a recommend-when-it-fits tool, not a default. The **loops skill**
(`.claude/skills/loops/`) covers when to recommend one and how to set it up with
Claude's mechanisms (`/loop`, `/goal`, dynamic workflows, cloud + auto-mode).
Always self-verify and cap; a loop still stops at the hard gates.

## Skills & docs

`tropo` ships an agent skill at
[packages/tropo/.claude/skills/tropo/SKILL.md](packages/tropo/.claude/skills/tropo/SKILL.md)
(drives the graph CLI); `strato` and `loops` ship with generated workspaces. Full
reference — every command, skill, how-to, and FAQ — lives in
[docs/](docs/) ([SKILLS](docs/SKILLS.md) · [COMMANDS](docs/COMMANDS.md) ·
[HOWTO](docs/HOWTO.md) · [FAQ](docs/FAQ.md)). Current release truth lives in
[README.md](README.md) and [CHANGELOG.md](CHANGELOG.md).

## Keep it lean

This file and AGENTS.md are always-on. Honor the minimalism law — if you're
tempted to add process here, put the depth in `docs/` and link it instead.
