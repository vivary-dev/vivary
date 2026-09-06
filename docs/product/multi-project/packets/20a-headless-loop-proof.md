# 20a: Prove one headless planning, coding, and testing loop on files

Type: packet
Parent: 20
Status: ready-for-agent
Depends-on: [10c]
Owner: loop proof agent
Scope: One fixture code project and three iterations of planner, developer, and QA tester as headless subscription coding-agent sessions with files between them; no GUI, no Agent-Native server, no change under `packages/`, no new scheduler, no paid API key.
Verification-kind: runtime
Timebox: One context window per iteration set. Stop after three iterations plus the two fault cases, or at a stop condition, and write the receipt.

## Goal

Run the Harness-of-Harness-shaped loop on files with the owner's own coding-agent
subscription and record what three iterations produce: a receipt per stage,
evidence records the next planner consumes, a verified behavior that survives
replanning, and a failed observation that changes the next plan. This is the
first execution of the loop the program depends on. Per
[the direction decision](../design.md#direction-decision-2026-09-06) it precedes
any GUI use of the loop and is claimed before other ready packets.

## Context

Read [the direction decision](../design.md#direction-decision-2026-09-06),
[the alignment brief](../research/hoh-direction-brief.md) sections 1, 3, and 8,
[the HoH comparison](../research/hoh-alignment.md), outcome
[20](../tickets/20-run-bounded-factory.md), [the execution contract](../execution-contract.md),
`packages/core/vivary_core/receipt.py` for fingerprint binding, and
[10c](10c-habitat-fallback-proof.md) for the environment. The HoH role prompts
are in the paper's PDF appendix A.2 (arXiv 2609.01481v1, pages 22 to 25; the
HTML drops them). The Fusepoint repository (`Flesymeb/fusepoint`, branch
`gameloop`, `.gameloop/receipts/`) shows the record shapes: a planner receipt
carries gap records, preservation constraints, verified records, and validation
requirements; a tester receipt carries the candidate hash before and after
assessment.

The subscription CLIs enforce role boundaries better than the paper did, where
most boundaries were prompt instructions. `claude -p --allowedTools` restricts
the tool set per session and `codex exec --sandbox read-only` restricts writes.
Use those flags as the role boundary and record them. A sequencer that starts
three CLI sessions and passes files between them is not a second reasoning
loop, transcript store, or scheduler; the coding agent keeps its own loop and
session state.

The offline container used by 10c has no network and cannot run a coding
agent. Use the Habitat sandbox (WSL2 distro `habitat`) through its allowlist
proxy, where the owner's Claude Code authentication was confirmed on
2026-09-01, without copying credentials.

## Owned files

- Create `docs/product/multi-project/fixtures/hoh-loop/spec.md`: the fixture
  specification, a Markdown relative-link checker command-line tool with
  under ten acceptance checks, and its `tests/` suite, which is the oracle.
- Create `tools/hoh_loop.py`: the sequencer. It builds each role's prompt from
  files, runs the CLI headless with that role's tool restriction, validates
  the role's JSON output against a schema with one retry, snapshots and hashes
  the candidate before QA, runs the fixture test command itself and hands the
  results to QA, writes `.hoh/loops/NNNN/` receipts and `.hoh/index.md`, and
  commits after each stage.
- Create `docs/product/multi-project/receipts/20a-headless-loop-proof.md`.
- Update this packet's log and regenerate the graph.

## Done condition

1. Three iterations complete on the fixture with the same model, harness, role
   prompts, and policy. The receipt records every version and flag.
2. Each iteration binds the base candidate hash, the development document
   hash, the developer's resulting candidate hash, the frozen candidate hash
   QA assessed (equal before and after), the test results, and the QA evidence
   report. Only the developer session has write tools. Planner and QA sessions
   run with read-only tool sets enforced by CLI flags.
3. The evidence report carries verified, unmet, and failed entries, each bound
   to an observation. Iteration two's development document lists every
   iteration-one verified behavior as a preservation constraint and selects at
   least one iteration-one gap as a target. Show one failed observation
   changing the next plan.
4. Roles receive `.hoh/index.md` and open detail files on demand. Record the
   prompt token count per role per iteration.
5. Fault cases: stop the sequencer between developer and QA once, restart it,
   and show it resumes from the receipts without re-running the developer or
   accepting an unassessed candidate. Force one regression (a test that passed
   in iteration one fails in iteration two) and show the run halts with a
   report naming the regressed behavior.
6. Record wall time, turns, and tokens per role per iteration from the CLI's
   usage output, and the subscription used. No API key spend.
7. State what the proof cannot show: one project, one fixture, three
   iterations, no comparison against a single long session, and no quality
   decay measurement beyond a per-iteration line count and function size
   report.

## Verify

```console
python tools/hoh_loop.py --project docs/product/multi-project/fixtures/hoh-loop --iterations 3 --runtime claude --receipt-dir .hoh
python -m pytest docs/product/multi-project/fixtures/hoh-loop/tests -q
python scripts/check_multi_project_plan.py --check
```

Run in the Habitat sandbox through its allowlist proxy. Record the exact CLI
versions, model, and flags. Then run the two fault cases from the done
condition and record both outcomes in the receipt. A second reader traces each
receipt claim to a hash or a command output before the packet closes.

## Stop conditions

No paid API key, no GUI or Agent-Native server, no change under `packages/`,
no scheduled job, no network beyond the coding agent's own provider through the
proxy, no more than three iterations plus the two fault cases, and one hour of
wall clock per iteration. Stop when the fixture tests cannot run in the
environment, when the CLI cannot restrict tools per role, when the Habitat
proxy cannot reach the provider, or when a candidate hash changes during QA.
Name the concrete prerequisite and stop only the dependent step. Stop the
sandbox after the session.

## Log

- 2026-09-06: Packet created from the owner's loop-first and code-first decisions. Not started.
