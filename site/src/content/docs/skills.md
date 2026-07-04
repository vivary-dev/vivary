---
title: "Agent skills"
description: "The strato, tropo, and loops skills that operate a Vivary workspace."
---


Vivary ships **agent skills**: load-on-demand procedures that tell an agent *how* to
operate the workspace. They live next to the workspace (`.claude/skills/` for Claude
Code, `.agents/skills/` for Codex) and load only when relevant, so they cost nothing
until needed (the minimalism law). A generated workspace includes the **strato** and
**loops** skills; the **tropo** skill ships with the tropo package. Coding workspaces
created with `--active-context cocoindex-code` also include the optional
**active-context** skill.

Skills follow the same DRY/progressive-disclosure rule as module indexes: the skill is
the procedure's source of truth, while `AGENTS.md` and `modules/**/index.md` only route
to it.

A skill is a `SKILL.md` (a short prompt + when-to-use) plus optional `references/` that
load on demand. You invoke one by asking for it in plain language (the triggers below)
or, in Claude Code, with `/skill-name`.

---

## strato — the agent-OS skill

**What it's for:** bootstrap, maintain, and continuously improve a workspace so each
session adds momentum the next inherits. Three modes:

### `bootstrap` — first time in a workspace
Use when `SOUL.md` / `USER.md` / `STATE.md` are unpopulated, or you say *"bootstrap the
workspace"* / *"set up the brain"*.

Procedure: **explore → interview → confirm → write.** It interviews you (3 / 5 / 8 / 10
questions deep) about who you are, the shape of the work, cadence, and gates, then
populates the shell files. It never overwrites without showing you first.

### `heartbeat` — periodic audit
Use on a cadence or when you say *"run a heartbeat"* / *"audit the workspace"*. Two
flavors: **light** (read-only findings) and **deep** (interactive cleanup, per-item
prompts). It surfaces stale folders, cross-project bleed, skill candidates, dead skills,
automation drift, and playbook gaps.

### `self-improve` — capture, extract, package
Use after a slice/bug/handoff or when you say *"this happened again"*. Three procedures:
- **bug-risk playbook** — when a *class* of bug bites twice, add a `cause → prevention`
  row to `bug-risk-playbook.md`. Self-healing.
- **third-strike skill rule** — when a workflow fires a *third* time, extract it into a
  skill (which becomes the source of truth; prompts and memory mirror it).
- **workflow packaging** — turn a repeated multi-step flow into a reusable skill/plugin.

**Triggers:** "bootstrap the workspace", "set up the brain", "run a heartbeat", "audit
the workspace", "tend the workspace", "this happened again", "strato".

**Gates (never batched):** never delete/move a file without per-item confirmation; never
modify SOUL/USER/AGENTS after bootstrap or change an existing skill without approval;
never publish/push/send externally without explicit approval.

---

## tropo — the knowledge-graph skill

**What it's for:** manage a Markdown knowledge base (or any repo's docs) under the
folder-as-type schema. Survey → see the truth → check → decide → re-run until clean.

It drives the tropo CLI: `check`, `signal` (irreducible metadata only), `types`,
`stats`, `fix`, `init`. Core idea it teaches: a file with **no frontmatter at all is
valid** if its type has no required fields — metadata is only the irreducible signal.

When `check` complains, the skill helps you decide whether to **fix the files** or
**fix the rules** (the `tropo.toml`):
- a flood of `W210` → run `tropo fix` (safe de-noise);
- a flood of `W201` (untyped) → move files under a type root, or add a type;
- a flood of `W202` (unknown field) → the schema is behind reality; add the field;
- `E101`/`E103` → genuine gaps in irreducible metadata; fill them *with the user*.

**Triggers:** "check the vault", "enforce a schema on my notes", "what types do I have",
"set up tropo here", "de-noise my frontmatter", "add a type", "tropo".

---

## loops — running unattended, safely

**What it's for:** recognizing when an agent **loop** (a program that re-prompts the
agent and decides whether to continue) is a good idea — and how to set one up without it
going off the rails. It's a *recommend-when-it-fits* tool, never a default.

Recommend a loop only when the work is **repeatable, long-running, or unattended** AND
there's a **trustworthy self-check** AND **durable state**. Don't loop one-off work, work
with no reliable verification, or high-blast-radius autonomous actions.

Every loop must **self-verify each tick** and have **hard stops** (max iterations,
no-progress detection, budget ceiling) — and it still **stops at the human gates**
(merge, publish, destructive ops, read-only sources). Autonomy inside the work,
alignment at the edges.

**Triggers:** "should I loop this", "set up a loop", "run this repeatedly", "babysit my
PRs", "run it unattended".

---

## active-context — optional semantic code retrieval

**What it's for:** deciding whether a Vivary-backed codebase should use an optional
CocoIndex-code sidecar for semantic code search. It keeps Vivary's graph-first loop in
charge, then uses `ccc search` when exact names are unknown or `rg` is not enough. For
a compact copy/paste version, use [LLM-ACTIVE-CONTEXT.md](/llm-active-context/).

The skill asks before installing, initializing, indexing, enabling MCP, or using an
external embedding provider. Those are Vivary gates. Once approved, it retrieves in
this order:

1. `tropo find "<task>" --budget 1200 --json` for a small read-first packet.
2. `tropo graph` / `tropo blast <id>` / `ozone impact <id>` for workspace truth.
3. `uv tool install --python 3.11 --upgrade "cocoindex-code[full]"`, then
   `ccc init -f`, `ccc doctor`, and `ccc index` if the sidecar is not already ready.
4. `ccc search --refresh "<query>"` for semantic code candidates.
5. Direct file reads around returned line ranges.
6. Project tests plus `tropo check` / `ozone review` before a gate.

**Triggers:** "CocoIndex", "ccc", "active context", "semantic code search", "find
where this is implemented", "search the codebase", or code work where grep is too
thin/noisy.

Generated only by:

```bash
create-vivary init my-codebase --preset coding --active-context cocoindex-code
```

---

## Writing your own skill

The `self-improve` third-strike rule is the intended path: when *you* repeat a workflow
three times, capture it as a `SKILL.md` in the workspace's `.claude/skills/<name>/` (and
`.agents/skills/<name>/`). Keep it lean — a short prompt + when-to-use, with depth in
`references/` that load on demand. The skill becomes the source of truth; don't
duplicate it into prompts or memory. If the workflow belongs to one project area, link
the skill from that area's `modules/<id>/index.md` instead of copying the procedure
there.
