---
title: "Get bounded context"
description: "Retrieve bounded task context or save a complete Task Capsule."
editUrl: "https://github.com/vivary-dev/vivary/edit/dev/docs/guides/get-context.md"
---

Use this guide before an agent changes the workspace.

## Result

Vivary returns a small public context result.
Default retrieval does not create a record or change workspace files.
The `--receipt` option writes one local privacy-preserving receipt.

## Agent contract

| Field | Value |
|---|---|
| Goal | Retrieve evidence for one task. |
| Required input | Healthy workspace and specific question. |
| Default authority | Read admitted public context. |
| Optional output | Save one complete Task Capsule. |
| Prohibited action | Do not infer missing evidence or expose private paths. |
| Proof | Result is bounded, typed, and scoped to the workspace. |

## 1. Ask a specific question

Name the task, decision, or fact.
Do not ask for the complete workspace.

Good question:

```text
Where is release truth owned?
```

Weak question:

```text
Tell me everything.
```

## 2. Retrieve a task packet

Run `find` for normal task context.

```bash
python packages/tropo/tropo.py find "where is release truth owned" --root C:/path/to/project --budget 1200 --json
```

The default budget is 1,200 approximate tokens.
Use a smaller budget when the task needs less context.

Inspect these result parts:

- selected documents
- bounded snippets
- type and path data
- reason or match data
- warnings and refusal data

Do not treat an empty result as proof that no evidence exists.
State that the result is unknown when evidence is missing.

## 3. Run a focused query

Use `query` when you need typed or filtered matches.

```bash
python packages/tropo/tropo.py query "release status" --root C:/path/to/project --type project --json
```

Use `--path` to limit paths.
Use `--edge` to require an outbound relation.
Use `--explain` to include stable match reasons.

The [command reference](/commands/#tropo--the-typed-knowledge-graph) owns all filter limits.

## 4. Create a governed capsule

Create a capsule only when later work needs evidence binding.
Activate the approved candidate environment from the [guide library](/learn-by-doing/#command-route).

```bash
tropo find "record the verified release change" --root C:/path/to/project --governed --json > C:/path/to/task-capsule.json
```

Save the complete JSON result.
Do not save only the capsule identifier.
Do not save only the capsule fingerprint.

The capsule contains bounded claims and workspace binding.
The capsule does not contain write approval.

## 5. Use MCP when selected

Use `vivary_find` for bounded task context.
Use `vivary_query` for filtered matches.
Use `vivary_check` for read-only findings.
Use `vivary_capsule` for a public Task Capsule.

Pass the operator-bound workspace alias.
Do not pass a filesystem path in a tool call.

Save the complete `result` field.
The field must contain the `vivary.public-task-capsule/v0` object.
Do not save the outer `vivary.mcp-tool-result/v0` envelope.

## 6. Interpret MCP status

`known` means admitted evidence supports the result.
`unknown` means the producer cannot establish the result.
`refused` means policy or a work limit blocks the result.

Do not convert `unknown` into a fact.
Do not bypass a `refused` result.
Reduce the request or resolve the policy problem.

For CLI retrieval, inspect `complete`, `omissions`, and the command exit code.

## 7. Protect private data

Vivary excludes private and runtime paths.
Git ignore policy is authoritative in an exact Git worktree.
A non-Git thin workspace needs the exact generated ignore block.

A root `tropo.toml` can only tighten the thin policy.
A loosening or invalid overlay fails closed.

## 8. Record an optional receipt

Add `--receipt` when the operator needs a local run receipt.

```bash
python packages/tropo/tropo.py find "where is release truth owned" --root C:/path/to/project --json \
  --receipt C:/path/to/project/.vivary/runtime/receipts.jsonl
```

The receipt omits raw query text and private paths.
The receipt does not change the graph.

Use [Write one approved record](/guides/write-record/) when verified work earns durable context.
