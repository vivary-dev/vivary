# 04: Define runtime, session, action, and tool contracts
Type: outcome
Status: planned
Blocked-by: [02, 03]
Unlocks: [09, 10, 16, 17, 20, 21, 22, 29, 30]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Define one app-owned contract for runtime capability, project binding, session lifecycle, actions, events, cancellation, tools, and receipts while native runtimes keep their own state.

## Context

Read [the native owner inventory](../native-owners.md) before adding any run, session, task, plan, messaging, scheduler, or resource infrastructure.

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own the proposed app service contracts and fixtures. Read `design.md`, `migration.md`, Littleagent S-00A, S-00, S-04 through S-07, and its version-matched Agent-Native research. Reuse framework types where their installed version proves the behavior.

## Done condition

Fixtures distinguish installed, configured, authenticated, bound, runnable, and verified. Every session binds actor, project, root or checkout, runtime, execution location, and policy revision. Tool grants and errors are explicit.

Bind each iteration to its model, harness, runtime, policy, and role-contract versions. Enforce planner/developer/QA read, write, and tool permissions through supported runtime capabilities; mark unavailable enforcement explicitly. Validate each role output against a versioned schema with a bounded retry budget and a recorded failure after exhaustion. A prompt instruction alone does not establish the boundary. Runtime choice remains configurable between recorded iterations.

## Verify

Refuse planner or QA artifact writes, wrong-role tools, malformed outputs, exhausted retries, and stale configuration bindings. Verify these permissions in the actual adapter, not just a synthetic object.

Run schema and lifecycle tests for create, stream, cancel, resume, stale binding, unsupported capability, and denied tool use. Prove the app does not invent a second transcript or runtime state owner.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.

- 2026-09-05: Refined acceptance after the owner-requested [HoH comparison](../research/hoh-alignment.md). These criteria remain unimplemented and unverified.
