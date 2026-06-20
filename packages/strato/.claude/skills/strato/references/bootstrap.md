# Bootstrap — first-time workspace setup

Prompt-driven, not a script: **explore → interview → confirm → write.** You lay down
strato's `templates/` populated with the user's answers. Do **not** re-embed template
contents here — `templates/` is the single source of truth.

## 1. Explore

Read what's there before assuming anything is missing:

- Workspace root: `SOUL.md`, `USER.md`, `AGENTS.md`, `MEMORY.md`, `STATE.md`, `README.md`
- Progressive routers: `modules/index.md`, then only the relevant
  `modules/<id>/index.md`
- `memory/` — daily notes? an `agents/` subfolder?
- Inventory only: `docs/`, `.claude/skills/` (or `.agents/skills/`),
  `heartbeat-reports/`; do not bulk-read them
- `git remote -v` — is this a repo, and where does it push?

Note what exists vs. missing. Don't write yet.

## 2. Interview

Open with the loop's stance:

```md
I think I know:
I am inferring:
I do not know:
Please confirm or correct:
```

Depth: low **3q** · medium **5q** (default) · in-depth **8q** · grill **10q**, then
Gate. Each question gets a one-sentence plain-language explainer so the user can answer
without already knowing the term. Cover:

- **Owner identity** (→ `USER.md`): name, timezone, role, the few preferences that
  most change agent behavior.
- **Workspace shape**: single- vs multi-project; bucket folders (`active/`,
  `archived/`, …)?
- **Single- vs multi-agent**: if multi, scaffold `agents/inbox/`, `agents/group-chat.md`,
  and per-agent memory + a shared contract.
- **VS target & cadence** (→ `STATE.md`): daily · session-end · milestone · manual.
- **Heartbeat cadence**: default daily light + weekly deep.
- **Issue tracker**: only if a remote is obvious or the user raises it.

## 3. Confirm

Show a draft of every file you'll create or modify; let the user edit first. For files
that already hold non-template content, go diff-style ("I'd add this section, leave the
rest") and get per-file approval. Never overwrite.

## 4. Write

Lay each workspace file down from strato's `templates/`, populated with the answers:

| Workspace file | From template | Note |
|---|---|---|
| `SOUL.md` | `templates/SOUL.md` | personality; evolve freely |
| `USER.md` | `templates/USER.template.md` | **private — gitignore it** |
| `AGENTS.md` | `templates/AGENTS.md` | the workspace contract |
| `MEMORY.md` | `templates/MEMORY.template.md` | **private — gitignore it** |
| `STATE.md` | `templates/STATE.template.md` | the visible state surface |
| `bug-risk-playbook.md` | `templates/bug-risk-playbook.md` | self-healing seed |

If multi-agent, also create `agents/inbox/`, `agents/group-chat.md`, and the shared
agent contract. Ensure `USER.md` / `MEMORY.md` / `memory/*` are gitignored (privacy
gate).

## 5. Wire the heartbeat

If the runtime supports scheduled tasks, set up daily light + weekly deep heartbeats
(strato skill, `mode: heartbeat`). Otherwise document the cadence in `AGENTS.md`.

## 6. Done

Tell the user what landed, what was skipped, what to review. Append one line to
`MEMORY.md`: "Bootstrapped YYYY-MM-DD, shape: <single|multi>-agent /
<single|multi>-project." Confirm the privacy boundary holds (no PRIV committed).

**Gate before:** dependency installs, `git init`/`push`, enabling active hooks,
indexing sensitive material, any external or public export.
