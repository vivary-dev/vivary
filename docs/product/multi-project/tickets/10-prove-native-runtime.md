# 10: Complete native runtime proof from S-00A
Status: needs-info
Blocked-by: [04]
Needs: Verified predecessor evidence for [04], plus exact implementation files and executable behavior-verification commands recorded before this ticket becomes actionable.
Unlocks: [16, 20, 22, 23, 24, 30, 36]

## Goal

Replace deterministic host-only evidence with one real supported native runtime execution, cancellation, and resume proof in the bound project root.

## Context

The owner selected BrowserPod on 2026-09-05 and excluded Habitat/WSL for this work. Verify the connection and exact toolchain there. Do not count historical Habitat fixtures as BrowserPod or real-runtime acceptance.

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

- 2026-09-05: Initial public plan recorded. Implementation has not started.
