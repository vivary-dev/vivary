# Vivary product roadmap

This roadmap is an outcome map, not a feature warehouse. Vivary wins when an agent
finds project truth with less context, acts with a visible blast radius, and stops at
the right human gates.

## The four product loops

| Loop | User outcome | Product signal |
|---|---|---|
| Comprehension | “I understand what this is and can run something useful.” | docs-to-command completion |
| Adoption | “It helped on the project I already have.” | map → dry-run adopt → doctor-clean |
| Retention | “My workspace is healthier because I reran it.” | repeat doctor runs and repaired drift |
| Evidence | “The claims are inspectable and reproducible.” | public benchmark, walkthroughs, and case studies |

Every roadmap item must strengthen at least one loop without violating the product
laws:

- minimal always-on context;
- typed graph truth and progressive disclosure;
- deterministic, dependency-light core;
- optional capabilities at explicit edges;
- read-only and dry-run paths before mutation;
- no hidden network, indexing, daemon, MCP, or provider behavior;
- one human approval per consequential action.

## Current truth

The current product line already proves the basic architecture:

- `tropo find` returns bounded typed context packets;
- `tropo query` provides graph-aware filtering and explain output;
- `tropo map` inventories a large repo, vault, or docs tree read-only;
- `create-vivary adopt` offers a deterministic thin brownfield plan with exact-hash apply;
- `create-vivary doctor --trend` reports workspace-health drift;
- Ozone includes graph-aware review and context-budget checks;
- thin init/adoption, legacy read compatibility, link integrity, and runtime-projection
  parity checks run in CI;
- the optional Cognee adapter returns typed Vivary node hits rather than a second
  truth store;
- optional embedded storage and stored-vector work remain explicit capabilities.

The bottleneck is no longer “can the pieces exist?” It is whether a new person can
understand the category, feel value on an existing project, return for a second use,
and verify the claims.

## Now: prove the adoption line

### 1. Publish the benchmark

**Outcome:** turn “less context waste” from positioning into a number people can
inspect and rerun.

Build one fixed harness over a public repository with questions such as:

- where is release truth owned?
- what depends on this module or decision?
- which file should an agent open first?
- what changed and what must be reviewed?

Run each task with raw file search and with Vivary retrieval. Record:

- model and date;
- repository revision;
- token input/output;
- turns;
- files opened;
- wrong files opened;
- supported or unsupported answer;
- time to verified answer.

Publish methodology, raw results, summary charts, and known threats to validity.

**Stop rule:** do not add a new retrieval provider to improve the headline number
until the deterministic baseline has a reproducible result.

### 2. Make brownfield adoption the default first experience

**Outcome:** a user can point Vivary at a real project and feel value before allowing
it to write.

Tighten the path:

```bash
tropo map --root .
create-vivary adopt .
create-vivary doctor . --trend
```

Required proof:

- a small code repo;
- a large code repo;
- a documentation tree;
- a personal vault fixture with active privacy ignores;
- Windows paths, junctions, symlinks, and out-of-root attacks.

The map should produce a compact action-oriented summary: likely modules, missing
routing surfaces, oversized files, ignored/private boundaries, and a bounded “open
these first” list.

**Stop rule:** adoption may touch only its bounded generated blocks in `AGENTS.md` and
`.gitignore`. Do not move, rename, rewrite arbitrary content, or auto-reorganize a host
project in this phase.

### 3. Turn doctor into the return loop

**Outcome:** a person has a concrete reason to rerun Vivary weekly.

Doctor should answer:

- did graph health improve or regress?
- did routing/context cost grow?
- are private boundaries still active?
- did module coverage or link integrity change?
- which repair has the highest expected context savings?

Add one explicit repair workflow for each high-confidence diagnosis. Start with
reviewable proposals, not silent auto-fixes.

**Metric:** percentage of doctor runs after the first week and percentage of detected
drift that is repaired.

### 4. Publish one honest brownfield case study

**Outcome:** a builder can see the exact before/after without reading a category
essay.

The case study must include:

- repository revision and starting state;
- commands run;
- proposed and approved writes;
- before/after file map;
- doctor and Tropo results;
- what remained awkward;
- issues created from the friction.

Do not use a toy project that was already arranged to flatter the product.

## Next: make the value compound

### 5. Context-budget repair proposals

**Outcome:** Ozone findings lead to a safe, understandable next action.

Group proposals by:

- open first;
- split;
- deduplicate;
- route through an index;
- move private;
- leave alone.

Estimate token savings using the same dependency-free approximation as Tropo. Label
the estimate as approximate and show the files behind it.

First slice is report-only. Any write path needs a dry run, exact file list, and
human gate.

### 6. Module index planner

**Outcome:** an existing workspace gets useful progressive-disclosure routers without
an agent inventing the structure from scratch.

The planner reads `tropo map` and context-budget findings, then proposes module
ownership, purpose, and links. Suggestions must be deterministic enough to diff and
must never promote ignored/private paths into public routers.

### 7. Proof packets

**Outcome:** every successful Vivary run leaves a small, privacy-safe artifact a
human or another agent can inspect.

A proof packet should contain:

- command and version;
- root-relative surfaces touched or read;
- counts and status;
- verification;
- gate decisions;
- no raw private content, query text, stdout/stderr dump, or absolute user path.

This builds on local receipt work without turning receipts into telemetry.

### 8. Starter workflows, not more presets

**Outcome:** a user reaches a recurring useful loop after installation.

Ship copyable, verified workflows for:

- release-truth maintenance;
- large-refactor impact review;
- research synthesis with claim ownership;
- second-brain decision retrieval;
- long-form writing continuity;
- multi-agent claims and conflict checks.

Each workflow must name the input, verifier, stop rule, and gate. Prefer five strong
workflows to twenty superficial presets.

## Optional adapters: meet agents on existing rails

### 9. Read-only `vivary-mcp`

**Outcome:** MCP `2026-07-28` clients can request bounded Vivary
context over local standard input/output without adding MCP to the baseline or Core.
Compatibility with a named client and external conformance remain unproven until
tested directly.

The optional first slice exposes exactly:

- `vivary_find`;
- `vivary_query`;
- `vivary_check`;
- `vivary_capsule`.

There are no write tools, extensions, remote transports, provider calls, or
auto-enable behavior. Operator-configured aliases own root authority. The adapter
reuses the public Tropo/Core privacy contract and projects capsules without raw
evidence. [MCP.md](MCP.md) owns the complete boundary and proof.

## Later: provider and integration proofs

### 10. Typed recall provider contract

**Outcome:** optional semantic memory improves recall without becoming project truth.

Provider results must include known node id, type, path, score, reason, and bounded
snippet. Unknown-node results are rejected. Missing providers degrade cleanly to
graph-only retrieval.

### 11. Optional integration proof matrix

**Outcome:** users can see what an integration actually changes before enabling it.

For LanceDB, CocoIndex-code, Cognee, and future providers, publish:

- install boundary;
- local/network behavior;
- state/cache/log paths;
- data sent;
- approval gates;
- disposable smoke command;
- degradation behavior;
- uninstall/rebuild path.

The matrix is a trust surface, not a partner-logo page.

## Deliberately deferred

These items are not automatically bad; they are deferred because they can add more
weight than leverage:

- hosted Vivary control plane;
- default cloud sync;
- write-capable MCP;
- autonomous workspace reorganization;
- ambient semantic indexing;
- team analytics or telemetry;
- a visual graph editor before retrieval/adoption evidence is strong;
- more named layers or a plugin marketplace.

Reconsider only when repeated user evidence shows a problem the current plain-file
and CLI surfaces cannot solve.

## Explicitly out of scope for the core

- default embeddings;
- hidden databases, daemons, MCP servers, providers, or network calls;
- automatic indexing of source code or personal notes;
- commands that tell an agent to bulk-read a repo or vault;
- a second canonical truth store;
- workspace mutation without a preview and human gate;
- model-vendor or editor lock-in;
- replacing Git, issue trackers, documentation tools, or agent runtimes.

## Roadmap review cadence

Review the roadmap after each meaningful proof event:

- benchmark run;
- brownfield case study;
- ten external adoption attempts;
- a release with repeat doctor data;
- a security/privacy failure;
- a major agent-runtime change.

At review, remove stale work rather than carrying it indefinitely. The roadmap should
stay smaller as product truth gets sharper.
