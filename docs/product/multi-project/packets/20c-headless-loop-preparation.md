# 20c: Prepare the deterministic headless loop proof
Type: packet
Parent: 20
Status: needs-info
Depends-on: [10c]
Owner: deterministic headless-loop preparation agent, sole writer
Needs: A Habitat wall clock proven nondecreasing across one complete container and subprocess acceptance lifecycle, supplied by the Habitat environment maintainer. CPU affinity and continuous distro activity did not prevent backward steps; do not rerun the strict candidate until this environment prerequisite is met.
Scope: Offline fixture, prompts, protocol, sequencer, Claude adapter test seam, and adversarial tests; no coding-runtime or model call.
Verification-kind: runtime
Timebox: One context window. Stop after the offline Habitat evidence and closure records are complete.

## Goal

Create and verify every deterministic input and control needed by
[20a](20a-headless-loop-proof.md), while its live Claude proof remains blocked
on a verified whole-invocation token bound. The implementation is frozen and
its source review is complete. Runtime acceptance remains open until Habitat
provides a stable wall clock for the unchanged strict verification wave.

## Context

Read [20a](20a-headless-loop-proof.md), especially its usage contract, fixture
layout, done condition, and fault commands. Those sections remain normative for
field meanings, hashes, role visibility, expected-red behavior, reservation,
resume, and regression semantics. Also read [the direction decision](../design.md#direction-decision-2026-09-06),
[the execution contract](../execution-contract.md), and the accepted
[10c Habitat packet](10c-habitat-fallback-proof.md) and
[receipt](../receipts/10c-habitat-fallback-proof.md). Use the HoH appendix A.2
prompts through 20a's source link; do not copy its paper or 20a's full contract.

Python `3.11.16` is present in the existing Habitat image. Use only the standard
library. Install nothing. The tracked implementation files are outputs of this
packet, so their initial absence is not a prerequisite failure.

## Owned files

- Create `tools/hoh_loop.py`, `tools/hoh/__init__.py`,
  `tools/hoh/protocol.py`, and `tools/hoh/claude.py`.
- Create `tools/hoh/prompts/planner.md`, `developer.md`, and `qa.md`.
- Create `tools/tests/test_hoh_loop.py` and the tests-only executable
  `tools/tests/hoh_fault_probe.py`.
- If the installed Claude design uses scoped MCP tools, create
  `tools/hoh/role_tools.py` and `tools/tests/test_hoh_role_tools.py`.
- Create `docs/product/multi-project/fixtures/hoh-loop/spec.md`,
  `linkcheck.py`, and `tests/test_links.py`.
- Create `docs/product/multi-project/receipts/20c-headless-loop-preparation.md`.
- At closure update this packet, 20a's preparation evidence link and prerequisite
  status, and parent outcome 20. Regenerate the planning
  index and graph, update `CHANGELOG.md`, and run the approved canonical sync
  for its generated changelog and `llms-full.txt` mirrors.

Keep captured output and the source manifest under the verified preserved
Littleagent checkout's `.tmp/hoh-proof/20c/`. Apply 20a's separate ignore and
resolved-containment checks to every actual output and temporary filename
before writing; refuse existing files. Record source-bundle and writable test
paths privately. Retain each stopped task container and its test tree after
verification. After independent acceptance and a restore-and-hash check of the
exported evidence, the 20c owner prepares an itemized cleanup receipt and asks
for approval for each container or path removal. Record stopped-process
evidence, exact targets, archive hashes, owner, and a review-by date seven days
after closure. Keep pending removals visible at the next handoff; schedule no
job. Archives remain inputs for 20a and follow its later retention contract.
Private evidence and source bundles are not product source.

## Done condition

1. The fixture holds a fixed specification, fixed oracle, and incomplete
   starter. The harness runs the starter in a disposable copy and accepts only
   the exact declared failing test IDs and observations. An arbitrary red is a
   harness failure. Tests also prove a deterministically completed copy passes
   the unmodified oracle.
2. The protocol defines the runtime-neutral role request/result, evidence,
   transition, usage, reservation, and receipt records used by 20a. Strict
   validation rejects missing, unknown, mistyped, stale, or cross-run fields.
3. The sequencer owns prompt assembly, one schema retry, transition order,
   candidate and evidence hashes, deterministic test execution, no-progress
   detection, committed developer checkpoints, QA freeze, and atomic receipt
   writes. Every receipt binds the baseline, specification, oracle, prompts,
   role inputs, candidate state, test output, and prior receipt state.
   The retry applies only while the role's input view is unchanged. An invalid
   developer result that changed its writable candidate fails closed, retains
   the failed view and full reservation, and launches no retry or next role.
4. Deterministic role doubles exercise the three-iteration structure. Planner,
   developer, and QA receive only the views defined by 20a; tests prove the
   planner cannot request candidate access and QA cannot mutate its frozen view.
5. Before any adapter invocation, the ledger atomically reserves a verified
   maximum cumulative input-plus-output charge. Unknown or unenforceable maxima
   refuse safely without calling the adapter. A reservation larger than the
   remaining balance also refuses before invocation.
6. Complete usage settles the reservation under 20a's cache-counting rules.
   Interrupted, partial, malformed, or incomplete usage retains the full
   reservation. Missing vendor values stay `null`. Tests reopen the same ledger
   in a new process and prove the packet balance never resets.
7. The tests-only resume probe interrupts after the committed developer
   checkpoint and before QA. It resumes the same bound run without rerunning the
   developer, or classifies the attempt as a restart and keeps the first run
   incomplete when safe continuation cannot be proved.
8. The regression probe changes only disposable candidate implementation before
   the QA freeze. It proves the sequencer reports the regressed observation,
   stops acceptance, and preserves healthy evidence without editing the oracle
   or prompts.
9. The Claude adapter preflight fails closed for unsupported versions, flags,
   isolation, usage fields, and whole-invocation bounds. It invokes only the
   installed native CLI seam and contains no provider API client or substitute
   provider path. No test makes a real Claude request.
10. If scoped MCP tools are implemented, deterministic permission tests place a
    synthetic canary outside each role view and prove every read-only role tool
    refuses path, link, environment, process-file, shell, and write access. These
    tests do not establish the live OS, CLI, network, or credential boundary.
11. The 20c receipt records the source-bundle manifest and hashes, image and
    Python identities, exact commands and exit status, named adversarial
    observations, fault checkpoints, ledger and receipt bindings, and explicit
    absence of authentication mounts, network access, installs, and model calls.
12. The sequencer enforces 20a's one-hour iteration deadline across native CLI,
    role-tool worker, and deterministic test processes. Pass the remaining
    duration to every launch, refuse work after expiry, and reject late output.
    Stop and reap the exact owned process group and stop any owned role container
    within a five-second grace period; retain its files and stopped container.
    Preserve elapsed time and the original expiry across resume, and refuse a
    backward or uncertain clock observation rather than resetting the allowance.
    Adversarial tests use a stalled child and child-of-child to prove timeout,
    descendant termination, incomplete receipts, retained token reservations,
    no next-role launch, and no deadline reset after restart.

## Verify

Use the existing host Python for source and plan inspection only. Tests that
execute mutable candidates run inside the offline Habitat boundary below.
Before creating the task container, verify the installed image without pulling:

```console
docker image inspect sha256:ffdba5d54dd6f91875fa60fc15103b6b30bb23ecaaf2d8ed65559d3cdff05bee
```

Acceptance uses a reviewed source bundle outside the production checkout,
mounted read-only at `/opt/vivary-hoh-source`. Set `HABITAT_SOURCE_BUNDLE` to
its verified absolute host path. Set `HABITAT_TEST_ROOT` to a fresh persistent
task directory and `HABITAT_TEST_CONTAINER` to a unique `vivary-20c-test-` name.
Verify both paths remain in the task's authorized Habitat work root. Refuse an
existing test path or container name, then create that fresh directory with
write access for the image's verified `ubuntu` UID and GID. Mount it at `/tmp`
so stopping the container preserves candidate and test evidence. From Habitat's
Docker host, run the existing image with this boundary and no authentication volume:

```console
docker run --pull never --name "$HABITAT_TEST_CONTAINER" --network none --read-only --user ubuntu --cap-drop ALL --security-opt no-new-privileges --cpus 2 --cpuset-cpus 0 --memory 1g --pids-limit 128 --mount type=bind,src="$HABITAT_SOURCE_BUNDLE",dst=/opt/vivary-hoh-source,readonly --mount type=bind,src="$HABITAT_TEST_ROOT",dst=/tmp --workdir /opt/vivary-hoh-source sha256:ffdba5d54dd6f91875fa60fc15103b6b30bb23ecaaf2d8ed65559d3cdff05bee python3 -B -m unittest discover -s tools/tests -p 'test_hoh*.py'
docker inspect "$HABITAT_TEST_CONTAINER"
```

Record the resolved mount sources, image and container inspection, exact command,
source hashes, test names/counts, stdout, stderr, and exit status. If role-tool tests
exist, the discovery command includes them. Then run the common planning checks
from [the execution contract](../execution-contract.md#maintaining-the-graph).

## Stop conditions

Use no network, authentication volume, copied credential, model call, API key,
provider client, install, app server, schedule, production checkout bind, or
Docker socket mount. Do not create a token broker, daemon, database, queue, or
fallback accounting service. Stop if the source bundle is writable, its hashes
differ from the reviewed candidate, the container boundary differs from the
recorded command, or a deterministic adversarial check fails.
Use no `--rm`, automatic source/test-tree deletion, or cleanup job. Stop only
task-owned processes after tests; keep removal pending until explicit approval.

20c closure proves preparation only. Actual role-tool authority, authenticated
CLI behavior, provider network path, credential isolation, OS enforcement,
three live iterations, live usage, and both live fault runs remain 20a runtime
acceptance. Leave 20a `needs-info` until the runtime integration maintainer
supplies the required enforceable token bound or Jeff approves a specific,
reviewable policy alternative. Do not propose or assume that missing service in
this packet, and do not mark 20a done from deterministic evidence.

## Log

- 2026-09-06: PR #335 review separated claimable deterministic preparation from
  the blocked live proof. Packet 20c owns offline implementation and adversarial
  evidence; 20a retains every live-runtime claim and token-policy gate.
- 2026-09-06: Runtime classification now covers executable offline acceptance.
  The sequencer must prove enforced deadlines. Containers and test trees remain
  available for an itemized, explicitly approved cleanup after evidence export.
- 2026-09-06: The implementation was frozen at a twelve-file manifest, and an
  independent source review closed all six findings. Three unchanged strict
  acceptance waves refused after Habitat wall-clock reversals, including runs
  with CPU 0 affinity and continuous distro activity. Packet 20c is `needs-info`
  until the Habitat environment maintainer supplies a nondecreasing clock across
  the complete container and subprocess lifecycle. See the
  [preparation receipt](../receipts/20c-headless-loop-preparation.md).
