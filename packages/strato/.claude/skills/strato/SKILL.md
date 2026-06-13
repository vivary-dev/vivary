---
name: strato
description: >-
  Bootstrap, maintain, and continuously improve a Vivary agent workspace so each
  session adds momentum the next inherits. Lays down the workspace's shared brain
  (SOUL/USER/AGENTS/MEMORY/STATE) from strato's templates, runs periodic heartbeats
  to surface stale folders and skill candidates, captures recurring bugs into a
  self-healing playbook, and extracts a skill once a workflow repeats a third time.
  Use when starting a new workspace, when something keeps biting, when a workflow has
  fired three times, or when the user says "bootstrap the workspace", "set up the
  brain", "run a heartbeat", "audit the workspace", "tend the workspace", "this
  happened again", or "strato".
---

# strato — the agent OS skill

strato's model is the per-turn loop (`STRATO.md`). This skill is the executable for the
loop's **slower clock** — the per-heartbeat work that makes a workspace *compound*:
set the workspace up, audit it on a cadence, and turn what was learned into durable
improvement. Read [`../../../STRATO.md`](../../../STRATO.md) for the model.

It never re-embeds file contents: the workspace's starter files live in strato's
[`templates/`](../../../templates/) directory and are the single source of truth.

Three modes — pick by the workspace state and the request.

## `bootstrap` — first time in a workspace

Use when `SOUL.md` / `USER.md` / `AGENTS.md` / `MEMORY.md` / `STATE.md` are missing at
the workspace root, or the user says "set up the workspace".

Procedure: **explore → interview → confirm → write**, laying down the `templates/`
populated with the user's answers. The interview uses the loop's opener (`I think I
know / I am inferring / I do not know / please confirm`) at the chosen depth (3 / 5 / 8
/ 10 questions). Full steps in [references/bootstrap.md](references/bootstrap.md).

## `heartbeat` — periodic audit

Use on a schedule or when the user says "run a heartbeat" / "audit the workspace". Two
flavors: **light** (read-only findings report) and **deep** (interactive cleanup,
per-item prompts). Surfaces stale folders, cross-project bleed, skill candidates, dead
skills, automation drift, and playbook gaps. Checklist + report format in
[references/heartbeat.md](references/heartbeat.md).

## `self-improve` — capture, extract, package

Use after a slice, a bug, or a confusing handoff, or when the user says "this happened
again" / "package this into a skill". Three procedures — the bug-risk playbook, the
third-strike skill rule, and workflow-plugin packaging — in
[references/self-improvement.md](references/self-improvement.md).

## 🚦 Gates (mirror STRATO.md — never batch)

- **Never delete or move** a file without showing paths and getting per-item
  confirmation (require the user to type the name for a delete).
- **Never modify** `SOUL.md` / `USER.md` / `AGENTS.md` after bootstrap, or change an
  existing skill, without approval.
- **Never publish, push, or send externally** without explicit per-item approval.
- Creating a new SOP/skill/plugin: show the draft first.

## Done means

- The workspace has a discoverable shared brain (the `templates/` files, populated)
  that survives a session restart.
- The latest heartbeat report is within the configured cadence.
- Lessons from the last session landed in `bug-risk-playbook.md` or a skill — not just
  in chat.
- Any third-strike workflow this session became a skill, a plugin, or an explicit "no".
