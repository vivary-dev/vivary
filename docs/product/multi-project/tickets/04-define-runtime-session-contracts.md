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

Under [decision four](../design.md#direction-decision-2026-09-06), adapters share
one versioned role-permission contract, prompt handoff, receipt schema, and usage
field definitions. Verify that contract on Claude Code and Codex using the
owner's subscriptions without requiring a model API key. Required enforcement,
receipt shape, policy, and fixture baseline must match; runtime/model versions,
native flags, measured usage, and generated candidates can differ. Missing
authentication or required enforcement leaves that runtime's proof incomplete.
A single-runtime receipt cannot pass this cross-runtime acceptance.

## Verify

Refuse planner or QA artifact writes, wrong-role tools, malformed outputs, exhausted retries, and stale configuration bindings. Verify these permissions in the actual adapter, not just a synthetic object.

Run schema and lifecycle tests for create, stream, cancel, resume, stale binding, unsupported capability, and denied tool use. Prove the app does not invent a second transcript or runtime state owner.


Run the [canonical common planning checks](../execution-contract.md#maintaining-the-graph)
after changing this outcome's metadata. These checks validate planning documents;
they do not prove the behavior above.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.

- 2026-09-05: Refined acceptance after the owner-requested [HoH comparison](../research/hoh-alignment.md). These criteria remain unimplemented and unverified.

- 2026-09-06: [Decision four](../design.md#direction-decision-2026-09-06) adds the shared adapter acceptance above. Packet [20a](../packets/20a-headless-loop-proof.md) supplies the first runtime evidence; its required continuation supplies parity evidence. Unimplemented and unverified.
