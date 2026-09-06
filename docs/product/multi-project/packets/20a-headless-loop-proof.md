# 20a: Prove the Claude Code headless loop on files

Type: packet
Parent: 20
Status: needs-info
Depends-on: [10c, 20c]
Owner: Claude loop proof agent
Needs: A verified pre-admission bound on cumulative input and output for an installed Claude Code invocation, supplied by the runtime integration maintainer. Jeff owns any proposed change to this packet's hard token policy. The installed CLI has no documented bound that satisfies it.
Scope: Run one Claude Code proof using the deterministic implementation accepted in 20c. Complete three healthy iterations and two isolated fault runs within 100,000 reported tokens. Do not run Codex parity, a GUI, an Agent-Native server, a new scheduler, or a paid API key.
Verification-kind: runtime
Timebox: One context window. Stop after three healthy iterations and both fault runs, or at a stop condition, and write the receipt.

## Goal

Prove the file-based planning, development, and QA loop with the owner's Claude
Code subscription. Bind each stage to the exact fixture, candidate, prompt,
observation, and receipt state that produced it. The claimable
[20c preparation](20c-headless-loop-preparation.md) keeps the
[loop-first direction](../design.md#direction-decision-2026-09-06) executable
while the native-call budget capability is unavailable.

Packet 20a proves one runtime against the common role and receipt contract. It
does not prove cross-runtime acceptance. Packet 20b owns the Codex run and the
field-by-field parity comparison.

## Context

Read [the direction decision](../design.md#direction-decision-2026-09-06),
[the alignment brief](../research/hoh-direction-brief.md) sections 1, 3, and 8,
[the HoH comparison](../research/hoh-alignment.md), outcome
[20](../tickets/20-run-bounded-factory.md), [the execution contract](../execution-contract.md),
`packages/core/vivary_core/receipt.py` for fingerprint binding, and
[10c](10c-habitat-fallback-proof.md) for the environment. The HoH role prompts
are in the paper's PDF appendix A.2 (arXiv 2609.01481v1, pages 22 to 25). The
HTML omits them. The Fusepoint repository (`Flesymeb/fusepoint`, branch
`gameloop`, `.gameloop/receipts/`) supplies the reference record shapes.

Packet 20c implements the runtime-neutral role, transition, and receipt
interface in `tools/hoh/protocol.py`. Habitat has Claude Code `2.1.241`. The Claude adapter
maps only capabilities verified from that installed CLI onto the interface.
Record the version, model, subscription, and exact live-preflight flags. Do not
copy flags from a newer host CLI or assume a flag the Habitat command has not
verified.

The sequencer owns prompt assembly, schema validation with one retry, hashes,
test execution, no-progress detection, receipt writes, and Git stage
checkpoints. Follow appendix A.2 when the paper conflicts with its prose. The
planner sees only the specification, its prompt, and prior public evidence. It
cannot mount or inspect candidate production code. The developer receives its
development document and a writable candidate tree. QA receives the
specification, development document, public deterministic evidence, and a
frozen read-only candidate. Planner and QA have read-only tool permissions.
Only the developer role receives candidate write authority.

Enforce those views with separate mounts or materialized role trees plus CLI
tool permissions. A working directory or prompt instruction alone is not an
enforcement boundary. Mount the specification, oracle, and common prompts
read-only for every role that can see them. The sequencer rejects a changed
frozen candidate, oracle, or prompt instead of accepting its report.

The trusted sequencer may run as the Habitat WSL control process. Keep the
authenticated CLI host separate from the credential-free role tool filesystem.
The full source bundle and proof
tree are control-process views only. Give each role a minimal projection of its
declared files. The planner must not inherit the source bundle, candidate trees,
raw developer logs, or another receipt root. Its public receipt index may expose
only approved detail files. Never mount the Docker socket inside a model-driven
container. Give the CLI host a proxy-only network and the role tool worker no
external network. Give both explicit CPU, memory,
process, capability, and no-new-privileges limits. The existing offline
preflight proves the image tools and authentication state only. It does not
prove this live execution design.

Private candidate and detailed receipt directories are proof outputs. They are
not a scheduler, memory service, native session record, or replacement
transcript store. Each role receives `<receipt-dir>/index.md` and opens details
under that same receipt root. Record each assembled prompt's bytes and SHA-256
hash. The tracked 20a receipt summarizes the private runtime evidence and binds
its claims to hashes and command output.

Run in the Habitat sandbox through its allowlist proxy. Use the owner's existing
subscription authentication without copying credentials. The offline 10c
container cannot run the coding agent.

## Usage contract

Packet 20a has one 100,000-token ceiling across every model call in its healthy,
fault, schema-retry, and live-preflight paths. Before a role call, require a
verified maximum cumulative input-plus-output charge for that invocation,
including native retries and auxiliary model requests. Bind the maximum to the
installed runtime, model, policy, and enforcement evidence. Reserve that maximum
atomically from the remaining packet balance before launching the CLI. Refuse
the call when the bound is unknown, cannot be enforced, or exceeds the balance.

Settle from actual usage only when the result proves complete accounting.
Retain the full reservation after interruption or incomplete usage. A turn cap,
an output-only cap, and observed cost do not establish a total-token bound.
Streamed usage and cancellation are secondary checks, never admission authority.
Any observed overrun fails the proof. The current installed CLI has no documented
mechanism that passes this preflight. Do not make a model call to discover the
bound. Keep live execution stopped and continue independent deterministic work
or another available packet. Changing this hard-token policy requires Jeff's
specific approval of a reviewable alternative.

Store the monotonic packet ledger at
`/tmp/vivary-hoh-proof/20a/usage.json`. Every healthy, fault, retry, and
model-calling preflight reads and atomically advances that ledger. Passing
`--reported-token-budget 100000` verifies the packet ceiling. It never resets
the spent balance when a new process or receipt root starts.

Preserve `vendor_usage_raw` for every call and document the adapter's mapping.
The normalized record contains `aggregate_input_tokens`,
`aggregate_output_tokens`, `cache_read_input_tokens`, and
`cache_write_input_tokens`. Count cache reads and writes once when Claude
reports them separately. State whether its base input value includes either
cache value so the total does not double count. `aggregate_input_tokens` is the
base input plus cache tokens that the base excludes, counted once.
`budget_counted_tokens` is aggregate input plus aggregate output. Cache fields
remain named subsets and are not added again. Missing vendor fields are `null`,
never zero.

Record `claude_agentic_turns` and `codex_top_level_turns` as separate integer-or-null
fields. For 20a, the Codex field is `null`. These fields have different meanings
and must not feed a combined turn comparison.

## Fixture and execution layout

The tracked fixture contains a testable specification, its fixed oracle, and
incomplete starter behavior. Keep all desired behavior in the initial
specification and tests. The planner selects unmet product work from evidence.
It never creates, weakens, or rewrites the oracle to make an iteration pass.

The tracked starter is expected red. `tools/tests/test_hoh_loop.py` must pass by
running its product tests in an initial disposable copy and matching the exact
declared failing test IDs and observations. An arbitrary failure is a harness
failure. Only the completed disposable candidate must make every product test
pass. Never require the tracked starter's product test command to exit green.
Use the standard-library `unittest` runner. Do not install `pytest`.

Mount a read-only source bundle at `/opt/vivary-hoh-source`, outside the proof
tree. Set `HABITAT_TASK_HOST_ROOT` to the verified persistent Habitat work root,
then bind `${HABITAT_TASK_HOST_ROOT}/vivary-hoh-proof` to the container path
`/tmp/vivary-hoh-proof`. Verify the actual source, target, filesystem, and
options before any model call. Do not bind the production checkout. Mount
only the existing Claude authentication volume into the trusted CLI host. Do
not expose it through a role filesystem or a model-selected tool. Leave every
other `/tmp` path on its normal temporary filesystem.

Use a verified separation boundary. One supported composition to prove is a
Claude host with all built-in tools disabled and only explicit, scoped MCP
tools whose worker filesystem has no authentication mount or credential
environment. The worker may read its public inputs and perform role-authorized
candidate operations. It may not execute arbitrary commands in the authenticated
host. Keep native session/authentication handling in the CLI. Do not create new
credential storage or copy authentication into a tool worker.

Before acceptance, use a synthetic credential canary to prove every model tool
cannot read it through paths, links, environment variables, process files, or
shell execution. The CLI must still authenticate through its existing native
state. Missing isolation stops the runtime proof. Deterministic candidate tests
run in a credential-free, network-disabled sandbox, never in the trusted WSL
control process.

Materialize the tracked fixture from the read-only bundle into a private Git
repository in the persistent proof tree. Create one initial commit with fixed
commit metadata, record its commit and tree hashes, and never write through its
baseline checkout. Every healthy or fault run uses a distinct disposable
worktree or copy from that commit. A later run may restore or rematerialize the
baseline only when the resulting commit, tree, and common file hashes equal the
20a receipt.

Use these explicit private paths in Habitat:

| Run | Project path | Receipt root |
| --- | --- | --- |
| Healthy Claude proof | `/tmp/vivary-hoh-proof/20a/claude/healthy/project` | `/tmp/vivary-hoh-proof/20a/claude/healthy/receipts` |
| Resume fault | `/tmp/vivary-hoh-proof/20a/claude/resume-fault/project` | `/tmp/vivary-hoh-proof/20a/claude/resume-fault/receipts` |
| Regression fault | `/tmp/vivary-hoh-proof/20a/claude/regression-fault/project` | `/tmp/vivary-hoh-proof/20a/claude/regression-fault/receipts` |

Do not run a fault against the healthy project or receipt root. Never use
`git reset` or `git clean` on the Vivary checkout or another user project.
Keep the baseline and evidence after the task container stops. Before export,
resolve the absolute preserved Littleagent checkout as `LITTLEAGENT_ROOT` and
record that value privately. Choose `evidence.tar.gz` and `manifest.json` as
the output filenames. Run each host-side check separately and require a match
for each exact path before writing either file:

```console
git -C "$LITTLEAGENT_ROOT" check-ignore -v -- .tmp/hoh-proof/20a/evidence.tar.gz
git -C "$LITTLEAGENT_ROOT" check-ignore -v -- .tmp/hoh-proof/20a/manifest.json
```

Verify each resolved output stays inside that checkout's `.tmp/hoh-proof/20a/`.
Apply the same separate ignore and containment checks to every temporary output
path before creating it. A match on another filename is insufficient. Refuse
existing output files; preserve prior evidence rather than overwriting it.
Export a hash-bound evidence archive
and manifest to `${LITTLEAGENT_ROOT}/.tmp/hoh-proof/20a/`. Never resolve that
relative suffix against the Vivary checkout. Include mount evidence, the baseline bundle, receipt
indexes and details, candidate bindings, raw usage records, and command output.
Exclude authentication data and provider transcripts. Record the archive and
manifest hashes in the tracked 20a receipt.

## Owned files

- Consume the fixture, prompts, protocol, sequencer, adapter, and tests accepted
  by [20c](20c-headless-loop-preparation.md). Make only bounded fixes needed by
  live enforcement, with regression tests. Any changed fixture or prompt hash
  establishes a new baseline before all three healthy iterations and both faults.
- Create `docs/product/multi-project/receipts/20a-headless-loop-proof.md`.
- Update this packet's status and log, then regenerate the graph.
- Update `CHANGELOG.md` at closure and run the approved canonical site sync.
  Commit its generated changelog and `llms-full.txt` mirrors with the receipt.
- At 20a closure, materialize
  `docs/product/multi-project/packets/20b-codex-loop-parity-proof.md` from the
  tracked continuation contract below. Set `Depends-on: [20a]` and its status
  from verified Codex prerequisites in the same change that marks 20a done.

The private baseline, candidate worktrees, detailed receipts, and CLI output
are runtime outputs. Do not commit them as product source.

## Required 20b continuation

Before 20a closes, create packet 20b with `Parent: 20`, `Depends-on: [20a]`,
owner `Codex loop parity agent`, and a one-context-window timebox. Set
`Status: ready-for-agent` only when its native authentication and required
pre-call budget bound are verified. Otherwise set `Status: needs-info` and
name the missing capability and runtime integration maintainer in `Needs`.
In the same graph-valid update, mark 20a done, bind its receipt, and render the
graph. Make 20b the frontier only if it is ready. An unfinished 20a is a start
gate, not a reason to mark 20b `needs-info`.

Packet 20b owns only `tools/hoh/codex.py`,
`tools/tests/test_hoh_codex.py`, its packet and receipt, the graph update,
`CHANGELOG.md`, and its generated site changelog and `llms-full.txt` mirrors.
It may make bounded adapter-registration changes in `tools/hoh/protocol.py` or
`tools/hoh_loop.py` when required. It must not change the common schema,
transition semantics, role prompts, fixture oracle, or Claude adapter to make
parity pass. It uses the shared tests-only `tools/tests/hoh_fault_probe.py`.

The packet runs Codex `0.143.0` through the live-preflighted Habitat adapter. It
uses the same expected-red harness contract, role-specific views, tool
permissions, immutable baseline commit, tree, specification, oracle, and prompt
hashes as 20a. It never starts from Claude's modified project. Restore the 20a
baseline and evidence from the verified persistent bind or the ignored
Littleagent archive, then compare every hash before the first Codex model call.
Keep native Codex authentication outside every model tool's filesystem and
environment. Prove the same credential-canary refusals with the installed
adapter. Do not assume that read-only mounts deny reads or that a Claude flag
exists in Codex. Do not expose the Docker socket to a role container.

Give 20b a separate 100,000-token ceiling covering healthy, fault, retry, and
preflight calls. Apply the 20a usage field definitions and cache mapping rule.
Preserve `vendor_usage_raw` and normalize input, output, cache read, and cache
write fields without double counting. Require and reserve a verified maximum
whole-invocation charge before each call, with the same refusal and incomplete-
accounting rules as 20a. Missing enforcement blocks only live Codex execution.
Record `codex_top_level_turns` while
`claude_agentic_turns` is `null`. Record prompt bytes and SHA-256. All model
calls atomically advance `/tmp/vivary-hoh-proof/20b/usage.json`. Repeating the
budget argument in a new process verifies the ceiling without resetting spend.

Run three healthy Codex iterations and both fault cases in the corresponding
`/tmp/vivary-hoh-proof/20b/codex/` project and receipt roots. Require the
completed candidate's product tests to pass. Use these exact verification and
runtime commands:

```console
findmnt -T /tmp/vivary-hoh-proof -o TARGET,SOURCE,FSTYPE,OPTIONS
findmnt -T /opt/vivary-hoh-source -o TARGET,SOURCE,FSTYPE,OPTIONS
python tools/tests/test_hoh_loop.py
python tools/tests/test_hoh_codex.py
python tools/hoh_loop.py --project /tmp/vivary-hoh-proof/20b/codex/healthy/project --iterations 3 --runtime codex --receipt-dir /tmp/vivary-hoh-proof/20b/codex/healthy/receipts --reported-token-budget 100000 --usage-ledger /tmp/vivary-hoh-proof/20b/usage.json
python -m unittest discover -s /tmp/vivary-hoh-proof/20b/codex/healthy/project/tests -p 'test_*.py'
python tools/tests/hoh_fault_probe.py resume --runtime codex --project /tmp/vivary-hoh-proof/20b/codex/resume-fault/project --receipt-dir /tmp/vivary-hoh-proof/20b/codex/resume-fault/receipts --reported-token-budget 100000 --usage-ledger /tmp/vivary-hoh-proof/20b/usage.json
python tools/tests/hoh_fault_probe.py regression --runtime codex --project /tmp/vivary-hoh-proof/20b/codex/regression-fault/project --receipt-dir /tmp/vivary-hoh-proof/20b/codex/regression-fault/receipts --reported-token-budget 100000 --usage-ledger /tmp/vivary-hoh-proof/20b/usage.json
```

The resume probe must continue from the same committed developer checkpoint or
classify the run as a restart and leave the first run incomplete. The regression
probe injects one implementation fault before the QA freeze and never changes
the oracle or prompts. Both probes preserve healthy evidence.

The 20b receipt compares required keys, types, nullability, stage bindings,
evidence categories, prompt hashes, usage accounting, and unavailable-value
semantics across both runtimes. Runtime, model, flags, values, plans, candidate
hashes, observations, and outcomes may differ. Claude agentic turns and Codex
top-level turns remain separate. Make no runtime quality claim. Missing Codex
authentication changes only 20b to `needs-info`, with the exact restoration
owner. A missing, failed, or partial Codex run leaves parity incomplete. Never
substitute an API key or fabricate evidence.

Before 20b exports, check each exact output separately and require a match:

```console
git -C "$LITTLEAGENT_ROOT" check-ignore -v -- .tmp/hoh-proof/20b/evidence.tar.gz
git -C "$LITTLEAGENT_ROOT" check-ignore -v -- .tmp/hoh-proof/20b/manifest.json
```

Verify each resolved output stays inside that checkout's `.tmp/hoh-proof/20b/`.
Check every temporary output path the same way before creating it. Refuse
existing output files. Then export
there. The tracked receipt binds both restored 20a evidence and new
20b evidence. Update the canonical changelog with the actual proof status and
generate its site mirrors before closing either runtime packet.

The 20b owner retains the persistent proof tree until independent parity review
and a restore-and-hash check of both exported archives pass. Then that owner
prepares an itemized cleanup receipt: exact task paths and container names,
stopped-process evidence, reachable baseline commits, archive/manifest hashes,
and the restoration result. Request approval for each removal operation. No
authentication volume, image, proxy, production mount, or other agent's data is
a cleanup target. Until approval, record the cleanup owner and a review-by date
seven days after closure in the existing receipt. Surface an overdue decision
at the next handoff without scheduling a job. The archives remain the evidence
input for outcome 04; their later removal needs that owner's acceptance and a
separate approved operation.

At 20a closure, move this continuation contract into the canonical 20b packet
and replace this section with a link to 20b in the same graph-valid update.
Canonical 20b then becomes the only owner of its detailed contract.

## Done condition

1. The Claude Code adapter completes three iterations from the immutable
   baseline in one healthy disposable project. The runtime, model, role
   definitions, runtime policy, specification, oracle, and prompts stay fixed.
2. The green sequencer harness proves the tracked starter has the exact declared
   expected-red product-test result. Only the completed disposable candidate has
   a green product-test result.
3. Before each role and after each iteration, the receipt records the baseline
   commit and tree hashes plus the specification, oracle, and three role-prompt
   hashes. A mismatch halts the run.
4. Each iteration binds the starting candidate hash, development-document hash,
   developer result hash, frozen QA candidate hash before and after assessment,
   deterministic test output, and QA evidence-report hash. The two frozen
   candidate hashes must match.
5. Evidence entries distinguish verified, unmet, and failed behavior and cite
   an observation. Iteration two preserves every verified iteration-one
   behavior, selects at least one unmet item, and shows a failed observation
   changing the plan.
6. Each role reads the `index.md` under its exact receipt root. The receipt
   records every detail file opened plus the prompt bytes and SHA-256 hash for
   each role and iteration.
7. Mount and permission evidence proves that the planner cannot access the
   candidate tree, the developer can write only the candidate, and QA can read
   only the frozen candidate and public evidence.
8. The resume fault stops the sequencer once after the committed developer checkpoint and
   before QA. Starting the sequencer again with the same fault project and
   receipt root resumes the same run without rerunning the developer or
   accepting an unassessed candidate. Classify this as `resume`. If bindings do
   not prove safe continuation, classify it as `restart`, create a new
   disposable run, and keep the interrupted run incomplete.
9. The regression fault uses its own disposable project. A controlled harness
   fault changes only candidate implementation before the QA freeze so a
   previously passing behavior fails. The sequencer halts, names the regression,
   and preserves the healthy proof. It does not change the oracle or prompts.
10. `vendor_usage_raw` and the normalized input, output, cache, budget-total,
    and separate turn fields bind every live call. Each call has a prior verified
    reservation that fits the balance. The total never exceeds 100,000. Unknown
    bounds or incomplete accounting cannot release or authorize usage.
11. The receipt records wall time and the subscription used. No API-key spend,
    unit result, or fake-adapter result can replace live evidence.
12. The mount record and exported evidence archive preserve the baseline,
    healthy proof, and both fault results after the task container stops.
13. Record line count and function size per iteration. State the proof's limits:
   one project, one fixture, three iterations, no equal-token long-session
   comparison, no Codex parity, and no broader quality-decay measurement.
14. Before closing 20a, create packet 20b with the prescribed Codex adapter,
    three iterations, both isolated fault runs, and common-schema comparison.
    Mark 20a done and set 20b's status from its verified prerequisites in one
    graph-valid update. An unsupported Codex budget bound keeps 20b `needs-info`.

## Verify

First run the deterministic sequencer, adapter, and fixture tests:

```console
python tools/tests/test_hoh_loop.py
```

Before a model call, verify the persistent proof bind and read-only source
bundle. Then materialize the baseline and three Claude worktrees at the paths
above:

```console
findmnt -T /tmp/vivary-hoh-proof -o TARGET,SOURCE,FSTYPE,OPTIONS
findmnt -T /opt/vivary-hoh-source -o TARGET,SOURCE,FSTYPE,OPTIONS
```

Run the healthy proof and the completed candidate's product tests:

```console
python tools/hoh_loop.py --project /tmp/vivary-hoh-proof/20a/claude/healthy/project --iterations 3 --runtime claude --receipt-dir /tmp/vivary-hoh-proof/20a/claude/healthy/receipts --reported-token-budget 100000 --usage-ledger /tmp/vivary-hoh-proof/20a/usage.json
python -m unittest discover -s /tmp/vivary-hoh-proof/20a/claude/healthy/project/tests -p 'test_*.py'
```

The tests-only fault probe calls the sequencer's tested public Python API. It
stops after a committed developer checkpoint for resume and injects one known
candidate fault before the QA freeze for regression. Run:

```console
python tools/tests/hoh_fault_probe.py resume --runtime claude --project /tmp/vivary-hoh-proof/20a/claude/resume-fault/project --receipt-dir /tmp/vivary-hoh-proof/20a/claude/resume-fault/receipts --reported-token-budget 100000 --usage-ledger /tmp/vivary-hoh-proof/20a/usage.json
python tools/tests/hoh_fault_probe.py regression --runtime claude --project /tmp/vivary-hoh-proof/20a/claude/regression-fault/project --receipt-dir /tmp/vivary-hoh-proof/20a/claude/regression-fault/receipts --reported-token-budget 100000 --usage-ledger /tmp/vivary-hoh-proof/20a/usage.json
```

Record each invocation, checkpoint, injected hash, usage sample, and result in
the receipt. Do not add a production fault flag to `tools/hoh_loop.py`.

A second reader traces each tracked receipt claim to a private hash or captured
command output. Then run the common planning checks from
[the execution contract](../execution-contract.md#maintaining-the-graph).

## Stop conditions

Use no paid API key, GUI, Agent-Native server, change under `packages/`,
scheduled job, or network beyond Claude Code's provider through the Habitat
proxy. Use no more than three healthy iterations and the two named fault runs.
Stop each iteration after one hour or the packet at its context-window boundary.
Stop before starting any role call without an enforceable, verified maximum
charge that fits the remaining token balance. Also stop on any credential-canary
exposure or failed role isolation. No accounting-only fallback satisfies these
requirements.

Stop if fixture tests cannot run, the installed CLI cannot enforce the role's
authority, the proxy cannot reach Claude Code, usage cannot be bound to the
role, two consecutive iterations make no candidate or evidence progress, or any
frozen candidate, oracle, or prompt hash changes. Preserve all healthy evidence
when a fault run stops.

If existing Claude Code subscription authentication is missing, change only
20a to `needs-info`. Add a `Needs` field naming restoration of that Habitat
authentication and its human or environment owner. Never substitute an API key,
copy credentials, fabricate a run, or mark 20a complete. Stop only the
packet-owned task container after the session. Do not remove the persistent
proof tree, 20a evidence archive, or manifest before 20b restores and verifies
them.

## Log

- 2026-09-06: Packet created from the scoped effect of [the direction decision](../design.md#direction-decision-2026-09-06). Implementation has not started.
- 2026-09-06: Corrected the execution boundary to one Claude Code proof in one context window. Codex parity moves to packet 20b, which is materialized only when 20a closes so the packet dependency and generated frontier remain valid.
- 2026-09-06: Review tightened the expected-red starter oracle, planner isolation, tests-only fault probe, usage ceiling, and durable evidence handoff. No runtime implementation started.
- 2026-09-06: PR #335 review required pre-admission token reservations and credential isolation. The installed Claude CLI has no documented whole-invocation token bound, so live calls remain stopped and this packet needs that concrete capability or an approved policy alternative. Offline tools and subscription authentication passed. The execution contract permits independent available work.
- 2026-09-06: Packet 20c owns claimable deterministic preparation while only this live proof remains blocked. Export checks now bind every actual archive, manifest, and temporary output path before writing it.
