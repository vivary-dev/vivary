# How agents execute the Vivary program

The 36 numbered records are product outcome contracts. Some require several
sessions. Lettered packets are the units an agent claims and verifies in one
context window. Completing a packet does not complete its parent outcome.

## One current frontier

Read [the generated graph](graph.md). Outcome and packet files own their fields;
the graph is generated and checked against them. Do not dispatch an older
GitHub release map or a local historical handoff. [The authority map](issue-authority.md)
preserves those issue histories and names their surviving responsibilities.

Outcome dependencies are completion gates, not a prohibition on independent
preparation. Packet `Depends-on` fields are start gates. Do not add a product
release, optional connector, source import, or account prerequisite to a packet
that can finish without it. For example, registry contract fixtures can be
reviewed before a database is selected; live pod execution requires a connection.

## Status and ownership

- Outcomes use `planned`, `in-progress`, or `done`.
- Packets use `ready-for-agent`, `in-progress`, `needs-info`,
  `ready-for-human`, or `done`.
- `ready-for-agent` means the packet has sufficient existing inputs, one named
  writer, owned outputs, observable acceptance, verification, and stop conditions.
- `needs-info` must name the exact missing fact or external prerequisite and its
  owner. It does not mean unfinished dependencies or outputs not yet created.
- `ready-for-human` names one actual operation that requires a human after the
  agent has prepared and verified everything else. PR merge approval remains
  separate from an agent's documentation or contract acceptance.
- `done` requires a linked evidence receipt and a verification log. A packet's
  success never automatically closes the outcome or a release gate.

Claim the lowest ready packet whose verification environment is available.
Record one writer before editing. Other agents may review, but must not edit its
owned files concurrently. Checkpoint at one context window or the packet's
timebox: changed files, evidence, remaining work, exact next command, and owner.
Do not reset dirty work, run a competing push, or take over another active writer.

## Execution and verification

BrowserPod remains the preferred environment. The owner subsequently authorized
Habitat fallback on 2026-09-05; see the exact answer in the design decision.
Runtime packets name the environment and require its live preflight for the exact
tools they will execute. Habitat results cannot satisfy BrowserPod-specific checks. Native CLI, Python, database, persistence, and isolation support
remain separate capabilities until each is observed.

Inspection packets may read source, write contracts and fixtures, inspect diffs,
and use the existing repository CI for documentation checks. They do not need a
live pod and cannot claim runtime behavior. Record `Verification-kind: inspection`
or `Verification-kind: runtime`. A common plan-lint command proves document
consistency only; a runtime packet also needs its own failing/passing behavior
checks and observed results.

The SDK, model loop, native run/session state, resource connections, tasks,
messaging, and automations retain their existing owners. Use [the owner inventory](native-owners.md)
before adding infrastructure. New product records require a demonstrated gap;
do not create another reasoning loop, transcript store, task queue, or scheduler.

## Ticket quality before dispatch

Every packet names its parent, writer, scope, existing inputs, exact outputs,
observable acceptance, execution environment, verification, stop conditions,
and evidence destination. Future output files are created by the packet; their
absence is not a missing input. Runtime packets must include adversarial failure
cases, user-visible behavior where applicable, and recovery evidence.

Keep a bounded packet for the current frontier and prepare the next one before
closing its predecessor. Future outcomes retain their complete acceptance and
scope mapping; do not fabricate exact APIs or make giant outcomes look like
single-session implementation tickets. A newly discovered gap repairs the owning
packet and dependency edge, with a log entry; it does not erase product scope.

For optional VCS, hosting, task-source, and Brain paths, implement and verify the
native/skip path independently. Completion of the full optional integration may
still gate release coverage. A missing connector must not disable the core path.
Behavior docs move with each feature; outcome 24 audits the installed journey.

## Gates and release truth

Routine in-scope design, fixture, documentation, and implementation choices are
agent work under the existing authorization. Account changes, spending, source
publication rights, destructive operations, scheduled activation, outbound email,
production release, and merges keep their specific authority requirements.
Stop only the dependent operation, continue independent packets, and name the
concrete prerequisite. Do not request blanket product reauthorization.

The real 100% scanner result remains an unmet release requirement. Neither
document checks, mock services, historical Habitat tests, nor a successful
BrowserPod Node fixture can close unrelated acceptance gates.

## Maintaining the graph

After changing outcome or packet metadata:

```console
python scripts/check_multi_project_plan.py --render
python scripts/check_multi_project_plan.py --check
git diff --check
```

The renderer only transforms planning documents. CI runs the guard's adversarial
fixtures and rejects frontier, dependency, status, coverage, and evidence drift.
