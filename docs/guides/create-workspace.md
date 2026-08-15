# Create a Vivary workspace

Use this guide for a new project or an empty directory.

## Result

Vivary creates the published 0.3.1 full-layout scaffold.
The workspace includes agent operating files, a starter typed graph, and skill
surfaces.

## Release boundary

These commands pin **published 0.3.1**.
Do not use unpinned `latest`.
Do not use a checkout script unless you are inspecting unpublished 0.4.2.

## Agent contract

| Field | Value |
|---|---|
| Goal | Create one published 0.3.1 workspace. |
| Required input | Target directory and preset. |
| Default authority | Create the full-layout scaffold. |
| Prohibited action | Do not install unpublished 0.4.2. Do not copy a checkout path. |
| Proof | Doctor and Tropo checks pass. |

## 1. Check the target

Use `init` only for a new project or an empty directory.
If the target contains project files, use [Adopt an existing project](adopt-project.md).

## 2. Select a preset

Select one preset that matches the work.

| Preset | Use |
|---|---|
| `coding` | Software, tests, documentation, and release work. |
| `second-brain` | Personal notes, sources, decisions, and retrieval. |
| `knowledge-work` | Research, decisions, artifacts, and proof. |
| `writing` | Drafts, research, reviews, and publication gates. |

## 3. Create the workspace

```bash
uvx --from create-vivary==0.3.1 create-vivary init C:/path/to/my-project --preset coding --no-wizard
```

Or from npm:

```bash
npx --yes @vivary/create@0.3.1 C:/path/to/my-project -- --preset coding --no-wizard
```

Published 0.3.1 writes the full-layout scaffold.
A coding proof run wrote 38 files: `AGENTS.md`, `STATE.md`, `SOUL.md`, `tropo.toml`,
starter graph folders, and Claude/Codex skill surfaces.
See the [published 0.3.1 proof](../WALKTHROUGH.md).

This is not the unpublished five-file 0.4.2 seed.

## 4. Verify the workspace

```bash
uvx --from create-vivary==0.3.1 create-vivary doctor C:/path/to/my-project
uvx --from vivary-tropo==0.4.1 tropo check --root C:/path/to/my-project
```

Both commands must exit with code `0`.
Fix each error before an agent uses the workspace.

## Stop conditions

Stop when the target is nonempty.
Stop when a planned file can replace user content.
Stop when provider installation needs approval.

Use [Getting started](../GETTING-STARTED.md) for the install pins.
Use the [command reference](../COMMANDS.md) for flags and output fields.
