# Vivary multi-project workbench

Updated: 2026-09-14. Status: documented program; GitHub issues own task lifecycle and the ticket graph is a synchronized reference (see [issue authority](issue-authority.md)). The product direction and Habitat development environment are approved. The owner confirmed BrowserPod is unavailable. Ordinary reversible technical choices belong to the issue owner; explicit unresolved product, account, security, and release decisions retain their stated owners.

This is the canonical program plan. [Execution rules](execution-contract.md), [scope coverage](capability-matrix.md), [native owners](native-owners.md), and [current risks](audit.md) keep the work bounded and current. Start here, then open [the graph](graph.md), [source evidence](evidence.md), [migration map](migration.md), or [release criteria](release.md). [CONTEXT.md](CONTEXT.md) defines the terms.

## Product direction and authority

Vivary absorbs the public Littleagent work into one product evolution. The GUI is the primary work environment. Standalone Vivary workspaces and users' favorite runtimes remain supported.

The [audience and setup decision](#approachable-workspace-decision-2026-09-06)
includes professionals across coding, research, writing, and second brains.
Vivary helps them accomplish work through an installable workspace and GUI.

The product handles new and existing projects, workspace templates installed within projects, an optional recommended Brain, and learning from verified work. Version control is optional. GitHub, Gitea, Jujutsu, and Beads belong to separate integration choices.

The full little-agent scope survives: visual planning, research, tickets, workers, review, portable handoffs, CLI agents, factory mode, email intake, and heartbeat maintenance. Delivery order does not remove later scope.

Implementation proceeds through live GitHub issues, with packets and the graph as supporting references. HarnessMax removal remains deferred. Website, UI, docs, guides, and actual agent-readiness verification remain in the program. The [release checkpoint](desktop-release.md#what-exists-and-what-is-missing) identifies accepted increments and unmet acceptance. Target scope does not establish a release or publication.

No model, storage vendor, hosting plan, default runtime, or payment service is selected by this document. Earlier Littleagent implementation authority remains relevant to compatible work after the changed contracts are reconciled. Planning authority does not establish implementation or publication evidence.

## Vivary-New repository decision: 2026-09-13

Jeff requested one complete new repository named `Vivary-New` in the Vivary
organization, connected to GitHub and Entire. His later branching correction
selects typed topic branches from `dev`, PRs into `dev`, and reviewed promotion
to `main`. `main` is the default branch. The repository was public when checked on 2026-09-24.
Keep the existing checkout and history. This supersedes the earlier Entire-only
feature-branch delivery restriction. The original public repository remains separate.
[CONTRIBUTING.md](../../../CONTRIBUTING.md) owns the workflow and its enforcement limit.

Jeff also confirmed that another contributor is joining. Keep code modular and
readable, document module ownership, and remove unnecessary layers and comments.

Jeff also asked to combine the research into one plan and follow it. Extend the
existing outcome graph with bounded packets. Treat supplied research as evidence
and proposals. Its embedded decision block is not a record of Jeff's answers.
Keep compatible file-role metadata as the first source increment. Preserve
existing authored state while a later packet defines generated-view inputs and
migration. Deliver GUI acceptance with useful setup and memory slices. Merge and
split support do not block the first working workspace setup flow.

The [research reconciliation](research/workspace-research-reconciliation.md) records
source corrections and maps the combined work to its owning packets.

## Local desktop delivery decision: 2026-09-12

Jeff reiterated that Vivary must run on people's own computers and asked to move
the desktop application forward now. Zo remains the authorized development and
preview environment; it is not the product's required host. Deliver a local
desktop window, local runtime and files, and existing local CLI model access
without a Vivary or Zo account. Outcome 23 owns packaging and platform acceptance.
Its broader release dependencies do not block a bounded desktop increment for
the already working agent surface. Follow the testing sequence below for later
application increments.

## Unified workspace decision: 2026-09-14

Jeff selected one conversation-centered project workspace after reviewing the
private application beside Codex and T3 Code. Agent, Files, Workbench and Full
chat must not remain competing top-level destinations. Files, plans, documents,
changes and supported previews are optional resizable and closable surfaces.
Project metadata stays compact; selecting a project does not open a file.

Harness/model choice comes from supported, registered and installed CLIs on the
selected host. The picker groups models under harness names with small brand
marks. Cross-harness selection opens a linked conversation with exact recorded
history available. Model context capacity remains explicit. A separate agent
handoff workflow maintains project documents and continuation evidence through
deterministic tools. Vivary does not impose predefined agent personas.

[Issue #38](https://github.com/vivary-dev/Vivary-New/issues/38) owns delivery.
The [interaction contract](unified-workspace.md) distinguishes these decisions
from proposed dimensions and implementation details. The [research](research/agent-workspace-ergonomics.md)
records primary sources and evidence limits. Existing file/runtime proofs remain
valid for their components. Jeff accepted the design review, and PR #42 delivered
the first unified shell. PR #48 corrected the sidebar edge. Remaining issue #38
integrations still need their own implementation and acceptance.

## Visual product specification decision: 2026-09-14

Jeff requested a complete visual specification and codebase operating manual
before returning to application implementation. It must cover the existing full
product scope, shared vocabulary, interconnected actions, modular boundaries,
replaceable harness integrations, state and failure paths, and diagrams that
route a contributor to the exact relevant context.

The [visual specification](specification/README.md) organizes the 36 retained
outcomes and issue #38 without creating a second task ledger. Jeff accepted guide
snapshot `e86d06ed592a2d3c` on 2026-09-14. Header-first project details and manual
handoff updates are settled. The first shell is implemented. The grouped harness
catalog, linked conversations, handoff workflow, and concurrent runtime remain
planned. A new CLI still needs a supported adapter and compatibility evidence.

## Hosted and desktop testing decision: 2026-09-13

Jeff confirmed that Zo is the development host. Implement changes on Zo and test
the latest application through the existing private hosted Zo version first.
Then build Electron packages for further local testing on his laptop.

Hosted checks cover the application workflows. Desktop checks cover installation,
local file access, native dialogs, persistence, and process lifecycle on the
laptop. Record the tested source and platform for each result. Existing Linux
evidence does not establish Windows acceptance.

This sequence replaces the earlier blanket Zo-only runtime restriction. The
product remains local, opens without a Vivary account, and uses local files.
The hosted development service retains its private access boundary.

## Local access and original-system decision: 2026-09-12

Jeff requested completion of the open issues using the original Vivary logic or
its existing system contracts. Reuse working packages and Native integrations
before adding new orchestration. Check existing Paperclip use and retain a useful
integration if one exists; this does not make Paperclip mandatory.

Jeff requested account-free self-hosted use on 2026-09-12. The 2026-09-13
[host and browser decision](#host-and-browser-access-decision-2026-09-13) clarifies
the access boundary: local desktop use requires no Vivary account or signup and
stays on loopback by default. Remote browser access is explicit and authenticated.
The private Zo instance retains Zo's existing owner-login boundary. Internal
Native identity and action scoping stay active without a second user account.
Coding-provider sign-in is separate and reuses the user's existing CLI subscription.
A paid authentication service is not required.

Use up to three subagents as needed and make broad real visual/UI testing part
of normal delivery. Repair failures, repeat the affected journey, and continue
implementation without expanding verification machinery. The private Zo preview
is the active development surface. For Vivary-New, reviewed topic PRs
merge into dev under [the contributor rules](../../../CONTRIBUTING.md). Promotion
to main and public release retain their separate product-acceptance requirements.

## Execution decision: 2026-09-05

The current development environment is the bounded Habitat container named by
the packet. On 2026-09-05 the owner first selected BrowserPod, subsequently
authorized Habitat fallback, then explicitly corrected the active instructions:
"we can't use browserpod". The latest answer supersedes the BrowserPod selection.
Keep BrowserPod setup and execution out of the active task list. Packet 10b is
unavailable and does not block Habitat implementation.

[10c](receipts/10c-habitat-fallback-proof.md) records the Habitat toolchain proof.
Each runtime packet still verifies its exact tools, containment, and behavior.
Earlier research and receipts retain their historical environment labels.
Runtime choice and standalone support remain part of the product. This development
decision does not authorize account, spending, credential-transfer, scheduled
activation, or production-hosting changes.

## Direction decision: 2026-09-06

The owner answered the three questions in
[the alignment brief](research/hoh-direction-brief.md) on 2026-09-06:

1. Loop first. The planning, coding, and testing loop runs and proves itself
   on files before the GUI depends on it. The GUI stays vital for usability
   and accessibility and is not descoped; it consumes the loop's evidence
   instead of preceding it.
2. Code first. The first project under the loop is a code project with an
   executable test suite, because that oracle is verifiable. Non-code
   workspaces wait for a declared oracle.
3. WikiSkill-shaped outer loop. Cross-session learning follows the
   compile-into-skills design: write-once traces, patch-only patterns, one
   gated proposal at a time with a named execution check, and skills that
   roll back while the record persists. Background memory consolidation
   without a gate is not selected.

The owner subsequently added **decision four**, recorded separately in
[PR #334](https://github.com/vivary-dev/vivary-cli/pull/334) on 2026-09-06:
Vivary drives whichever coding agent the user already pays for, Claude Code,
Codex, or another through an adapter, with one role contract and one receipt
shape. The loop never requires its own model API key and never resells tokens.
This clarification was not a fourth answer in the three-question brief.

Packet [20a](packets/20a-headless-loop-proof.md) carries the first bounded
runtime proof and retains priority when its prerequisites are satisfied.
[20c](packets/20c-headless-loop-preparation.md) owns deterministic preparation
while 20a's native-call budget prerequisite is unavailable. This split follows
the execution contract's rule to stop only dependent operations. The required
20b continuation of 20a owns the cross-runtime proof. [Outcome 04](tickets/04-define-runtime-session-contracts.md#done-condition)
owns the shared adapter acceptance. Outcomes 18, 19, 20, 30, and 36 carry the
rest in their logs. These decisions change order and acceptance. They do not add
product scope or authorize spending, publication, scheduling, or account changes.

## Multi-agent phase decision: 2026-09-06

The owner clarified that the product loop passes work between distinct agents,
with deterministic phase completion and handoff. Each stage can select a
different runtime. This extends the run-wide runtime choice above; using Claude
for a whole run and Codex for a separate run does not prove mixed-stage operation.

The coordinator owns the workflow state and transition rules. Each stage binds
its assigned agent, runtime, permissions, required outputs, and completion rule.
It starts a distinct agent session for that stage and hands over only the
declared inputs and accepted artifacts. Resuming a stage preserves its identity;
handoff to another stage must not reuse the first agent's conversation as a new role.

A returned response or complete usage report is not phase acceptance. The
coordinator checks the declared artifact and evidence requirements, persists the
decision, and dispatches the assigned next agent only when the rule allows it.
Rules must cover advance, bounded rework, blocked work, and final completion.
Missing evidence, unknown outcomes, and an unsupported runtime cannot silently
advance or select a replacement runtime. Reopening the same accepted handoff
must not start the successor twice or reset the workflow's budget.

Determinism applies to the transition given the recorded inputs and policy.
AI judgments can vary. When a phase needs judgment, its gate consumes an explicit
review or human decision bound to the artifact revision, rather than interpreting
freeform claims of completion. The exact phase checks and rework routes are
implementation choices that require declared tests; no runtime assignment or
quality threshold is selected by this clarification.

Packet 20c owns the offline routing and gate implementation. Packet 20a and its
20b continuation can still establish each runtime's baseline behavior, but
accepting the product also requires a bounded proof with different runtimes in
one workflow and preserved handoff identities, artifacts, and shared accounting.
Reuse the native run/session owners; this decision creates no replacement queue,
unbounded worker service, spending grant, or live-runtime acceptance.

## Recommended architecture

Use Vivary as the portable workspace and governance layer. Compose Agent-Native's application, action, chat, run, session, resource, connection, and automation primitives in the workbench. Selected coding runtimes retain their loops, tools, compaction, and native session state.

Do not add a second agent reasoning loop, transcript store, task queue, or scheduler merely because the product coordinates multiple projects. Add a product service only when a concrete requirement has no suitable existing owner.

```text
Vivary workbench GUI       Agent/CLI entry
          |                     |
          +--- same operations -+
                    |
          project registry and authority
             /              \
 Vivary context/policy     Agent-Native sessions/actions
             \              /
           explicit project + runtime binding
                    |
       Claude Code / Codex / Pi / other adapters
                    |
       chosen project folder or isolated checkout
```

Core remains pure validation and projection. Tropo observes and retrieves. Strato evaluates authority. Ozone verifies. Exo projects claims, dependencies, and handoffs. The application owns effectful coordination through supported framework APIs. See [the inspected seams](evidence.md).

## Filesystem and repository model

Recommended default: a collection folder without a parent Git repository. Projects can live under it or remain at existing external paths.

```text
My work/                    collection, no required .git
  .vivary/                  collection configuration and local bindings
  Brain/                    optional private knowledge workspace
  projects/
    new-tool/               standalone Vivary workspace, optional .git or .jj
    course-notes/           standalone Vivary workspace, no VCS required

/path/to/existing-app/     registered in place, retains existing conventions
```

These paths illustrate the model, not a finalized on-disk schema. Separate portable project identity/configuration from machine-local paths, user authorizations, database state, and credentials. Never synchronize those local bindings by accident.

A folder nested under a non-repository container is not a nested Git repository. Its Git history is independent of its siblings. A Git submodule instead makes a parent repository track a particular child commit and adds clone/update lifecycle. A monorepo stores project files in one shared history. A Git worktree is another checkout of the same repository, not a new project repository. [Git submodules](https://git-scm.com/docs/gitsubmodules) and [worktrees](https://git-scm.com/docs/git-worktree), verified 2026-09-05.

Do not default to submodules, subtree imports, or one giant parent repository for users' projects. Register an existing monorepo or submodule project without converting it. When multiple logical projects share a repository, serialize mutations against the common repository and checkout identity.

If a user versions the collection metadata, exclude child project content and private state explicitly. Prefer a separate metadata repository beside the project roots. A parent commit does not back up independent child repositories. Explain backup coverage accurately.

Jujutsu supports Git-backed and colocated workspaces. Detection must distinguish a colocated Jujutsu workspace from a Git-only checkout and select one mutation owner. Preserve unsupported layouts with read-only or external-tool access rather than rewriting them. [Jujutsu compatibility](https://docs.jj-vcs.dev/latest/git-compatibility/), verified 2026-09-05.

## Project onboarding

The target GUI offers three choices: create a project, open an existing folder, or open an existing Vivary workspace. Agent actions must use the same operation owners.

The accepted New project increment creates a managed folder under private app data after previewing the original creator's exact five files. PR #47 merged that shared creator path. Arbitrary-target creation, populated-folder apply, template choices, VCS, and hosting steps below remain target behavior. Registering an existing folder through the desktop picker does not adopt or modify it.

New project:

1. Choose a display name and target folder. Suggest a filesystem-safe slug without changing the display name.
2. Choose a blank workspace or a versioned template. Explain the resulting files.
3. Offer version control independently: none, Git, or an available Jujutsu adapter. Default recommendations may suggest Git for code, but selection is never forced.
4. Offer hosting separately and make it skippable. Show host, account/organization, remote name, visibility, local path, and intended initial push before creating anything remote.
5. Preview all changes, apply the bound plan, verify, then register the project. Recover visibly if any step fails.

Existing folder:

1. Register and inspect read-only first. Canonicalize its path and detect the actual repository root, worktree, instructions, and configured tools.
2. Offer optional Vivary adoption using the existing dry run and plan-hash contract. Registration alone never writes an AGENTS.md, initializes Git, or creates a remote.
3. Keep existing Git/Jujutsu, submodules, monorepo layout, task files, ignored state, and human edits. Report ambiguity rather than resolving it by guessing.
4. Scope template additions to a verified empty child directory initially. Merging template content into a populated folder requires a later conflict-aware plan, not thin adoption by another name.

Repository creation is an optional wizard step, never the definition of a project. Allow local-only history, custom Git remotes, self-hosted Gitea, and no host. Do not require GitHub login to use Vivary.

## Template composition

Resume and extend the existing [held template-installer program](external-dependencies.md#held-template-installer-program) as the implementation source for external catalog template semantics, verified transport, combined plans, and transactional apply. Its earlier implementation hold is not silently lifted by this planning request.

The external catalog continues to own its template content, manifests, versions, archives, and distribution. Built-in starter guidance stays with the original creator and outcome 07. Vivary owns composition, adoption, verification, receipts, and conformance. Agent-Native app scaffolding and integration blueprints are different mechanisms. They must not become hidden substitutes for Vivary workspace templates.

A project created from a template remains a normal standalone Vivary workspace. The collection references it and routes sessions to it. Installing a template does not install another coordinator server, copy the whole collection, create a remote repository, or start another agent.

Bind each installation to the project ID, canonical target, template version and digest, selected options, target fingerprint, and authority. Recover across both filesystem changes and registry updates. Repeated requests must not create duplicate projects or lose an already completed install after a crash.

Allow project-contained workspace templates, including knowledge workspaces. First delivery supports a single collection of explicitly registered roots. Recursive collection coordination requires an explicit future contract for cycles, ownership, and authority inheritance. It is not implied by ordinary template nesting.

### Workspace setup direction: 2026-09-13

Jeff asked Vivary to create a useful workspace with folders, files, and prefilled
agent guidance. His examples include second brains, knowledge bases, LLM wikis,
and other projects. He questioned fixed packs tied to a language or project
stack and suggested studying Letta Code's agent patterns. The
[Letta Code study](research/letta-code-workspace-patterns.md) supplies the source
comparison. Its findings inform the proposal below, not a runtime replacement.

Setup must produce usable guidance and an understandable file structure. The
existing five-file initializer is a compatible base, but it does not complete
this requirement. Folder registration alone does not initialize a workspace.

The proposed composition separates three choices:

- **Workspace structure:** a portable base plus useful patterns for capture,
  research, knowledge organization, writing, or project work. Patterns can be
  combined and adapted to the user's existing layout. Language and build tools
  remain optional project choices.
- **Agent guidance:** editable responsibilities, working instructions, memory
  scope, and reusable skills. Start with one capable workspace agent. Add roles
  such as researcher, reviewer, or knowledge curator when the workflow needs
  them. A role does not require its own model or a running background worker.
- **Execution and connections:** the selected Native runtime, its tools, and
  existing connectors. A template or instruction file grants no extra access
  and activates no provider, schedule, or paid service.

For example, a knowledge workspace could combine an inbox, source references,
linked notes, an index, and instructions for citing and updating knowledge.
A project workspace could combine goals, current tasks, decisions, and review
guidance. These are proposed starting patterns, not a fixed catalog or invented
personal knowledge. Keep detailed folder names and profile defaults editable.

Use the original creator/adopter for a visible file plan, deliberate apply, and
registration. Prefill general guidance and known user inputs. Mark unanswered
questions clearly. Preserve existing files and let the user review additions.
[Outcome 07](tickets/07-create-new-projects.md) owns built-in creation,
[08](tickets/08-adopt-existing-projects.md) owns adoption, and
[11](tickets/11-finish-workspace-editor.md) owns editing the resulting files.
The external catalog and transport remain under the separate
[held template program](tickets/19-integrate-template-program.md).

On 2026-10-19 Jeff found that separate coding and personal workspaces did not
work as they should and asked for the choice at project creation in a modal.
He chose two kinds, **Coding** and **Personal**, for New project and Open folder.
The kind sets the first conversation type and the starting structure preset
(Coding or Knowledge work). It does not lock features: Code conversations and API
chat stay available in every project, and it adds no persona or access. Existing
projects show Not set until he chooses. [J06](specification/journeys.md#project-kind-coding-or-personal)
holds the state chart. The three choices above stay independent.

### File memory and setup direction: 2026-09-13

Jeff asked for a simple memory system built from workspace files, with Git,
Entire, Jujutsu, or Beads where useful. Persistence across sessions is a product
goal. He requested a comparison with other agents and questioned whether a
conductor or automatic CLI installation would add unnecessary complexity.
The [persistence study](research/file-memory-and-persistence.md) informs this
implementation proposal. No additional backend or service is selected.

Keep project knowledge in editable files. Reuse `AGENTS.md`, `STATE.md`, the
`.vivary/context.md` contract, and existing typed records. Load compact guidance
and current state when a run begins, then retrieve relevant project knowledge
through the existing context owner. Keep large source files and transcripts out
of the always-loaded context. Preserve the user's existing folder names.

The agent can update progress and sourced project notes within its authorized
file scope. Keep the source and date of a remembered decision, update corrections
in the owning record, and check changed source before relying on an old claim.
A new chat or application restart must recover this context without replaying
the previous transcript. Removing a fact from active memory must exclude it from
later active-memory retrieval. Explicit history searches can still find older
copies. Removal does not purge version history, backups, or captured sessions.

Version control records file revisions. Entire adds optional session provenance
and remote hosting. Beads owns only the issues and insights selected for it.
Enabling it does not transfer existing task ownership or replace Native runtime
records. Select one owner for each fact or task and reference it from other
views. Do not create competing writable copies. Basic file continuity must work with
VCS, Brain, semantic indexes, and external memory providers disabled. The
[optional Brain and learning contract](tickets/18-add-scoped-brain-learning.md)
still governs automatic proposals to change instructions or skills.

Use the existing Native workspace agent as the proposed setup conductor. It
turns the user's purpose and selected guidance into a visible workspace plan.
The GUI and existing Vivary CLI should call the same deterministic creator and
adopter operations. This needs no separate conductor daemon or new package
installer. Native retains execution and conversations. Initial delivery must
repair the existing adapter and package its actual dependencies, then prove
create, reopen, recall, correction, and project separation through the real app.

## GUI and agent parity

Keep the familiar little-agent shape: project navigation, task/session list, conversation, and expandable work panels for files, plans, board, preview, and evidence. The active project and runtime remain visible. Switching projects preserves drafts and never silently retargets an active session.

The GUI operates on actual authorized project files. Agent-Native personal resources remain useful for app-owned material, but are not represented as arbitrary disk files. Preserve dirty drafts, detect external edits, and resolve save conflicts before presenting the editor as reliable.

Every local project operation has a deterministic service contract with a plan, result, error, and capability description. CLI and agent tools share this contract. Transport and command names are selected in the contract ticket, not invented here as shipped exports.

Existing single-workspace commands remain compatible and do not require a running GUI, an Agent-Native account, a registry, or a network connection. Closing the GUI does not revoke access to plain workspace files.

## Runtime ownership and isolation

Use the installed Agent-Native native-runtime host as the initial seam. Preserve native session IDs and event streams. Distinguish runtime installed, configured, authenticated, bound, runnable, and verified. Do not turn the eleven deterministic little-agent host tests into a claim of real execution.

Bind each session to actor, project identity, canonical root or checkout, execution location, runtime, policy revision, and any relevant plan revision. Reattach to that binding. A dropdown change cannot move an existing runtime session to another project.

Offer native local execution and supported sandboxed execution with accurate capability descriptions. A path in a prompt is not filesystem isolation. If a runtime cannot enforce required limits, make that mode unavailable under that policy. Do not compensate by copying credentials or weakening protection.

When VCS is absent, use content fingerprints, conflict-aware patch previews, and a single active writer as the initial supported workflow. Isolated copies can be added with explicit reconciliation. Do not promise branches, atomic merges, or Git rollback for an ordinary folder.

## Research-informed verification

The [HoH comparison](research/hoh-alignment.md) records the owner-requested
review of arXiv:2609.01481v1. Its acceptance refinements belong to outcomes
04, 15, 16, 18, 20, 21, 29, and 36. They are agent-selected implementation criteria,
not evidence that the product already implements the method. Existing native
run, task, session, and receipt owners remain in place.

[The alignment brief](research/hoh-direction-brief.md) of 2026-09-06 extends
that review to the outer loop and the fleet question, with every number traced
to its source page, and records the owner's answers in
[the direction decision](#direction-decision-2026-09-06).

## Brain and self-improvement

Recommend a Brain during onboarding and let the user skip it. Start with sourced files, retrieval, and project-scoped learning records. Semantic indexes and provider-backed memory remain optional and rebuildable where feasible.

The learning loop is evidence capture, candidate lesson, evaluation, review, and accepted change. Separate user knowledge from runtime transcripts and operational traces. Proposals do not rewrite skills, authority, or instructions automatically. Support comparison, rejection, rollback, and provenance.

Default learning scope is the originating project. Moving knowledge into a shared Brain requires explicit selection or policy. Keep credentials, private source material, and another project's context out of automatic cross-project prompts. The user can inspect, export, correct, and remove managed memory with documented limits.

Decided 2026-09-06: the learning loop is WikiSkill-shaped, per
[the direction decision](#direction-decision-2026-09-06). Working agents load
skills and a short index, never the raw learning corpus.

## Full scope and delivery

[Migration](migration.md) maps the complete Littleagent plan and HarnessMax evidence to the surviving program. Existing native framework task/run/session records remain authoritative. Beads and external issue trackers are optional task sources, separate from version control and repository hosting.

The [graph](graph.md) sequences compatibility, project operations, GUI, native execution, templates, learning, integrations, planning/factory/research/intake, and release work. Each implementation slice must add or update its corresponding docs and evidence. Final website and guide publication follows verified product behavior.

The first usable milestone is one GUI registering two independent projects, adopting one safely, running one supported agent in the correct root, and showing a verified result. It is a milestone inside the whole program, not a reduction of the requested scope.

## Decisions still requiring evidence

- Exact source integration and history preservation for Littleagent's dirty local code. Recommended destination is a Vivary app package alongside existing Python packages, without nested .git metadata. Validate Agent-Native build and deploy assumptions before accepting that placement.
- Registry serialization and app persistence ownership. Reuse framework state for native runs and references, preserve portable filesystem truth, and avoid premature duplicate tables.
- Supported Jujutsu, host, and tracker write operations at first release. Registering and working in their folders does not prove an integrated connector.
- Runtime authentication and execution location. A native login or documented adapter does not prove the sandboxed path.
- Concrete agent-readiness protocols required by the live checker. The all-checks 100% target is retained. Real authentication or commerce capabilities may require additional product decisions.

No release date or package version is invented. Publication, remote creation, data migration, and legacy retirement are explicit operations with their own evidence and authority.


## Iterative process decision: 2026-09-06

Authority: the owner explicitly requested a bounded process and environment
maintenance ticket, modest sub-agent use, and discussion between product slices.
The owner asked to overwrite the original handoff, clean task temporary files,
keep knowledge searchable through open formats and graph links, and incorporate
the small maintenance details that prevent documentation and storage buildup.

The [execution contract](execution-contract.md#one-reviewable-iteration) owns this
repeatable process. Packet [20d](packets/20d-process-environment-maintenance.md)
applies it once and updates environment prerequisites. This decision authorizes
task-owned disposable-resource cleanup. The owner also requested dependency
preparation. After an initially declined prompt, the owner renewed the setup
permission and the dependency installation and build passed under packet 20d.
It does not accept unfinished runtime behavior or activate the whole factory.


The owner clarified on 2026-09-07 that each claimed ticket proceeds through
planning, implementation, QA, correction, independent review, and cleanup in
one flow. Routine phase changes do not require another user instruction.
Stop for consequential decisions or unresolved authority-bound operations.
Preserve the existing Markdown/HTML handoff instead of creating phase copies.

## Approachable workspace decision: 2026-09-06

Authority: the owner requested an installable workspace with a GUI that makes a
disciplined work process usable without programming expertise.
The owner clarified that Vivary is a tool for accomplishing real work, not an
educational product. The GUI directs work and presents results and decisions.
Do not add lessons, tutorials, or teaching flows from this accessibility goal.
Existing Claude Code and Codex subscriptions are supported by the current Code
runtime path. PR #59 verifies the bounded Codex prototype; see the
[acceptance register](desktop-acceptance-status.md) for exact platform and artifact
coverage. A simpler one-button connection journey remains a product goal.

Preserve GUI-first and headless-capable use, runtime choice, and the complete agreed
scope. Show the task, changed result, passing and failing checks, and required
user judgment first. Keep evidence and technical detail available on demand.
Authentication, subscription eligibility, available capabilities, and supported
connection APIs require provider-specific verification. The desired experience
does not establish automatic sign-in or authorize credential copying.

At task close, inspect evidence for a useful lesson. Amend an existing owning
instruction, check, or module guide when the evidence supports a reusable change.
Keep speculation out of accepted learning and avoid creating a document per lesson.
The existing learning review and project-boundary rules still apply.


The owner clarified that developers are only one audience. Vivary serves
professionals doing coding, research, writing, second-brain work, and other tasks.
Assume basic ability to install and message an agent, not professional programming
expertise or prior coding work. Use direct, respectful product language. The website must explain the
product, setup, supported runtime connections, requirements, and important limits.
The application focuses on directing work and reviewing results. Website details
must follow verified capabilities rather than presenting the planned connection
experience as already implemented.

When owner statements genuinely conflict, name the conflicting requirements and
the decision they affect. Discuss that conflict before choosing a consequential
interpretation. An explicit correction updates the existing decision.

## Coherent desktop release decision, 2026-09-13

Jeff specified the end state as a working Vivary.exe with project workspaces,
persistent and searchable chat sessions, useful memory, native external logs,
and fast file/code search. He also authorized consolidating useful work.
[The desktop release target](desktop-release.md) owns the ordered delivery queue,
storage model, complete original CLI coverage, and actual Windows finish line.
PRs #3 and #4 are integrated into dev. Prior standalone experiment plans do not
override this queue. The broader outcomes remain covered in later milestones.

## Host and browser access decision: 2026-09-13

Jeff decided that the same Vivary instance runs on a user-controlled computer
or a suitable self-hosted server, with a responsive browser client for phone
and desktop. Runtime agents, credentials, projects, and history remain on the
host. The local desktop needs no Vivary account and stays on loopback by
default. Remote browser access is explicit and authenticated and does not
expose the private Zo preview. Issue
[#30](https://github.com/vivary-dev/Vivary-New/issues/30) owns remote/browser
access. Issue [#31](https://github.com/vivary-dev/Vivary-New/issues/31) owns
live project preview plus supported agent browser debugging. The existing
Electron build includes Chromium; no separate Google Chrome distribution is
presumed.

Letta Code is a major design reference for persistence. Reuse the existing
[Letta Code study](research/letta-code-workspace-patterns.md), the
[persistence study](research/file-memory-and-persistence.md), and
[Native owners](native-owners.md) rather than adding a new agent system.
Mac distribution is optional later roadmap work outside the active
Windows/shared-web milestone. Native phone apps and a managed cloud service are
not in scope.


## Background work approval decision, 2026-09-14

Jeff selected both reopening the same agent conversation and work that continues
after leaving the browser. Background work must be obvious and provide approval
and denial. Issue [#35](https://github.com/vivary-dev/Vivary-New/issues/35) owns
this requirement.

The original per-turn launch decision and two-minute limit are superseded by
Jeff's September 16 correction below. The [issue #35 receipt](receipts/35-background-approval.md)
retains the original implementation and its historical acceptance.

## Native coding permissions and activity, 2026-09-16

Sending a message starts work. The agent may continue until it completes, fails,
the user selects Stop, or the host closes. Leaving a browser page does not stop
it. Startup and process cleanup retain time limits; model turns have no fixed
wall-clock cutoff. Restart interrupts unfinished work and never replays actions
or instructions awaiting an old launch approval.

Codex owns tool execution. Vivary relays its native action approvals and questions
into the existing workspace. Decisions bind to the live owner, project connection,
run, and native request. The browser cannot replace the command or permissions.
Stop and pending decisions remain available when another project is selected.

Runtime settings offers Normal, Read only, and YOLO for Codex, with no Plan mode.
Normal allows project work and asks when an action needs broader access. Read only
prevents local command writes and permission expansion. YOLO allows full host
command access without action prompts. Connected services retain their own access
rules. Changes apply to the next turn and never expand an active turn silently.

Public progress updates use compact, darker cards within the conversation. Actual
native subagent activity has distinct cards with recorded identities and status.
Final answers use the main text style. Never infer subagents from consecutive
assistant messages or label public progress as hidden reasoning.

The [Workbench runtime contract](../../../packages/workbench/README.md) owns
adapter capabilities and limitations. The [acceptance register](desktop-acceptance-status.md)
separates source, hosted, simulated-protocol, and real Windows evidence. Issue #38
retains broader linked-conversation, handoff, and concurrent-conversation work.
