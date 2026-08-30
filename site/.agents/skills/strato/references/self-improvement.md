# Self-improvement — capture, extract, package

Three procedures for turning what just happened into durable improvement. Thresholds
keep this from becoming overhead theater: **most sessions produce none of these.** A
clean slice with no surprises just gets closed out.

## A. Bug-risk playbook (self-healing)

When a *class* of failure appears more than once, add a row to the workspace's
`bug-risk-playbook.md` so the next session prevents it.

- **When:** the same *class* of bug fires twice (not the same instance); a handoff
  confused two agents in a repeatable way; an assumption was wrong in a way that
  affects more than one task. Not one-offs.
- **Row shape:** `| Bug | Likely cause | Prevention |`. The Prevention cell is concrete
  and runnable/checkable — a test name, a config setting, a startup check — never "be
  more careful."
- **Procedure:** name the *class* not the instance → state the likely cause in one line
  → state the prevention as something checkable → append the row. If the bug revealed a
  contract gap, update the relevant spec too.

## B. Third-strike skill rule (extraction)

A workflow earns a skill on its **third** occurrence. First = exploration, second =
coincidence, third = pattern.

- **Detect:** scan the last 30 days of `memory/<date>.md` for sequences sharing ≥3 of
  {same trigger, same steps in roughly the same order, same output shape}. Shape, not
  word-for-word.
- **Scaffold** (once the user agrees): pick a lowercase action-led slug; write a
  third-person `description` with the real trigger phrases the user says; body uses
  what fits of Purpose / Process / Boundaries / Done-means; 90% signal; references one
  level deep when content exceeds ~150 lines; bundle a `scripts/` only for deterministic
  operations.
- **Scope:** default project-scoped; promote to global only after more than one project
  uses it and it depends on no single project's files. Easy to promote, hard to demote.
- **Mirror rule:** once a skill exists it is the source of truth — prompts and memory
  *mirror* it, never duplicate (duplication drifts).

## C. Workflow-plugin packaging

A **plugin** is a skill plus the deterministic infrastructure that makes it
self-enforcing (scripts, hooks, commands). Earn it only when **all three** hold:

1. the workflow has fired more than three times,
2. it coordinates multiple files, tools, or agents, and
3. it would benefit from deterministic scripts (saving tokens) or hooks (enforcing an
   invariant the agent shouldn't have to remember).

If only #1 is true, write a skill — plugins are heavier. Layout: `SKILL.md` +
`scripts/` + (runtime-permitting) `hooks/` + `commands/` + `references/` + `README.md`.
Convert each repeated deterministic step to a script; write safety-critical or
often-forgotten invariants as hooks; document what the plugin owns. Test on the next
real instance — if a script fails, fix the script, not the skill that calls it. Don't
publish speculative plugins; publish ones with a track record.

## What this is NOT

Not a ritual where every session spawns a playbook entry, a skill, and a plugin. The
thresholds (twice for the playbook, three times for a skill, three-times-plus-multi-tool
for a plugin) exist precisely so the workspace doesn't fill with speculative
scaffolding nobody invokes.
