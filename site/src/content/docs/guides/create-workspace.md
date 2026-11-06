---
title: "Create a Vivary workspace"
description: "Create and verify the five-file Vivary governed-context workspace for a new project without adding starter content."
editUrl: "https://github.com/vivary-dev/vivary/edit/dev/docs/guides/create-workspace.md"
---

Use this guide for a new project or an empty directory.

## Result

Vivary creates a five-file governed workspace.
The workspace contains no starter records, templates, skills, or second-brain content.

## Release boundary

These commands describe published 0.4.2.
The examples pin the verified command versions. Unpinned PyPI installs can resolve newer versions.
Pin `create-vivary==0.3.1` only to get the historical full layout.

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
uvx --from create-vivary==0.4.2 create-vivary init C:/path/to/my-project --preset coding --no-wizard --dry-run --json
```

Confirm the target, preset, contract, and five planned files.
Stop if the target contains work that Vivary can overwrite.

## 4. Create the workspace

Run the same command without `--dry-run`.

```bash
uvx --from create-vivary==0.4.2 create-vivary init C:/path/to/my-project --preset coding --no-wizard --json
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
uvx --from create-vivary==0.4.2 create-vivary doctor C:/path/to/my-project
uvx --from vivary-tropo==0.5.3 tropo check --root C:/path/to/my-project
```

Both commands must exit with code `0`.
Fix each error before an agent uses the workspace.

## Optional second-brain example

Preview the policy before creation.

```bash
uvx --from create-vivary==0.4.2 create-vivary init C:/path/to/my-notes --preset second-brain --no-wizard --dry-run --json
uvx --from create-vivary==0.4.2 create-vivary init C:/path/to/my-notes --preset second-brain --no-wizard --json
```

The result is still the five-file seed.
Real notes must come from later work.

## Optional additions

Include an adapter in the initial command only when the runtime needs it.

```bash
uvx --from create-vivary==0.4.2 create-vivary init C:/path/to/my-agent-project --preset coding --adapter agents --no-wizard
uvx --from create-vivary==0.4.2 create-vivary init C:/path/to/my-claude-project --preset coding --adapter claude --no-wizard
```

Each adapter adds one bounded runtime file.
Use `--adapter` twice when both adapters are required.

Include active code context only after explicit selection.

```bash
uvx --from create-vivary==0.4.2 create-vivary init C:/path/to/my-code-project --preset coding --active-context cocoindex-code --no-wizard
```

This option keeps the five-file seed.
It declares the capability and ignores its local index path.
It does not copy guidance, install an indexer, or create an index.

## Stop conditions

Stop when the target is nonempty.
Stop when a planned file can replace user content.
Stop when provider installation needs approval.
Stop when privacy policy is missing or invalid.

Use the [command reference](/commands/#create-vivary--the-scaffolder) for all flags and output fields.

## File roles in Vivary-New source

The Vivary-New source adds optional metadata to `.vivary/workspace.toml`.
This section describes the development source, not the published 0.4.2 command.
A role names a file's purpose. A pattern supplies a set of default assignments.

| Role | Purpose |
| --- | --- |
| `law` | Instructions and policy |
| `map` | Navigation to relevant files |
| `record` | Durable decisions or completed-work records |
| `memory` | Reusable knowledge |
| `boundary` | Paths that describe privacy and runtime separation |

The only supported pattern is `thin-context`. All four presets use this base:

```toml
[workspace.vivary]
version = 1
patterns = ["thin-context"]

[workspace.vivary.roles]
law = ["AGENTS.md", ".vivary/context.md"]
map = [".vivary/context.md"]
record = []
memory = []
boundary = [".gitignore", ".vivary/private", ".vivary/runtime"]
```

The map assignment refers to the context file's existing Routes section.
It does not introduce a generated inventory. Empty lists explicitly describe
absent roles. Multiple roles can reference the same file.

Assign exact workspace-relative paths, such as `notes/[Q3] review.md`.
Assignments describe paths without opening them, creating files, or granting
access. Existing privacy exclusions and required thin files remain mandatory,
even when a role is empty. `STATE.md` remains authored state.

Without `workspace.vivary`, valid assignments from the previous
`workspace.patterns` and `workspace.roles` schema remain readable. Unrecognized
generic extensions stay ignored and use the `thin-context` defaults. The
versioned Vivary table validates its metadata strictly. The default boundary
also includes declared capability storage, such as `.cocoindex_code`.
Doctor reports valid roles even when unrelated workspace health checks fail.
Set `patterns = []` to omit its default assignments, then provide any desired
role overrides. Overrides replace that role's list. Doctor JSON exposes the
effective result as `workspace_roles`, including empty lists.

These fields do not change presets, generate starter content, or load memory
into conversations. Follow [the program frontier](https://github.com/vivary-dev/Vivary-New/blob/dev/docs/product/multi-project/index.md)
for the setup and persistence work that consumes this metadata.
