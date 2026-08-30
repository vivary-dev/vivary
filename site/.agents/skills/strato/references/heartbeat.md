# Heartbeat — periodic audit

Two flavors: **light** (read-only findings, ~5 min, scheduled daily) and **deep**
(interactive cleanup with per-item prompts, weekly). Light reports; deep acts, with
confirmation.

## Check, in order

1. **Stale folders** — untouched 30+ days. Report path, last-modified, size, one-line
   purpose guess. Deep: per folder ask **archive / delete / keep / defer**.
2. **Cross-project bleed** — files that belong to a different project (code in a content
   folder, drafts in a code repo, a skill used from outside its owner). Report file →
   suspected home → proposed move. Never move without confirmation.
3. **Skill candidates (third-strike)** — scan the last 30 days of `memory/<date>.md`
   for sequences sharing ≥3 of {same trigger, same steps, same output shape}. Light:
   list them. Deep: offer to scaffold (see self-improvement.md).
4. **Workflow-plugin candidates** — meet all three plugin criteria (fired >3×,
   coordinates multiple files/tools/agents, would benefit from scripts or hooks).
   Surface separately — a bigger commitment than a skill.
5. **Automation / subagent hygiene** — automations not fired in 30+ days or erroring;
   idle/leaked subagents pointing at closed work.
6. **Inbox / group-chat freshness** (multi-agent) — unread messages >7 days;
   group-chat past ~30 entries (archive); entries that contradict current state.
7. **Skills review** — per skill: last edit, last invoked, does the `description` match
   actual use, overlaps to merge, retirement candidates.
8. **Playbook / lesson capture** — recent failure patterns not yet in
   `bug-risk-playbook.md` → propose rows (self-improvement.md). This is the self-heal.
9. **Open decisions** — surface anything pending (e.g. a `PROPOSAL.md`).

## Report

Write one private, gitignored file, `heartbeat-reports/YYYY-MM-DD-heartbeat.md`, with
sections in the order above (run summary first). Treat it as PRIV because it may
contain memory-derived findings; do not copy report content into public files, PRs, or
external tools. Then summarize in chat in three lines max: how many things need
attention, how many were resolved (deep), what to look at first.

## Boundaries

- Never delete without a **typed-name** confirmation; never move without showing
  source → destination.
- Never auto-create a skill / hook / command / plugin — show the shape first.
- Multi-agent: write decisions to `agents/group-chat.md` so others see them before the
  next session.
- If yesterday's report left decisions unresolved, repeat them at the top of today's.

## After a deep run

Append one line to `MEMORY.md`: "Heartbeat YYYY-MM-DD: <n> stale resolved, <n> skill
candidates accepted, <n> deferred." Link any skill or playbook entry created, and
verify a new skill's `description` will actually trigger on its intended use.
