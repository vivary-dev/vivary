---
title: "Create a workspace"
description: "Create and verify the five-file Vivary seed for a new project."
editUrl: "https://github.com/vivary-dev/vivary/edit/dev/docs/guides/create-workspace.md"
---

Use this guide for a new project or an empty directory.

## Result

Vivary creates a five-file governed workspace.
The workspace contains no starter records, templates, skills, or second-brain content.

## Release boundary

These commands describe the unpublished 0.4.0 source candidate.
Registry `latest` still installs published 0.3.1 and creates the historical full layout.
Run these commands from the Vivary source checkout root.

## Agent contract

| Field | Value |
|---|---|
| Goal | Create one minimal governed workspace. |
| Required input | Target directory and preset. |
| Default authority | Create the five-file seed. |
| Optional authority | Add only the selected bounded adapter or sidecar. |
| Prohibited action | Do not install providers, create records, or copy starter packs. |
| Proof | Doctor and Tropo checks pass. |

## 1. Check the target

Use `init` only for a new project or an empty directory.
If the target contains project files, use [Adopt an existing project](/guides/adopt-project/).

## 2. Select a preset

Select one preset that matches the work.
Each preset creates the same five files.
A preset changes policy labels only.

| Preset | Use |
|---|---|
| `coding` | Software, tests, documentation, and release work. |
| `second-brain` | Personal notes, sources, decisions, and retrieval. |
| `knowledge-work` | Research, decisions, artifacts, and proof. |
| `writing` | Drafts, research, reviews, and publication gates. |

The `second-brain` preset does not create notes or a pre-populated second brain.

## 3. Preview the workspace

Run a dry-run before the first write.

```bash
python packages/create-vivary/create_vivary.py init C:/path/to/my-project --preset coding --no-wizard --dry-run --json
```

Confirm the target, preset, contract, and five planned files.
Stop if the target contains work that Vivary can overwrite.

## 4. Create the workspace

Run the same command without `--dry-run`.

```bash
python packages/create-vivary/create_vivary.py init C:/path/to/my-project --preset coding --no-wizard --json
```

Vivary creates this tree:

```text
my-project/
├── .gitignore
├── AGENTS.md
├── STATE.md
└── .vivary/
    ├── context.md
    └── workspace.toml
```

`AGENTS.md` routes the agent to governed context.
`STATE.md` shows the current focus, status, and next action.
`.gitignore` protects private and runtime paths.
`.vivary/context.md` defines the work loop and gates.
`.vivary/workspace.toml` defines the thin contract and type policy.

## 5. Verify the workspace

Run Doctor.
Then run Tropo validation.

```bash
python packages/create-vivary/create_vivary.py doctor C:/path/to/my-project
python packages/tropo/tropo.py check --root C:/path/to/my-project
```

Both commands must exit with code `0`.
Fix each error before an agent uses the workspace.

## Optional second-brain example

Preview the policy before creation.

```bash
python packages/create-vivary/create_vivary.py init C:/path/to/my-notes --preset second-brain --no-wizard --dry-run --json
python packages/create-vivary/create_vivary.py init C:/path/to/my-notes --preset second-brain --no-wizard --json
```

The result is still the five-file seed.
Real notes must come from later work.

## Optional additions

Include an adapter in the initial command only when the runtime needs it.

```bash
python packages/create-vivary/create_vivary.py init C:/path/to/my-agent-project --preset coding --adapter agents --no-wizard
python packages/create-vivary/create_vivary.py init C:/path/to/my-claude-project --preset coding --adapter claude --no-wizard
```

Each adapter adds one bounded runtime file.
Use `--adapter` twice when both adapters are required.

Include active code context only after explicit selection.

```bash
python packages/create-vivary/create_vivary.py init C:/path/to/my-code-project --preset coding --active-context cocoindex-code --no-wizard
```

This option adds two guidance files.
It does not install or run an indexer.

## Stop conditions

Stop when the target is nonempty.
Stop when a planned file can replace user content.
Stop when provider installation needs approval.
Stop when privacy policy is missing or invalid.

Use the [command reference](/commands/#create-vivary--the-scaffolder) for all flags and output fields.
