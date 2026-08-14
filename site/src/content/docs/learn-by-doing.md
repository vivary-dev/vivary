---
title: "Vivary guides"
description: "Task-based Vivary guides for creating or adopting a workspace, connecting agents, retrieving context, writing records, and recovering safely."
editUrl: "https://github.com/vivary-dev/vivary/edit/dev/docs/LEARN-BY-DOING.md"
---

Use these Vivary guides to complete one governed workspace task at a time.
Each page is the canonical human-and-agent procedure that the public site renders.
The guides use STE100 style.
Each procedure is concise, direct, and safe to copy.

The complete guide set is thorough.
Each guide keeps one task boundary.
The command reference keeps exhaustive flags, schemas, limits, and exit codes.

## Release boundary

The guide library describes the unpublished 0.4.2 source candidate.
Registry `latest` still installs published 0.3.1.
Use the [release-status table](https://github.com/vivary-dev/vivary/blob/dev/README.md#release-status) as the publication authority.

The [historical proof](/walkthrough/) records the published 0.3.1 full layout.
Do not use that 38-file fixture as the thin-workspace expectation.

## Command route

Before release, run each guide from the Vivary source checkout root.
Use these source commands:

```bash
python packages/create-vivary/create_vivary.py
python packages/tropo/tropo.py
```

The non-governed guide commands include these source paths.
Replace each example workspace path with the intended absolute path.

Governed capsule and record commands need an isolated candidate environment.
Get approval before you create or change that environment.

Create the environment on Windows:

```powershell
python -m venv C:/path/to/vivary-candidate
C:/path/to/vivary-candidate/Scripts/python.exe -m pip install ./packages/core ./packages/tropo ./packages/create-vivary
C:/path/to/vivary-candidate/Scripts/Activate.ps1
```

Create the environment on macOS or Linux:

```bash
python -m venv /path/to/vivary-candidate
/path/to/vivary-candidate/bin/python -m pip install ./packages/core ./packages/tropo ./packages/create-vivary
source /path/to/vivary-candidate/bin/activate
```

Use that environment for every `--governed` or `record` command.
Do not use the published 0.3.1 command for these candidate procedures.

After 0.4.2 is published, use `create-vivary` and `tropo` directly.
Do not use unversioned registry `latest` before publication.

## Choose a guide

| Task | Guide | Result |
|---|---|---|
| Start a new project | [Create a Vivary workspace](/guides/create-workspace/) | Create the five-file seed. |
| Give an agent context | [Connect an agent to Vivary](/guides/connect-agent/) | Use the standard route or optional MCP. |
| Retrieve evidence | [Get bounded context](/guides/get-context/) | Return task context or a Task Capsule. |
| Preserve earned context | [Write one approved record](/guides/write-record/) | Apply one capsule-bound record. |
| Add Vivary to a project | [Adopt an existing project](/guides/adopt-project/) | Apply a bounded brownfield plan. |
| Prove health | [Verify and recover a workspace](/guides/verify-recover/) | Validate health and use explicit recovery. |

## Use the guides in this order

For a new project:

1. Create the workspace.
2. Verify the five-file seed.
3. Connect the selected agent.
4. Retrieve bounded context.
5. Complete real work.
6. Verify the result.
7. Write one record only when the work earns it.

For an existing project:

1. Preview adoption.
2. Review conflicts and privacy.
3. Get approval for the exact plan hash.
4. Apply the approved plan.
5. Verify the adopted workspace.
6. Connect the selected agent.

## Shared guide format

Each guide contains these parts:

- result
- agent contract
- required input
- exact procedure
- expected output
- files or state that can change
- refusal conditions
- verification
- recovery
- links to the canonical reference

Humans and agents use the same canonical guide.
The public site renders these Markdown files.
The agent indexes expose the same content.

Do not create a second agent manual.
Do not copy guide text into workspace seeds.
Do not add guide packs during init, adoption, MCP startup, or retrieval.

## Authority summary

Default retrieval is read-only.
The `--receipt` option writes a local privacy-preserving receipt.
MCP is read-only and optional.
Plain Doctor is read-only.
Init creates the approved new-workspace seed.
Adoption needs an exact approved plan hash.
Record apply needs a capsule and exact approved plan hash.
Recovery needs the exact reported transaction hash.

Publishing, external writes, destructive work, credentials, and authority expansion remain human gates.

## Reference owners

- [Getting started](/getting-started/) owns installation and release boundaries.
- [Command reference](/commands/) owns flags, output envelopes, limits, and exit codes.
- [MCP reference](/mcp/) owns tool schemas, transport, limits, and authority.
- [Architecture](/architecture/) owns package and module boundaries.
- [Release workflow](/release-workflow/) owns build, publication, verification, and rollback gates.
