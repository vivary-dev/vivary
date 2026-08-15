---
title: "Write a governed Vivary record"
description: "Plan, approve, apply, and verify one capsule-bound Vivary record after completed work earns durable project context."
editUrl: "https://github.com/vivary-dev/vivary/edit/dev/docs/guides/write-record.md"
---

> **Unpublished 0.4.2.** `create-vivary record` is not on the registry.
> Strangers should stop at [Getting started](/getting-started/) with published
> 0.3.1. Run this guide only from a Vivary checkout or an isolated candidate.

Use this guide after verified work earns durable context.

## Result

Vivary creates or updates exactly one typed record.
The transaction uses one complete Task Capsule and one approved plan hash.

## Agent contract

| Field | Value |
|---|---|
| Goal | Preserve one fact earned by real work. |
| Required input | Healthy thin workspace, complete capsule, and typed Markdown source. |
| Planning authority | Validate and propose one record without writing. |
| Apply authority | Write only the exact human-approved plan. |
| Prohibited action | Do not batch records, create packs, or infer approval. |
| Proof | Doctor passes and Tropo reads the record. |

## Candidate prerequisite

Activate the approved candidate environment from the [guide library](/learn-by-doing/#command-route).
The environment must contain local Core, Tropo, and Create packages.
Do not use the published 0.3.1 command for this procedure.

## 1. Confirm that the work earned a record

Record verified work, decisions, evidence, gates, or module truth.
Do not record guesses, plans without evidence, or starter content.

Select one supported record folder:

- `modules`
- `changes`
- `decisions`
- `verification`
- `gates`

## 2. Save the complete capsule

Use the capsule from [Get bounded context](/guides/get-context/).
The file must contain the complete governed JSON result.

```bash
tropo find "record the verified release change" --root C:/path/to/project --governed --json > C:/path/to/task-capsule.json
```

MCP can supply the complete public capsule object.
MCP does not supply approval.

## 3. Prepare one typed source file

Create the source outside the destination tree.
Use UTF-8 Markdown.

Example:

```markdown
---
project: context
status: done
slice: release guide verification
---
# Release guide verification

The local guide checks passed.
The proof is in the release receipt.
```

Save this example as `C:/path/to/verified-guide.md`.
Change the fields when the workspace type policy requires different values.

## 4. Preview the record plan

Run `record` without `--yes`.
Planning is read-only.

```bash
create-vivary record C:/path/to/project changes/verified-guide.md \
  --from C:/path/to/verified-guide.md \
  --capsule C:/path/to/task-capsule.json \
  --json
```

Inspect these plan fields:

- action
- destination
- previous hash
- proposed hash
- capsule identifier
- capsule fingerprint
- workspace fingerprint
- `plan_hash`

Confirm that the plan contains one destination.
Stop if the plan names any other path.

## 5. Get deliberate human approval

Show the complete plan to the workspace owner.
Ask for approval of the exact `plan_hash`.

Do not accept approval for a different hash.
Do not infer approval from silence or prior work.
Replan when any bound input changes.

## 6. Apply the approved plan

Use the exact approved hash.

```bash
create-vivary record C:/path/to/project changes/verified-guide.md \
  --from C:/path/to/verified-guide.md \
  --capsule C:/path/to/task-capsule.json \
  --yes --plan sha256:<approved-plan-hash> \
  --json
```

Add a local receipt only when required.

```bash
create-vivary record C:/path/to/project changes/verified-guide.md \
  --from C:/path/to/verified-guide.md \
  --capsule C:/path/to/task-capsule.json \
  --yes --plan sha256:<approved-plan-hash> \
  --receipt C:/path/to/project/.vivary/runtime/receipts.jsonl --json
```

The optional receipt omits target paths, source paths, and capsule values.

## 7. Verify the record

Run Doctor.
Query the record.

```bash
create-vivary doctor C:/path/to/project
tropo query "Release guide verification" --root C:/path/to/project --json
```

The record path is:

```text
.vivary/records/changes/verified-guide.md
```

No unrelated file can appear.

## Refusal conditions

Vivary refuses an incomplete or changed capsule.
Vivary refuses a capsule from another workspace.
Vivary refuses a changed source or destination.
Vivary refuses an unapproved or incorrect plan hash.
Vivary refuses nested paths and unsupported record folders.
Vivary refuses linked or hard-linked destinations.
Vivary refuses content that violates the type policy.

## Rollback behavior

Apply writes the record atomically.
Apply runs Doctor after the write.
Vivary restores the previous bytes when Doctor fails.
Vivary removes a new record tree when verification fails.

The command has no batch mode.
The command never creates a starter graph.

Use the [record reference](/commands/#record) for input limits and output envelopes.
