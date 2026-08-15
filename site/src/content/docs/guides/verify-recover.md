---
title: "Verify and recover a Vivary workspace"
description: "Run Vivary Doctor and Tropo checks, interpret health findings, and use explicit bounded recovery for interrupted adoption."
editUrl: "https://github.com/vivary-dev/vivary/edit/dev/docs/guides/verify-recover.md"
---

> **Mixed line.** Plain Doctor and Tropo check exist on published 0.3.1 / tropo 0.4.1.
> Exact-hash adoption recovery is unpublished 0.4.2. Pin
> `uvx --from create-vivary==0.3.1 create-vivary doctor` for the published path.

Use this guide after setup, adoption, or an approved record write.

## Result

You can identify health errors, privacy failures, and pending recovery work.
You can select a bounded recovery action without changing unrelated files.

## Agent contract

| Field | Value |
|---|---|
| Goal | Prove workspace health and recover known transactions. |
| Required input | Intended workspace root. |
| Default authority | Run read-only validation. |
| Optional authority | Apply an approved repair or exact recovery action. |
| Prohibited action | Do not guess fixes, hashes, or missing evidence. |
| Proof | Doctor and Tropo checks pass after the selected action. |

## 1. Run plain Doctor

Run Doctor first.

```bash
python packages/create-vivary/create_vivary.py doctor C:/path/to/project
```

Plain Doctor is read-only.
Doctor exits with code `0` when the error list is empty.
Doctor exits with code `1` when an error exists.
Warnings do not change the exit code.

Use JSON when an agent must inspect fields.

```bash
python packages/create-vivary/create_vivary.py doctor C:/path/to/project --json
```

Review the contract, privacy, capability, and recovery sections.

## 2. Run Tropo validation

Run the strict graph check.

```bash
python packages/tropo/tropo.py check --root C:/path/to/project
```

Strict mode is the default.
Warnings fail the strict check.

Use lenient mode only for an approved diagnostic reason.

```bash
python packages/tropo/tropo.py check --root C:/path/to/project --lenient
```

Do not report a lenient result as strict proof.

## 3. Read each finding

Identify the file, finding code, and required owner.
Do not repair a symptom before you understand the finding.

Common finding classes:

| Finding | Meaning | Action |
|---|---|---|
| Missing contract file | The thin workspace is incomplete. | Restore the owned contract or recover adoption. |
| Privacy failure | Ignore policy can expose protected data. | Stop all public retrieval. |
| Broken reference | A typed relation names a missing target. | Restore or correct the target manually. |
| Invalid type field | Content violates the workspace policy. | Correct the source with owner approval. |
| Pending transaction | A prior adoption did not finish. | Use the reported recovery hash. |

The [command reference](/commands/#finding-codes) owns exact finding codes.

## 4. Recover interrupted adoption

Use recovery only when Doctor or adoption reports the transaction.
Copy the exact reported hash.

```bash
python packages/create-vivary/create_vivary.py adopt C:/path/to/project \
  --recover sha256:<reported-plan-hash> \
  --json
```

This command writes nothing.
It returns `recovery_plan_hash` and the bounded recovery actions.
Review that exact plan.

Apply the separately approved recovery hash.

```bash
python packages/create-vivary/create_vivary.py adopt C:/path/to/project \
  --recover sha256:<reported-plan-hash> \
  --yes \
  --plan sha256:<approved-recovery-plan-hash> \
  --json
```

Recovery restores only the authenticated transaction-bound backups.
Run Doctor after recovery.

## 5. Understand record rollback

`create-vivary record` runs Doctor after its write.
The command restores previous bytes when Doctor fails.
The command removes a new record tree when verification fails.

The record command has no manual recovery flag.
Do not invent one.

If the process stops unexpectedly, inspect Doctor and the transaction evidence.
Stop when the required action is not explicit.

## 6. Inspect legacy repair diagnostics

Use repair mode only for a recognized legacy full workspace.
Request the report.

```bash
python packages/create-vivary/create_vivary.py doctor C:/path/to/project --repair --json
```

The report writes nothing.
Review each proposed action.

Recognized legacy-full workspaces remain report-only even with `--yes`.
No reported action is applied.
Use a reviewed thin adoption plan for an approved legacy change.

Thin adoption uses `adopt --recover`.
Do not use legacy diagnostics as thin recovery.

## 7. Use trend only when approved

Plain Doctor does not write runtime state.
`doctor --trend` writes a local trend snapshot.

```bash
python packages/create-vivary/create_vivary.py doctor C:/path/to/project --trend --json
```

Get approval before this write.
Keep the runtime snapshot outside version control.

## 8. Check policy overlays

The thin workspace policy comes from `.vivary/workspace.toml`.
A root `tropo.toml` can only reduce admitted scope.

Doctor and public retrieval refuse invalid overlays.
Doctor and public retrieval refuse policy loosening.

Do not remove privacy exclusions to make a query succeed.

## 9. Confirm final health

Run Doctor again.
Then run Tropo validation.

```bash
python packages/create-vivary/create_vivary.py doctor C:/path/to/project
python packages/tropo/tropo.py check --root C:/path/to/project
```

Record the exact commands and results.
Do not call activity proof.
Use test output, artifact hashes, or accepted findings as proof.

## Legacy compatibility

Doctor reads recognized 0.3.1 full workspaces.
Doctor does not migrate or normalize them.

Pin 0.3.1 when the historical full-layout creator is required.

```bash
uvx --from create-vivary==0.3.1 create-vivary init my-workspace
npx @vivary/create@0.3.1 my-workspace
```

Use the [historical proof](/walkthrough/) only for that published layout.
