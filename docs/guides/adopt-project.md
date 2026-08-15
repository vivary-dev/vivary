# Adopt an existing project

Use this guide when the target already contains project files.

## Result

Vivary adds the published 0.3.1 scaffold files without rewriting existing content.
Adopt is dry-run first. It only adds files.

## Release boundary

These commands pin **published 0.3.1**.
Do not use `--plan <hash>`. That apply path is unpublished 0.4.2.
Do not expect the three-file thin payload. That contract is unpublished 0.4.2.

## Agent contract

| Field | Value |
|---|---|
| Goal | Add published Vivary files to one existing project. |
| Required input | Existing directory and approved preset. |
| Planning authority | Inspect and list files that would be added. |
| Apply authority | Write only after explicit `--yes`. |
| Prohibited action | Do not rewrite existing files. Do not use unpublished exact-hash apply. |
| Proof | Adopt reports the add list. Doctor and Tropo checks pass. |

## 1. Identify the project root

Confirm that the directory is the intended project.
Confirm that no higher or lower directory is the correct root.

Do not run `init --force` on any nonempty workspace.
Use `adopt` for all nonempty targets.

## 2. Preview the adoption

```bash
uvx --from create-vivary==0.3.1 create-vivary adopt C:/path/to/project --json
```

The command writes nothing.
Read every planned create.
Stop on a collision.
Existing files must stay byte-identical.

## 3. Apply after approval

```bash
uvx --from create-vivary==0.3.1 create-vivary adopt C:/path/to/project --yes
```

Apply only after a human approves the add list.

## 4. Verify

```bash
uvx --from create-vivary==0.3.1 create-vivary doctor C:/path/to/project
uvx --from vivary-tropo==0.4.1 tropo check --root C:/path/to/project
```

Both commands must exit with code `0`.

## Stop conditions

Stop when a planned create collides with an existing file.
Stop when existing content would change.
Stop when the add list is not approved.

Use [Getting started](../GETTING-STARTED.md) for the install pins.
Use the [command reference](../COMMANDS.md) for flags and output fields.
