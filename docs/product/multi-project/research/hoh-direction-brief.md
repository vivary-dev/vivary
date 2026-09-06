# Harness-of-Harness and Vivary, an alignment brief

Date: 2026-09-06. Status: the owner answered the three questions in section 9
the same day. The decisions are recorded in
[design.md](../design.md#direction-decision-2026-09-06) and carried by packet
20a and the logs of outcomes 18, 19, 20, 30, and 36. Sections 1 to 8 stand as
the reasoning and make no implementation claim. Every number was traced to
the page cited beside it on 2026-09-06.

## 1. What Harness-of-Harness does, in plain terms

The name is literal. Your coding agent (Codex CLI, OpenCode, Pi, or Claude
Code) is the inner harness. HoH is an outer harness: a loop that starts three
short agent sessions in a fixed order, passes files between them, and commits
to git after each one. There is no memory service, no database, and no new
agent framework. [Paper](https://arxiv.org/html/2609.01481v1),
[repository](https://github.com/Flesymeb/HarnessOfHarness).

One iteration:

| Step | Role | Reads | Writes | May not |
| --- | --- | --- | --- | --- |
| 1 | Planner | The specification, the last evidence report, an index of past plans and reports | One development document: a single bounded objective plus how to validate it | Touch the code |
| 2 | Developer | The development document and the code as it stands | The code. Runs tests while working, a baseline before and a retest after each meaningful change | Change the objective |
| 3 | QA tester | A frozen, read-only copy of the code, the development document, the specification, and deterministic build and run results | One evidence report: behaviors verified, claims unmet, failures observed | Edit anything |

Two things carry forward to the next iteration. The paper calls them the
artifact state (the code, configuration, resources, and metadata) and the
evidence state (that evidence report). The next planner treats every verified
behavior as a constraint it must not break and every gap or failure as a
candidate objective.

The fix-versus-feature balance is not an algorithm. It is one line in the
planner prompt, published only in the PDF appendix (the arXiv HTML drops
those pages): "Prioritize blockers and regressions before product extensions.
Select at most three achievable priorities." Fix first, then extend, at most
three targets per loop.

Role independence is also lighter than the prose suggests. All three roles
run the same model, harness, and configuration. The planner and tester
prompts say "Do not implement, edit, test, or inspect production code" and
"Do not modify production code." Those are instructions, not sandbox rules.
What is enforced mechanically is the output schema (a violation triggers a
retry) and, in the case study, freezing: each tester receipt records the
candidate's source hash before and after assessment, and in loop 1 the two
match. The Runtime that does
the freezing, hashing, and evidence binding is not published. The GitHub
repository holds a README, images, and videos, and lists the code as coming
soon.

History is handled by what the authors call progressive disclosure. Plans and
reports sit in the file system behind a short categorized index. A role reads
the index and opens a detail file only when it needs it. The authors offer
this "rather than a dedicated memory module."

What stays fixed is stated once: "The model, base harness, role definitions,
and runtime policy remain fixed within a run; the development document,
software artifact, and execution evidence evolve across iterations." So HoH
does not learn between projects. The product gets better. The agent does not.

### The numbers

Vanilla harness (T=0) against three HoH iterations (T=3), as printed:

| Benchmark | Harness and model | T=0 | T=3 | Gain |
| --- | --- | ---: | ---: | ---: |
| GameCraft-Bench overall | Codex CLI, GPT-5.5 high | 49.58 | 71.52 | +21.93 |
| GameCraft-Bench overall | OpenCode, DeepSeek-V4-Pro | 26.90 | 48.98 | +22.08 |
| GameCraft-Bench overall | Pi, MiniMax-M3 | 42.16 | 58.78 | +16.62 |
| FrontierSWE reward | Codex CLI, GPT-5.5 high | 0.21 | 0.30 | +0.09 |
| FrontierSWE reward | OpenCode, DeepSeek-V4-Pro | 0.08 | 0.15 | +0.07 |
| FrontierSWE reward | Pi, MiniMax-M3 | 0.06 | 0.11 | +0.05 |
| ProgramBench pass rate | Codex CLI, GPT-5.5 high | 60.41 | 66.50 | +6.09 |
| ProgramBench pass rate | OpenCode, DeepSeek-V4-Pro | 45.27 | 57.56 | +12.29 |
| ProgramBench pass rate | Pi, MiniMax-M3 | 35.83 | 52.68 | +16.85 |

The abstract's "52 percent average" and "83 percent maximum" are relative
gains. On FrontierSWE the Codex pair kept climbing: dominance 27.33 at T=0,
39.33 at T=3, 72.67 at T=10. The multi-day case study ran 70 iterations with
Codex CLI and GPT-5.6-Sol and produced a playable first-person shooter.

The ablation is the part to remember. GameCraft-Bench, Codex pair, full HoH
scores 71.52:

| Remove | Score | Cost |
| --- | ---: | ---: |
| Plan revision from evidence | 63.39 | -8.13 |
| Evidence feedback to the planner | 65.23 | -6.28 |
| Warm start from the previous code | 63.67 | -7.85 |

Each mechanism is worth six to eight points on its own. A product that copies
only the evidence file and skips the plan revision or the carry-forward keeps
less than half the gain.

What the paper does not show: learning across projects, a human in the loop,
any task outside code, or a comparison against one long session with the same
token budget. GameCraft used 45 of 140 tasks and FrontierSWE 15 of 17. There
is no ablation that removes the independent QA tester, so "what breaks without
QA" is untested. Task sampling is seeded, generation is not, and there is one
run per condition. The paper has no limitations section. The abstract's 52.25
and 82.86 percent appear nowhere else in the text and are not defined. The
HoH research lane reproduced them as the mean and maximum of nine relative
gains, using the FrontierSWE dominance score, which is a win rate against a
pool that includes HoH's own checkpoints.

### The flagship run, as its public record shows it

The multi-day case study, Fusepoint, publishes a development record on
GitHub. [Flesymeb/fusepoint, branch gameloop](https://github.com/Flesymeb/fusepoint),
read 2026-09-06. It is rougher than the paper's narrative.

| Field across 96 loops | Count |
| --- | ---: |
| QA tester status FAIL | 93 |
| QA tester status PASS | 2 |
| QA tester status UNTESTED | 1 |
| Developer status PASS | 67 |
| Developer status NEEDS VISUAL QA | 28 |
| Loop state BLOCKED | 90 |
| Loop state PHASE PASS | 2 |

The persistent issue ledger ends at 94 closed, 7 open, 101 total. The record
names one phase, `combat_readability`, across most loops. The version-control
binding carries a run id ending in `retry6` and an archived restart bookmark,
which suggests the published run is at least the seventh attempt. That last
point is an inference from a filename, not a stated fact. The README states
that detailed provenance "remains in the private GameLoop Runtime audit."
Appendix B.8 describes a source-blinded human playtest using the Player
Experience Inventory and refers to a main-paper results table. That table is
not in the PDF. The number of playtesters is not stated.

Two readings fit the data. One: the design works as intended, the tester
refuses to infer success, and FAIL is the honest steady state. Two: the loop
spends most of ninety iterations in one phase without clearing its gate. The
public record cannot separate them. Either way, "70 iterations produced a
playable game" is the authors' claim plus two videos, not a measured result.

One hole matters for a 70-iteration run. HoH gates every iteration on tests
passing, not on code quality. SlopCodeBench measured 15 agents extending their
own code across 196 checkpoints: structural erosion rose in 77 percent of
trajectories and verbosity in 75.5 percent while checkpoints kept passing.
Agent code was 2.3x more verbose and 2.0x more eroded than 473 human
repositories. Quality instructions cut the starting level by up to a third
"without affecting degradation rates."
[2603.24755](https://arxiv.org/abs/2603.24755). A loop that runs for days
needs a decay check beside its pass check.

## 2. There are two loops, and you are describing both

| Loop | What improves | Signal | Who does it |
| --- | --- | --- | --- |
| Inner | The product of one project | Evidence from testing that product | HoH, Self-Refine, Reflexion |
| Outer | The skills, instructions, or harness reused across projects | Aggregate outcome over many tasks, held out from whoever proposes the change | WikiSkill, ACE, autoresearch, GRASP, Darwin Gödel Machine |

HoH is an inner loop. The "agent adopts lessons from previous sessions" idea
is an outer loop. They need different guards, and mixing them is where most
of the failures in section 3 come from.

Vivary already named both. `packages/strato/STRATO.md` describes one loop,
`Ask → retrieve → act → verify → learn → gate`, per turn, and a heartbeat that
runs `learn` on a slower clock. That is the inner and outer loop in one
sentence, written before either paper. As of 2026-09-06 no Python in
`packages/` implements a `learn` step. The loop exists as prose.

## 3. What the outer-loop evidence says

Each line is a rule the sources support, with the number that supports it.

1. **No gate, no gain.** Library Drift reports, citing SkillsBench, that
   LLM-authored skills delivered +0.0 points while human-curated skills
   delivered +16.2. Its own fix, outcome-driven retirement plus a cap on
   active skills, lifted pass@1 from 0.258 to 0.584 over 100 rounds.
   [2605.19576](https://arxiv.org/abs/2605.19576). GRASP admits a skill edit
   only when it nets an improvement on a held-out probe under a regression
   budget, lifting gpt-oss-120b from 40.6 to 88.8 percent on MedAgentBench.
   Its ablation: unvalidated skill writing is no better than no skills.
   [2605.29668](https://arxiv.org/abs/2605.29668).
2. **Lessons compile into skills. They do not get loaded into every agent's
   context.** WikiSkill: giving the proposer access to the experience wiki
   raised average score from 48.7 to 63.7 percent. Also giving the working
   agent that wiki during rollouts lowered it to 60.9. The authors' reason:
   the agent solves tasks from the wiki instead of the skills, so its
   trajectories stop showing the failures the skills exist to fix.
   [2608.27454](https://arxiv.org/html/2608.27454).
3. **Patch memory, never rewrite it.** ACE names two failure modes of naive
   rewriting: brevity bias ("drops domain insights for concise summaries")
   and context collapse ("iterative rewriting erodes details over time"). Its
   incremental updates score +10.6 on agent benchmarks and +8.6 on finance.
   [2510.04618](https://arxiv.org/abs/2510.04618).
4. **Revoke what the world has overtaken.** TEPA: under a full reversal of
   facts, append-only memory and last-write-wins both scored 0.210, no memory
   scored 0.309, and explicit revocation scored 0.950. Stale memory is worse
   than none. [2608.07429](https://arxiv.org/abs/2608.07429).
5. **Bound the library.** Pass rate fell by up to 21 percent going from a
   small helpful set to a 202-skill library, mostly because the agent picks
   the wrong skill more often as the library grows.
   [2605.24050](https://arxiv.org/abs/2605.24050).
6. **Promote insights, never traces.** Memory Transfer Learning: a
   cross-domain memory pool gained 3.7 percent on average, driven by
   "meta-knowledge, such as validation routines." Low-level traces "often
   induce negative transfer due to excessive specificity."
   [2604.14004](https://arxiv.org/abs/2604.14004). A separate study found raw
   trajectory reuse gave -9.5 percent forward transfer on ALFWorld.
   [2604.27003](https://arxiv.org/html/2604.27003).
7. **Corrections become checks, not notes.** TRACE compiles each user
   correction into a rule and a runtime check that must pass before the agent
   may declare a task done. Out of distribution, violations fell from 100.0 to
   2.0 percent. A memory baseline left 57.5 percent of checks violated.
   [2606.13174](https://arxiv.org/abs/2606.13174).
8. **A cheap objective plus a fixed budget plus keep-or-discard.** Karpathy's
   autoresearch lets the agent edit one file, trains for a fixed five minutes,
   and keeps the change only if `val_bpb` drops. Red Hat ran 198 experiments
   in 24 hours with zero intervention: 29 kept, 164 reverted, 5 crashes, 2.3
   percent improvement. [README](https://github.com/karpathy/autoresearch),
   [Red Hat](https://developers.redhat.com/articles/2026/04/07/autoresearch-on-red-hat-openshift-ai-198-experiments-zero-intervention).
9. **Background consolidation saves compute but ships without a human gate.**
   Sleep-time compute reports about 5x less test-time compute for equal
   accuracy. [2504.13171](https://arxiv.org/abs/2504.13171). Letta's shipped
   version, dreaming, fires after N steps or on compaction, and its only
   review option is a second model pass that "does not ask you for approval."
   [Letta docs](https://docs.letta.com/configuration/memory).
10. **A model's opinion is not a gate.** A reference-free judge inflated pass
    rate from 0.72 to 0.94 while true accuracy stayed 0.20. Forcing the judge
    to commit its own expectation before reading cut false positives from
    0.719 to 0.012. A 2026 case report has agents reading cached answer keys
    to hit a 100 percent pass rate over 68 percent real capability.
    The first two figures are carried from the owner's wikiskill `sources.md`
    verification of 2026-08-29 (arXiv 2607.05904, tier T3). The third:
    [2609.02246](https://arxiv.org/abs/2609.02246).

11. **Whatever proposes a change needs raw traces, not summaries.**
    Meta-Harness searches over harness source code with Claude Code (Opus
    4.6) as the proposer, about 20 iterations and 40 candidates per run. Its
    ablation: a proposer given scores only reached a median of 34.6, scores
    plus LLM summaries 34.9, and full filesystem access to source, scores,
    and execution traces 50.0. Its best discovered harness beat a
    reference context manager by 7.7 points using 4x fewer context
    tokens. No GPU, one subscription agent.
    [2603.28052](https://arxiv.org/abs/2603.28052). This is the closest
    published match to a file-based workspace that improves its own harness.
12. **Regression-aware acceptance has a price tag.** HarnessFix repairs one
    harness artifact per diagnosed flaw, from traces. On GAIA the full system
    scored 61.7. Without regression-aware acceptance, 55.6. Without trace
    diagnosis, 51.1. Without scoped operators, 50.6. Prompt-only repair,
    50.6. Baseline, 43.3. [2606.06324](https://arxiv.org/abs/2606.06324).
13. **Evidence is bound to the exact source state it tested.** Proof-or-Stop
    allows a lifecycle transition (reviewed, tested, done) only on "fresh,
    tracked-source-state-bound, mechanically verifiable evidence." Any source
    change stales prior evidence. Enforced gating let 2 bad results through
    out of 1,800 against 14 for advisory review.
    [2607.14890](https://arxiv.org/abs/2607.14890). Vivary receipts already
    bind a workspace fingerprint. This is the paper behind that design.

Letta's own migration is worth one line. Its context repositories put memory
in Markdown files under git, commit every edit, and load only a `system/`
directory every turn. [Letta, 2026-02-12](https://www.letta.com/blog/context-repositories/).
That is the Vivary design, arrived at independently.

## 4. Fleets and specialists

Anthropic's research system: agents use about 4x the tokens of chat and
multi-agent systems about 15x. Token usage alone explained 80 percent of the
variance on its evaluation. Its Opus lead with Sonnet subagents beat single
Opus by 90.2 percent on research. The same post says coding tasks "involve
fewer truly parallelizable tasks than research" and recommends artifact
systems where subagents' outputs "persist independently" instead of flowing
through the lead. [Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system).

MAST annotated 150 traces across seven frameworks into 14 failure modes in
three categories, and opens with the finding that multi-agent gains "on
popular benchmarks are often minimal." [2503.13657](https://arxiv.org/abs/2503.13657).

The largest controlled study, 260 configurations across six benchmarks, five
architectures, and three model families with tools, prompts, and compute held
equal, finds "coordination yields diminishing returns once single-agent
baselines exceed certain performance." The effect of adding agents ranged
from +80.8 percent on decomposable financial reasoning to -70.0 percent on
sequential planning. Architectures without centralized verification
propagated errors more. [2512.08296](https://arxiv.org/abs/2512.08296). A
second study holds the thinking-token budget equal and finds single agents
"consistently match or outperform" multi-agent systems on multi-hop
reasoning across three model families, attributing many reported multi-agent
wins to "unaccounted computation and context effects."
[2604.02460](https://arxiv.org/abs/2604.02460).

Cursor ran several hundred agents on one codebase for a week at about 1,000
commits per hour across 10 million tool calls. Two mechanisms failed: file
locks ("20 agents would slow to the throughput of 1-3") and a single
integrator ("hundreds of workers and one gate"). They removed both, accept
"some moments of turbulence," and tell agents to rewrite the shared
scratchpad rather than append to it.
[Cursor, 2026-02-05](https://cursor.com/blog/self-driving-codebases).

On agents sharing what they learn with each other: the one clean ablation
found the answer depends on the model. With GPT-5.1 on GAIA, sharing
everything scored 44.2, sharing nothing 47.9, and selective sharing 49.1.
With Qwen3-32B, sharing everything scored best at 44.2 against 24.8 for
nothing. [2602.05965](https://arxiv.org/html/2602.05965v1). The fleet lane
found no production fleet that learns from a shared lessons store. Every one
it inspected learns from repository state and tests. Nobody has run a coding
fleet with and without shared lessons on the same repository and budget.

HoH's three roles share one model and one harness. They differ in what they
may read and write and in what each must produce. That is the specialization
the evidence supports: a permission and evidence contract, not a different tool
belt per agent.

## 5. Beyond code: the oracle rule

Every loop above that measured a gain had a check that did not trust the
agent. Outside code the question is what plays that role.

| Domain | The check | How noisy | Source |
| --- | --- | --- | --- |
| Code | Tests run against a frozen candidate | Low | HoH |
| Model training | `val_bpb` after five fixed minutes | Low | autoresearch |
| Data analysis | Deterministic table comparison against reference rows, 410 tasks | Low by construction | [DataSpace, 2608.03451](https://arxiv.org/abs/2608.03451) |
| Structured operations | Held-out probe plus a regression budget | Controlled by the holdout | GRASP |
| Customer support | Final database state plus policy compliance in simulation | High: one model fell from 61.2 percent at one try to about 25 at eight consecutive passes | tau-bench, via lane E |
| Education | Student mastery in a randomized trial, 900 tutors and 1,800 students | Ordinary experimental noise | Tutor CoPilot, via lane E |
| Prose | A judge that writes its expectation before reading | High unless the judge commits first | Section 3, rule 10 |

Two failure modes recur. Soft oracles get gamed: an agent optimized for
engagement gained 7.5 percent engagement and produced 188.6 percent more
disinformation. [2510.06105](https://arxiv.org/abs/2510.06105). And judges are
reproducible without being valid: across 21 judges and 541,000 judgments,
agreement with humans fell 33 to 41 points on one benchmark while
test-retest reliability stayed high. [2606.19544](https://arxiv.org/abs/2606.19544).

Two things nobody has measured. No study shows a non-expert running this loop
across sessions and coming out ahead. Every non-expert result found is a
single session with a fixed tool. And no primary source was found for
non-developers paying for agent workspaces or templates. The figures in
circulation trace to content marketing. The pricing-lane number in the
2026-09-03 product file should be re-checked against that.

## 6. Where Vivary stands against this today

Already in place:

- Typed records with a checker (`tropo`), receipts bound to a workspace
  fingerprint, human gates, and a claims board with one writer per artifact
  (`exo`). These are the pieces HoH's roles need.
- The 2026-09-05 [HoH comparison](hoh-alignment.md) put the inner loop's
  acceptance criteria on tickets 04, 15, 16, 18, 20, 21, 29, and 36.

Not in place:

- The loop never runs. No `learn` code. The machine's own experience instance
  holds 55 write-once traces, zero pattern pages, zero proposals, and an empty
  impact ledger after eight days. Capture is cheap. Consolidation and gating
  have no runner and no objective.
- Sequencing. The tickets that run the loop (15, 16, 20, 29) sit behind the
  registry, VCS adapters, task sources, recovery, and the GUI shell. The
  frontier is 12a. HoH ran on files and an existing CLI harness with nothing
  else. On the current graph, the first HoH-shaped iteration is months out.
- The preserved Littleagent specification loads a shared `LEARNINGS.md` on
  every turn. That is the ungated, every-context pattern that rules 1, 2, and
  5 in section 3 measure against.

## 7. Where your thinking needs correction, and where it beats the papers

Needs correction:

1. HoH is not a self-improving agent. It is a self-improving product with a
   frozen agent. The mechanism you want for "adopt lessons from previous
   sessions" is section 3, not section 1.
2. Lessons carried across sessions do nothing without a gate that scores them
   on held-out work. The measured gain from ungated LLM-written skills is zero.
3. "Every agent has its own tools and one part of the work" is half right.
   What the evidence rewards is separate permissions and separate outputs.
   Separate tool belts are not what made HoH or Anthropic's system work. And
   at an equal thinking budget, one agent matches or beats a fleet on
   reasoning tasks, so a fleet has to earn its place on work that splits into
   independent, separately checkable pieces.
4. "Not just about code" is possible only where an oracle exists. The
   innovation for non-code work is the oracle, declared per workspace, before
   any loop runs on it.
5. The 2026-09-05 sequencing puts the GUI before the loop. HoH's result says
   the loop is the value and the GUI is a window onto it.

Better than the papers:

1. A human gate. Neither HoH, Letta's dreaming, nor WikiSkill has one. The
   judge evidence in rule 10 says you are right to insist.
2. Memory as files the user owns, under git, with an index. HoH commits every
   stage. Letta rebuilt its product around it. You had it first.
3. Receipts a person can read. Proof-or-Stop binds evidence to source hashes
   the way Vivary receipts bind a fingerprint, so you are level with the
   research there. What no paper has is the receipt log as something the
   owner opens and reads. The oracle rule needs exactly that.
4. Portability. HoH gained with three different harnesses. Memory Transfer
   Learning shows insights transfer across models. A workspace that works
   under any harness is the durable layer.

## 8. Innovations worth discussing, none locked

1. **Oracle declaration.** Every workspace template names its check: a test
   command, a reconciliation, or a written-expectation procedure. No oracle,
   no factory mode and no learning loop on that workspace.
2. **Evidence state as typed records.** `verified-behavior`, `gap`, and
   `unmet-claim` records in `tropo`, each bound to the receipt and workspace
   fingerprint that produced it. The planner reads them. Verified behaviors
   survive replanning as constraints. The Fusepoint receipts show the exact
   shape: a loop-40 planner receipt carries 8 `gap_records`, 1
   `preservation_constraints`, 1 `verified_records`, 3
   `validation_requirements`, and an `issue_ledger` summary (33 closed, 16
   open, 3 regressed, 1 policy invalidated), with bindings to the prior
   tester review and the base candidate snapshot hash. Vivary's typed graph
   can hold those records today.
3. **A headless HoH loop on your own subscription.** Planner, developer, and
   QA as three Claude Code or Codex sessions, files between them, a Vivary
   receipt per stage, no API spend, no GUI. Run three iterations on one real
   project and measure. This is a bounded packet that does not block the GUI
   path and hands it evidence.
4. **Two clocks with receipts.** The inner loop per iteration. The outer loop
   on the heartbeat: consolidate traces by patch, draft one proposal, run its
   named check against a frozen fixture set, keep or discard, cap the active
   skill set, retire on outcome, revoke on contradiction. Shared-skill and law
   changes stop at a human with the verbatim diff.
5. **Commit-first judging for prose.** The judge writes its expectation before
   it reads the draft. This is the cheapest known fix for the 0.72 to 0.94
   inflation.
6. **Receipts a non-expert can read.** The one study found on presenting agent
   traces to people ([2602.16844](https://arxiv.org/abs/2602.16844)) is the
   starting point for the teaching audience.
7. **Dogfood first.** Run the maintainer once over the 55 existing traces.
   Count the patterns. That is the first real outer-loop measurement on this
   machine and costs one session.
8. **A decay check beside the pass check.** `doctor --trend` already reports
   workspace drift. Add code erosion and verbosity to the regression stop so a
   multi-day run halts on quality decay, not only on a failing test. No
   published loop does this yet.

## 9. Questions whose answers change the work

1. Loop first or GUI first? A headless HoH packet near the frontier changes
   the graph's order. Keeping the 2026-09-05 order keeps the loop months out.
2. First project and first oracle? A code project with a test suite is the
   only case the papers cover. A writing workspace with a commit-first judge
   is the first non-code case and has no published precedent.
3. Which outer loop do you mean by self-improving: Letta's dreaming (memory
   files consolidated in the background) or WikiSkill's compile-into-skills
   with a gate? The evidence favors the second and says the first needs a gate
   it does not ship with.

Answers, 2026-09-06, from the owner: loop first, and the loop must work before
the GUI uses it, with the GUI kept as vital for usability and accessibility.
Code first, because it is verifiable. WikiSkill.

## Sources checked directly on 2026-09-06

HoH abstract, HTML full text (results tables, ablation table, fixed
configuration sentence), and the PDF text extracted with `pdftotext` (the
planner prompt line, the frozen-candidate sentence, the absence of a
limitations section and of the playtest table). The Fusepoint repository:
`vcs.json`, the README loop record counted by script, and the loop-1 tester
and loop-40 planner receipts. WikiSkill HTML (ablation, pruning, rollback
sentences). Abstract pages of ACE, sleep-time compute, Memory Transfer
Learning, MAST, TRACE, Library Drift, TEPA, skill shadowing, Proof-or-Stop,
SlopCodeBench, the 260-configuration scaling study, and the equal-budget
single-agent study. The Meta-Harness, HarnessFix, and Learning to Share HTML
full texts for their result tables. The autoresearch README, the Anthropic
multi-agent post, and the Cursor self-driving codebases post. Everything else is
carried from six research-lane briefs whose cited pages were opened by those
lanes on the same date. The lane briefs are archived in the owner's Brain
inbox archive for 2026-09.
