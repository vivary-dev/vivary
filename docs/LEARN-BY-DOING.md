# Vivary guides

Use these Vivary guides to complete one governed workspace task at a time.
Each page is the canonical human-and-agent procedure that the public site renders.
The guides use STE100 style.
Each procedure is concise, direct, and safe to copy.

The complete guide set is thorough.
Each guide keeps one task boundary.
The command reference keeps exhaustive flags, schemas, limits, and exit codes.

## Release boundary

The default guides pin **published 0.3.1**.
Use the [release-status table](../README.md#release-status) as the publication authority.
The [published 0.3.1 proof](WALKTHROUGH.md) shows the full-layout scaffold.

Guides that need `record`, exact-hash adopt apply, `--governed`, or MCP are
unpublished 0.4.2. Those pages say so at the top. Do not run them with registry
0.3.1.

## Command route

For published 0.3.1 tasks, pin the registry commands:

```bash
uvx --from create-vivary==0.3.1 create-vivary
uvx --from vivary-tropo==0.4.1 tropo
```

Replace each example workspace path with the intended absolute path.
Do not use unversioned registry `latest`.

Unpublished 0.4.2 guides run from a Vivary checkout or an isolated candidate
environment. Get approval before you create that environment.

## Choose a guide

| Task | Guide | Result | Line |
|---|---|---|---|
| Start a new project | [Create a Vivary workspace](guides/create-workspace.md) | Create the published 0.3.1 full-layout scaffold. | Published 0.3.1 |
| Add Vivary to a project | [Adopt an existing project](guides/adopt-project.md) | Dry-run, then add files only. | Published 0.3.1 |
| Prove health | [Verify and recover a workspace](guides/verify-recover.md) | Validate health. Recovery hashes are 0.4.2. | Mixed |
| Give an agent context | [Connect an agent to Vivary](guides/connect-agent.md) | Use the standard route. MCP is unpublished. | Mixed |
| Retrieve evidence | [Get bounded context](guides/get-context.md) | Return task context. Task Capsule path is 0.4.2. | Mixed |
| Preserve earned context | [Write one approved record](guides/write-record.md) | Apply one capsule-bound record. | Unpublished 0.4.2 |

## Use the guides in this order

For a new project:

1. Create the workspace with published 0.3.1.
2. Verify with Doctor and Tropo check.
3. Connect the selected agent through AGENTS.md.
4. Retrieve bounded context with Tropo.
5. Complete real work.
6. Verify the result.

For an existing project:

1. Preview adoption with published 0.3.1.
2. Review the add list and collisions.
3. Approve the add list, then apply with `--yes`.
4. Verify the adopted workspace.
5. Connect the selected agent.

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
Plain Doctor is read-only.
Published 0.3.1 init creates the full-layout scaffold.
Published 0.3.1 adoption adds files only after `--yes`.
`record`, exact-hash apply, MCP, and `--governed` are unpublished 0.4.2.

Publishing, external writes, destructive work, credentials, and authority expansion remain human gates.

## Reference owners

- [Getting started](GETTING-STARTED.md) owns installation and release boundaries.
- [Command reference](COMMANDS.md) owns flags, output envelopes, limits, and exit codes.
- [MCP reference](MCP.md) owns tool schemas, transport, limits, and authority.
- [Architecture](ARCHITECTURE.md) owns package and module boundaries.
- [Release workflow](RELEASE-WORKFLOW.md) owns build, publication, verification, and rollback gates.
