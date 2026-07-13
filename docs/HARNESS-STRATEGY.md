# Vivary harness strategy: prove the context exchange first

_Status: research-backed direction, not an implementation commitment_
_Checked: 2026-07-13_

## Executive decision

Vivary should keep the long-term ambition of becoming an exceptional agent harness,
but it should **not become an agent runtime, managed control plane, or general memory
platform yet**.

The defensible wedge is narrower:

> **Inspectable, Git-native project truth -> policy-controlled task context -> any
> agent harness. Learned memory remains a separate, subordinate overlay.**

Letta makes the agent persistent. Supermemory makes learned user context persistent.
OpenHands owns agent execution. Vivary can make the **workspace's reality** portable,
explainable, and safe across all of them.

The immediate move is not another feature family. It is a proof gate:

1. benchmark today's `tropo map`, `find`, and `query` on real brownfield tasks;
2. prove material context savings without reducing task correctness;
3. prove the same project context works in two different harnesses;
4. only then formalize a Task Capsule -> Execution Receipt -> Learning Inbox loop.

If that proof fails, Vivary should improve retrieval and activation rather than build a
larger platform around an unproven advantage.

## What the current product already earns

Vivary is not starting from an idea. The current `dev` branch already provides:

- deterministic typed project truth and graph validation through Tropo;
- bounded context packets through `tropo find`;
- structured text, local vector, and optional semantic retrieval modes;
- read-only large-filesystem mapping and non-destructive brownfield adoption;
- visible state, progressive disclosure, skills, privacy boundaries, and human gates;
- graph-aware review and impact analysis through Ozone;
- lightweight work claiming and conflict visibility through Exo;
- privacy-preserving local run receipts and workspace health/trend checks.

Those are strong primitives. The product gap is that users still have to assemble them
into a repeated outcome. Installs are not the goal. The goal is a trustworthy answer
on an existing messy workspace, followed by a verifiable handoff and useful learning.

## What the market evidence says

This review used current official documentation, public repositories, release notes,
and current Vivary repository truth. Product-performance claims were treated as
marketing unless independently proven.

| System | What it proves | What Vivary should copy or adapt | What Vivary should reject |
|---|---|---|---|
| [Letta / Letta Code](https://www.letta.com/blog/context-repositories/) | Persistent agents, Git-backed context repositories, progressive disclosure, parallel conversations, worktree-isolated memory maintenance, subagents, and headless execution are valuable. | Git history for context changes; explicit init/remember/doctor/reflect lifecycle; scoped skills; portable structured execution events. | Agent-managed memory as authoritative project truth; unrestricted execution by default; becoming another stateful coding runtime. |
| [Supermemory](https://supermemory.ai/docs/concepts/how-it-works) | Raw evidence, extracted memories, evolving facts, compact profiles, hybrid retrieval, and filesystem-shaped access are useful layers. | Keep raw sources distinct from learned facts; temporal `updates`/`extends` relationships; a compact read-only briefing; dry-run forgetting; explicit async/stale states. | Automatic inferred facts as trusted truth; a silent memory proxy; semantic interception of ordinary shell commands; cloud connectors in core. |
| [OpenHands](https://docs.openhands.dev/sdk/arch/design) | Agent core, tools, execution workspace, and agent server benefit from explicit separation; local, Docker, and remote execution can share an interface. | Keep execution behind runtime adapters and preserve one workspace/context contract. | Owning sandboxes, container lifecycle, model routing, or a full agent runner before the context wedge is proven. |
| [AnythingLLM](https://docs.useanything.com/features/memories) | Candidate memory reflection, user controls, scoped memories, scheduled jobs, and resumable run records create understandable product loops. | Govern memory as candidate -> reviewed -> accepted -> superseded/forgotten; make every unattended run resumable and inspectable. | Global capability leakage, chat-first product framing, or automatic memory promotion. |
| [Graphiti](https://github.com/getzep/graphiti) and [Cognee](https://docs.cognee.ai/core-concepts/architecture) | Temporal validity, episode provenance, hybrid retrieval, typed objects, and multi-store pipelines are already established patterns. | Add source lineage, validity, and lifecycle labels to context items; keep derived indexes rebuildable. | Their operational stacks as core dependencies; “graph + vector memory” as a differentiating claim. |

The commoditized features are important but not moats: persistent memory, graph-vector
retrieval, MCP adapters, agents, schedules, connector catalogs, chat UIs, and generic
context compression. Vivary should use optional adapters where useful, not rebuild the
same checklist.

## The product thesis

The product is a **portable context exchange for real workspaces**.

It has four distinct lanes:

1. **Authoritative truth** — human-editable typed files and relationships validated by
   Tropo. This is what the workspace claims is true.
2. **Evidence** — source files, revisions, checks, receipts, and observations. This is
   what supports or challenges a claim.
3. **Learned memory** — optional, scoped, revisable candidates from an agent or memory
   provider. It can inform retrieval but cannot silently rewrite truth.
4. **Active context** — a bounded, task-specific compilation of the first three plus
   applicable skills, gates, unknowns, and verification requirements.

The separation is the feature. A result must never make authored truth, raw evidence,
and model-derived memory look interchangeable.

## Candidate deep module: Context Exchange

This module should be built only after the proof gate succeeds. Its interface should
stay small while hiding selection, deduplication, fingerprints, provenance, budgets,
privacy policy, lifecycle state, and runtime differences.

```text
prepare(task, root, budget, actor) -> TaskCapsule
complete(capsule, observations)    -> ExecutionReceipt
propose(receipt)                   -> LearningProposal[]
```

### Task Capsule

A read-only answer to: “What does this agent need to know to do this task safely?”

Minimum contract:

- schema version, workspace revision/fingerprint, task, scope, actor, and expiry;
- selected typed nodes/files with bounded excerpts and selection reasons;
- known, inferred, unknown, stale, and conflicting facts kept visibly separate;
- applicable constraints, skills, privacy rules, and human gates;
- expected verification commands and success conditions;
- declared token budget, estimated use, omissions, and next-read pointers;
- one capsule fingerprint for handoff and receipt binding.

`prepare` is always read-only. It must explain both inclusion and material omission.

### Execution Receipt

A runtime-neutral, evidence-bearing completion record:

- capsule and workspace fingerprints;
- runtime and actor identity;
- files actually read and changed;
- tools/checks run and their outcomes;
- claims proved, claims not proved, failures, and unresolved unknowns;
- output/artifact pointers and one receipt fingerprint.

A receipt records what happened. It does not declare success when verification is
missing, and it does not need raw prompts, secrets, or full command output.

### Learning Proposal

A reviewable candidate produced from a receipt:

- proposed owner and type: decision, fact, procedure, skill, or risk pattern;
- source receipt and evidence references;
- scope: workspace, user, agent, task/run, or team;
- confidence, validity, expiry, and conflict/supersession links;
- status: candidate, accepted, rejected, superseded, expired, or forgotten.

`propose` never mutates shared truth. Accepting or editing a proposal is a separate
human gate. Accepted agent memory still remains distinct from authoritative Tropo
truth unless a reviewed graph change explicitly promotes it.

## Debate: what survived and what got weaker

### What survived

- Brownfield coding is the first user and activation wedge.
- The same context contract should work in Codex and Claude before claiming runtime
  neutrality.
- Context selection, provenance, receipts, and gated learning form one compounding
  loop rather than four unrelated features.
- MCP should be a thin consumer of the canonical contract, not a second retrieval
  implementation.
- The typed recall-provider contract remains useful, but providers return candidates;
  Vivary owns validation, policy, merging, and trust labels.

### What got weaker

- “Full harness” is a destination hypothesis, not current positioning.
- “Context OS” and “control plane” are too broad for public product language today.
- A new compiler is not justified until the existing context packet proves value.
- More memory engines, graph storage, clustering, connectors, or UI do not solve the
  immediate activation and repeat-use problem.
- Package downloads, stars, and installs are signals, not active-user proof.

## Phase 0: the proof gate

Use the product that already exists before adding the Context Exchange.

### Benchmark design

- Select three public brownfield repositories of different shapes.
- Define 20 fixed tasks such as “where is this owned?”, “what breaks if this changes?”,
  and “which checks prove this behavior?”.
- Pin repository revision, model, harness version, task order, and time of run.
- Run each task with raw repository exploration and with Vivary `map/find/query`.
- Use Codex and Claude as the first two harnesses.
- Record task correctness, input/context tokens, orientation turns, wrong files opened,
  elapsed time, and whether required files appeared in the first 1,200 tokens.
- Publish the method, raw results, failures, and regression history.

### Pass criteria

The strategy advances only if:

- required context appears in at least 80% of first packets;
- orientation tokens, wrong files, or turns improve by at least 30%;
- task-success rate drops by no more than 5 percentage points;
- packets remain within their declared budget;
- preparing context never mutates the workspace;
- more than 80% of the contract is identical across the two harnesses.

### Adoption proof

Run a five-user brownfield trial:

- setup under 15 minutes;
- first trustworthy answer in one session;
- at least three users complete setup;
- at least two voluntarily use Vivary again within 14 days;
- users can explain the difference between project truth and learned memory.

Failing these gates means improve activation/retrieval or narrow the customer. It does
not mean add a daemon, a chat UI, or more providers.

## Roadmap after the proof gate

### Phase 1 — Formalize Task Capsule v1

- Freeze one JSON/Markdown contract around existing Tropo retrieval.
- Add deterministic fixtures for budgets, exclusions, stale/conflicting facts, and
  workspace fingerprints.
- Add one human-friendly command such as `vivary context "<task>"` only when it hides
  real cross-source behavior rather than wrapping `tropo find`.
- Keep the implementation local, read-only, and dependency-light.

### Phase 2 — Execution Receipts

- Have Codex and Claude overlays return the same receipt contract.
- Bind receipts to capsule and Git revisions.
- Teach `doctor` to report missing, stale, unverifiable, or runtime-divergent receipts.
- Preserve privacy by recording bounded metadata and proof pointers, not raw content.

### Phase 3 — Gated Learning Inbox

- Generate proposals only from evidence-bearing receipts.
- Add candidate, accepted, rejected, superseded, expired, and forgotten lifecycle tests.
- Test ambiguous identities, contradictory updates, stale episodes, cross-project
  isolation, source reconstruction, and deletion propagation.
- Require explicit acceptance before any shared truth or skill changes.

### Phase 4 — Neutral adapters and handoffs

- Ship read-only MCP around the canonical Task Capsule contract.
- Add provider capability handshakes for provenance, lifecycle, offline/network,
  correction, and forgetting behavior.
- Link Exo claims, capsule IDs, receipts, and proposals for agent-to-agent handoff.
- Keep write-capable adapters and multi-agent execution out of this phase.

### Phase 5 — Reconsider the full harness

Only revisit execution if users repeatedly ask Vivary to own it. The decision requires:

- repeat use and retention around the context exchange;
- proof that runtime adapters cannot provide trustworthy receipts;
- a clear execution seam across local and isolated adapters;
- explicit demand for Vivary-owned permissions, tools, sandboxes, schedules, or remote
  execution;
- capacity to maintain the security and compatibility surface.

If those conditions do not appear, remaining the trusted workspace layer is a win, not
an incomplete product.

## Scope cuts

Do not build in the next product bet:

- an agent runner, model router, sandbox manager, daemon, or hosted control plane;
- chat UI, accounts, billing, cloud sync, connector marketplace, or mobile capture;
- a new memory engine, storage backend, or automatic “dreaming” system;
- automatic learned-memory promotion into typed truth;
- write-capable MCP/runtime tools;
- broad consumer “full second brain” positioning;
- more than two reference runtimes.

## High-leverage product demos

1. **Understand this repo in five minutes.** Adopt a real brownfield repo, ask a hard
   ownership question, and show a bounded, cited, correct first packet.
2. **Same project brain, different agent.** Prepare in Codex, continue in Claude, and
   preserve task, revision, constraints, and proof without re-briefing.
3. **Memory cannot rewrite reality.** Introduce a plausible but wrong learned fact;
   show it labeled as a candidate and blocked from authoritative truth.
4. **Resume after two weeks.** Use the prior capsule, receipt, current Git revision,
   and doctor output to identify what is still valid and what must be refreshed.

## Kill criteria

Stop or redesign the strategy if:

- agents routinely ignore the capsule;
- receipts cost more human effort than re-briefing;
- context savings disappear on real tasks;
- runtime adapters cannot report enough execution truth for credible receipts;
- learning proposals mostly create cleanup work;
- a private path or untraceable learned fact enters a packet;
- users install/adopt but do not voluntarily repeat the loop.

## Open questions

- Which three public repositories make a fair, reproducible benchmark corpus?
- What is the minimum event data Codex and Claude can both expose reliably?
- Should the first capsule be an extension of `tropo find` or a `vivary` meta-command?
- Which facts deserve validity windows, and who owns freshness policy?
- How should knowledge-work evidence differ from code/repository evidence?
- What level of receipt detail remains useful without storing sensitive content?
- What external users will run the first five adoption trials?

## Source quality and limits

Strong evidence came from official architecture docs, public repositories, release
notes, and concrete product interfaces. Weak evidence includes first-party benchmark
claims, latency/cost claims, broad “continuous learning” claims, and isolated GitHub
issues. The market need for Vivary's exact wedge remains a hypothesis until the
benchmark and adoption trial pass.

Primary references:

- [Letta context repositories](https://www.letta.com/blog/context-repositories/)
- [Letta context hierarchy](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy)
- [Supermemory graph memory](https://supermemory.ai/docs/concepts/graph-memory)
- [Supermemory profiles](https://supermemory.ai/docs/concepts/user-profiles)
- [Supermemory filesystem](https://supermemory.ai/docs/smfs/overview)
- [OpenHands design principles](https://docs.openhands.dev/sdk/arch/design)
- [AnythingLLM memories](https://docs.useanything.com/features/memories)
- [Graphiti repository](https://github.com/getzep/graphiti)
- [Cognee architecture](https://docs.cognee.ai/core-concepts/architecture)
