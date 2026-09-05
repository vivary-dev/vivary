# Vivary multi-project workbench

Updated: 2026-09-05. Status: documented program; implementation evidence is tracked by the ticket graph. The product direction is approved. Technical defaults below remain recommendations until reviewed.

This is the canonical program plan. Start here, then open [the graph](graph.md), [source evidence](evidence.md), [migration map](migration.md), or [release criteria](release.md). [CONTEXT.md](CONTEXT.md) defines the terms.

## Product direction and authority

Vivary absorbs the public Littleagent work into one product evolution. The GUI is the primary work environment. Standalone Vivary workspaces and users' favorite runtimes remain supported.

The product handles new and existing projects, workspace templates installed within projects, an optional recommended Brain, and learning from verified work. Version control is optional. GitHub, Gitea, Jujutsu, and Beads belong to separate integration choices.

The full little-agent scope survives: visual planning, research, tickets, workers, review, portable handoffs, CLI agents, factory mode, email intake, and heartbeat maintenance. Delivery order does not remove later scope.

Planning is the immediate priority, and HarnessMax removal remains deferred. Website, UI, docs, guides, and a real 100% isitagentready.com result belong to the delivery program. This plan does not claim that the behavior is implemented, released, or published.

No model, storage vendor, hosting plan, default runtime, or payment service is selected by this document. Earlier Littleagent implementation authority remains relevant to compatible work after the changed contracts are reconciled. Planning authority does not establish implementation or publication evidence.

## Execution decision: 2026-09-05

The owner explicitly selected BrowserPod for this work and rejected Habitat/WSL
after the agent used the machine default. BrowserPod is the selected execution
environment; connection readiness, toolchain compatibility, and native coding
runtime behavior still require direct proof. Earlier Habitat checks remain
historical evidence and do not satisfy BrowserPod acceptance. Do not substitute
another environment. Preferred runtime choice and standalone workspace support
remain part of the product; this decision does not authorize account, spending,
credential-transfer, or production-hosting changes.

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

The GUI starts with three choices: create a project, open an existing folder, or open an existing Vivary workspace. An agent can invoke the same operations with structured inputs and receive the same plan and receipt.

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

Resume and extend the existing [held template-installer program](external-dependencies.md#held-template-installer-program) as the one implementation source for template semantics, verified transport, combined plans, and transactional apply. Its earlier implementation hold is not silently lifted by this planning request.

The catalog continues to own template content, manifests, versions, archives, and distribution. Vivary owns composition, adoption, verification, receipts, and conformance. Agent-Native app scaffolding and integration blueprints are different mechanisms. They must not become hidden substitutes for Vivary workspace templates.

A project created from a template remains a normal standalone Vivary workspace. The collection references it and routes sessions to it. Installing a template does not install another coordinator server, copy the whole collection, create a remote repository, or start another agent.

Bind each installation to the project ID, canonical target, template version and digest, selected options, target fingerprint, and authority. Recover across both filesystem changes and registry updates. Repeated requests must not create duplicate projects or lose an already completed install after a crash.

Allow project-contained workspace templates, including knowledge workspaces. First delivery supports a single collection of explicitly registered roots. Recursive collection coordination requires an explicit future contract for cycles, ownership, and authority inheritance. It is not implied by ordinary template nesting.

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

## Brain and self-improvement

Recommend a Brain during onboarding and let the user skip it. Start with sourced files, retrieval, and project-scoped learning records. Semantic indexes and provider-backed memory remain optional and rebuildable where feasible.

The learning loop is evidence capture, candidate lesson, evaluation, review, and accepted change. Separate user knowledge from runtime transcripts and operational traces. Proposals do not rewrite skills, authority, or instructions automatically. Support comparison, rejection, rollback, and provenance.

Default learning scope is the originating project. Moving knowledge into a shared Brain requires explicit selection or policy. Keep credentials, private source material, and another project's context out of automatic cross-project prompts. The user can inspect, export, correct, and remove managed memory with documented limits.

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
