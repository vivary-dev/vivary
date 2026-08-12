---
title: "Adopt an existing project"
description: "Preview and apply bounded brownfield adoption without project takeover."
editUrl: "https://github.com/vivary-dev/vivary/edit/dev/docs/guides/adopt-project.md"
---

Use this guide when the target already contains project files.

## Result

Vivary adds bounded governed context without taking over the project.
The default payload limit is three Vivary-owned files.

## Agent contract

| Field | Value |
|---|---|
| Goal | Add minimal governed context to one existing project. |
| Required input | Existing directory and approved preset. |
| Planning authority | Inspect and produce one deterministic plan. |
| Apply authority | Apply only the exact human-approved plan. |
| Prohibited action | Do not copy templates, skills, records, or framework prose. |
| Proof | Apply reports Doctor proof and preserves user content. |

## 1. Identify the project root

Confirm that the directory is the intended project.
Confirm that no higher or lower directory is the correct root.

Do not run `init --force` on any nonempty workspace.
Use `adopt` for all nonempty targets.

## 2. Preview the adoption

Run the default dry-run.

```bash
python packages/create-vivary/create_vivary.py adopt C:/path/to/project --json
```

The command writes nothing.
The command returns a deterministic plan.

Inspect these fields:

- `creates`
- `patches`
- `optional_projections`
- `kept`
- `conflicts`
- `privacy`
- `plan_hash`

Stop when `conflicts` is not empty.
Stop when the privacy result is not healthy.

## 3. Check the default file limit

Adoption can create these three payload files:

```text
.vivary/context.md
.vivary/workspace.toml
STATE.md
```

Adoption creates `STATE.md` only when the file is absent.

Adoption can also create or patch two managed blocks:

```text
AGENTS.md
.gitignore
```

Vivary keeps all user content outside those blocks.
Vivary does not rewrite an entire host file.

## 4. Select optional adapters only when required

Request an adapter explicitly.

```bash
python packages/create-vivary/create_vivary.py adopt C:/path/to/project --adapter agents --json
python packages/create-vivary/create_vivary.py adopt C:/path/to/project --adapter claude --json
```

Each adapter is a separate optional projection.
Each adapter adds one bounded runtime file.

Do not request an adapter for an unused runtime.

## 5. Approve the exact plan

Show the complete plan to the project owner.
Ask for approval of the exact `plan_hash`.

Replan after any project file changes.
Replan after any preset or adapter changes.

## 6. Apply the approved plan

Use the exact approved hash.

```bash
python packages/create-vivary/create_vivary.py adopt C:/path/to/project \
  --yes --plan sha256:<approved-plan-hash> \
  --json
```

Apply rechecks every planned input.
Apply uses exact-byte backups and a transaction journal.
Apply rolls back ordinary failures.

## 7. Verify the project

Run Doctor after apply.
Then run Tropo validation.

```bash
python packages/create-vivary/create_vivary.py doctor C:/path/to/project
python packages/tropo/tropo.py check --root C:/path/to/project
```

Confirm that user-owned files keep their original content.
Confirm that no starter record or template exists.

## Conflict conditions

Vivary reports a conflict for divergent managed blocks.
Vivary reports a conflict for an invalid thin contract.
Vivary reports a conflict for changed plan inputs.
Vivary reports a conflict when nested ignore rules expose private paths.
Vivary reports a conflict for unsafe linked or non-regular targets.

Do not bypass a conflict with `--force`.
Resolve the owner decision.
Run a new dry-run.

## Interrupted transaction

Use recovery only when adoption reports an interrupted transaction.
Use the exact reported plan hash.

```bash
python packages/create-vivary/create_vivary.py adopt C:/path/to/project \
  --recover sha256:<reported-plan-hash> \
  --json
```

This command is a read-only recovery plan.
Review its `recovery_plan_hash` and actions.

```bash
python packages/create-vivary/create_vivary.py adopt C:/path/to/project \
  --recover sha256:<reported-plan-hash> \
  --yes \
  --plan sha256:<approved-recovery-plan-hash> \
  --json
```

The second command restores only the approved transaction-bound bytes.

Do not guess a recovery hash.
Do not start a new plan before recovery completes.

## What adoption never does

Adoption does not scan for candidate modules.
Adoption does not create graph records.
Adoption does not copy routers, skills, or templates.
Adoption does not exclude arbitrary existing content.
Adoption does not enable MCP, memory, indexing, or network access.

Use the [adoption reference](/commands/#adopt--governed-brownfield-setup) for the complete transaction contract.
