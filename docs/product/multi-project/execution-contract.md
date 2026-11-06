# How agents execute the Vivary program

[ENGINEERING.md](../../../ENGINEERING.md) governs engineering work.
It replaces default role separation, per-run admission, proof archives, and
permanent test-attempt accounting. Selected controls remain available in
[high-assurance mode](../../verification/high-assurance-mode.md).

This document owns program metadata, source ownership, and delivery details.
Older packets retain their product requirements, evidence, and specific budgets.
Their process preferences do not override the engineering policy.

## One current frontier

GitHub `vivary-dev/Vivary-New` issues own the queue: task goals, acceptance,
dependencies, ownership, priority, and lifecycle. Jeff approved this migration
on 2026-09-13; [the authority map](issue-authority.md) records it and the
historical issue mapping. Read the live issue before work.
[The desktop release target](desktop-release.md), [the frontier](index.md),
packets, and the generated graph are synchronized references to those issues,
not an independent dispatch queue. Refresh them when a linked issue changes.
A routine issue does not need a packet before it starts. Outcome and packet
files still own their own metadata; the graph is generated from them.

Outcome dependencies and packet `Depends-on` fields remain retained guidance
and evidence; the live issue's dependencies gate starting work. Independent
preparation may proceed without claiming that an unfinished integration works.
A retired proof workflow is not a product dependency.

## One reviewable iteration

Identify the observable result, implement one coherent slice, run relevant
checks, exercise the real app, fix failures, review, and commit. Then continue.

One writer owns each shared file. Use another reviewer for a difficult boundary
or decision when the added confidence justifies the cost. The implementing
agent may inspect, test, fix, and retest its own work.

## Status and ownership

- Outcomes use `planned`, `in-progress`, or `done`.
- Packets use `ready-for-agent`, `in-progress`, `needs-info`,
  `ready-for-human`, or `done`.
- `ready-for-agent` names a writer, inputs, owned outputs, observable result,
  and relevant verification.
- `needs-info` names a missing fact or external prerequisite and its owner.
- `ready-for-human` names the exact action awaiting approval after reversible
  preparation is complete.
- `done` requires `Verification-result: passed`, a verification log, and a linked
  receipt whose `Evidence-record` matches the packet or outcome ID.

Keep the existing metadata format as a derived reference. When a packet status
and its linked issue differ, the issue is correct; refresh the packet rather
than maintaining both. Runtime claims need runtime evidence;
`Verification-kind: inspection` describes source review.
A concise command and result are enough for ordinary verification.
Document checks establish consistency, not application behavior.

## Execution environment and resources

Use the environment authorized by the current task and packet. Verify its live
state before runtime. A historical environment or path is not current authority.
Preserve each specifically approved isolation, credential, spending, and cleanup
limit. Do not restart a consumed proof job under another name.

Prefer disposable roots and databases, loopback networking, and fake or disabled
model providers when exercising the real application.
Before unusually heavy work, inspect memory, disk, and included usage. Keep one
heavy job active, use timeouts, and clean up owned children.

Keep failed and unrun checks distinct from passed checks. Preserve useful
failure logs and earlier evidence. Do not recursively copy old archives or
prune unrelated resources.

## Integration and external actions

[CONTRIBUTING.md](../../../CONTRIBUTING.md) owns branch and PR rules.
Prepare small changes from current remote `dev`, review their full diff, and
satisfy the applicable CI gate before merging. Zo is the standing approved CI
host under [AGENTS.md](../../../AGENTS.md); record the exact tested candidate,
workflow commands, results, and platform omissions. GitHub billing does not block
that authorized path. Preserve the user's approved scope and repository protections;
a passing check alone does not authorize merge or administrator bypass.

Keep private history and continuity files outside public integration changes.
Bring over the reviewed source needed by each increment. Retain existing private
evidence at its original location.

Reuse [Native ownership](native-owners.md) instead of adding another registry,
queue, transcript store, scheduler, or model loop.
Account changes, paid usage, publication, scheduled activation, outbound messages,
destructive operations, and merges require authority for the action.
Use authorization already given; ask only when it is missing or scope changes.

[The release workflow](../../../docs/RELEASE-WORKFLOW.md) owns package publication
and release checks. Source versions, mock services, and passing tests do not
establish production readiness or publication.

## Reconcile documentation

Update durable claims when behavior, architecture, contracts, or lasting
constraints change. Keep current scope and acceptance in the issue,
implementation guidance in its packet or owning document, useful verification
in its receipt, and the next starting point in the existing handoff.
Do not narrate every test attempt or create parallel handoffs.

Refresh generated views when their inputs change. Ordinary edits do not need
a separate documentation reviewer, evidence export, or checkpoint ceremony.

## Maintaining the graph

After changing outcome or packet metadata, run the existing checks:

```console
python scripts/check_multi_project_plan.py --render
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

The renderer updates the frontier and full graph. Passing these checks does
not complete a feature.
