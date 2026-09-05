# 10: Complete native runtime proof from S-00A
Type: outcome
Status: in-progress
Blocked-by: [04]
Unlocks: [16, 20, 22, 23, 24, 30, 36]

Execution: Start only a bounded packet listed in [the graph](../graph.md). Parent dependencies gate completion, not independent preparatory work.

## Goal

Replace deterministic host-only evidence with one real supported native runtime execution, cancellation, and resume proof in the bound project root.

## Context

Read [the native owner inventory](../native-owners.md) before adding any run, session, task, plan, messaging, scheduler, or resource infrastructure.

The owner selected BrowserPod and later authorized Habitat fallback on 2026-09-05. Packet 10c proves only the bounded Habitat toolchain; 10b retains the separate BrowserPod proof. Neither a historical fixture nor a toolchain check establishes real coding-runtime acceptance.

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own the native runtime adapter, readiness UI, public API map updates, and proof receipt. Reuse Littleagent S-00A host code and eleven deterministic tests. Read S-00A findings before changing the adapter. Do not make paid calls without approval.

## Done condition

The readiness screen reports actual state. One authorized runtime starts in the selected root, streams events, runs a bounded fixture task, cancels its process scope, and resumes only where the runtime supports resume.

## Verify

Run deterministic host tests and one approved no-cost real-runtime proof. Record runtime version, auth state without secrets, project binding, events, cancellation result, resume result, and cost.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Preserved local host and readiness UI exist. Eleven historical deterministic tests and a browser pass were recorded. BrowserPod integration and real coding-runtime acceptance have not passed. Start early preflight packets 10a/10b before import; reuse the host where compatibility is proved.
