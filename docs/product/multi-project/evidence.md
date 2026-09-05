# Multi-project Vivary evidence brief

Date: 2026-09-05

This brief records public code and source-safe constraints for the proposed multi-project Vivary program. It separates existing behavior from proposed application work. The companion documents own the decisions and delivery plan:

- [Program design](design.md)
- [Ticket graph](graph.md)
- [Migration plan](migration.md)
- [Release plan](release.md)
- [External dependencies](external-dependencies.md)

## Public source identities

`vivary-dev/vivary` is the canonical public product repository. `Jeff-Kazzee/littleagent` is the public source identity for the workbench specifications and implementation. `The-Little-AI-Company/harnessmax` is a public legacy evidence source. Private planning, machine paths, branches, commit hashes, dirty-state inventories, and review material are maintained outside this public contract.

The public repository contract governs branches, reviews, tests, documentation generation, and release evidence. This brief does not convert a source observation, proposal, or local result into shipped or published behavior.

## Current workspace behavior

Vivary is a local governed-context standard and scaffolder. It does not own the host
project or require one agent runtime. The [architecture](../../ARCHITECTURE.md)
lines 3-12 and 29-60 define that boundary.

Greenfield creation already has a safe entry point. `scaffold_thin_workspace` in
[`create_vivary.py`](../../../packages/create-vivary/create_vivary.py) lines 656-773
creates the public `thin-v0.3` workspace. The generated workspace has five files:
`AGENTS.md`, `STATE.md`, `.gitignore`, `.vivary/context.md`, and
`.vivary/workspace.toml`. The [creation guide](../../guides/create-workspace.md)
lines 27-95 documents the empty-target rule and verification steps.

`_thin_workspace_toml` in `create_vivary.py` lines 5047-5105 records the preset,
state file, private and runtime paths, runtime projections, optional capabilities,
and typed project records. Its project type is graph data inside one workspace. It
is not a registry of managed filesystem projects.

The `init` parser in `create_vivary.py` lines 8792-8842 supports four presets:
`coding`, `second-brain`, `knowledge-work`, and `writing`. It can add bounded
`agents` and `claude` projections. It can declare CocoIndex code context and optional
storage or memory policy. These flags do not discover or supervise agent runtimes.

Brownfield adoption already separates planning from mutation. `BrownfieldInventory`
in `create_vivary.py` lines 4535-4565 takes a bounded read-only inventory.
`plan_adopt` at lines 5346-5405 returns a deterministic plan and plan hash.
`adopt_workspace` at lines 6342-6412 requires that approved hash, replans before the
first write, refuses conflicts, and uses transaction recovery.

The [adoption guide](../../guides/adopt-project.md) lines 29-108 limits the
default payload to three Vivary files plus managed blocks in `AGENTS.md` and
`.gitignore`. Lines 163-169 state that adoption does not create records, copy
templates or skills, enable providers, or scan for modules.

The existing wizard does not onboard projects or runtimes. `_run_wizard` in
`create_vivary.py` starts at line 4322. Its parser at lines 8844-8858 configures
storage, a storage provider, memory, size, and privacy for one workspace.

## Current context and control behavior

Core is a pure library shared by the role packages. The
[architecture](../../ARCHITECTURE.md) lines 62-67 and 108-143 assigns distinct
authority to Tropo, Strato, Ozone, and Exo while keeping common validation in Core.

The following functions can support read-only project views:

- `observe_checkouts` in [`workspace_observe.py`](../../../packages/core/vivary_core/workspace_observe.py) line 1931 observes explicit checkout roots with hardened Git execution.
- `project_workspace_graph` in [`workspace_model.py`](../../../packages/core/vivary_core/workspace_model.py) line 506 projects nodes, edges, conflicts, unknowns, and a workspace fingerprint.
- `observe_content` in [`workspace_content.py`](../../../packages/core/vivary_core/workspace_content.py) line 483 reads bounded public content under the effective privacy policy.
- `compile_task_capsule` in [`capsule_compile.py`](../../../packages/core/vivary_core/capsule_compile.py) line 3040 compiles bounded task context from an observed graph.

The architecture lines 163-170 says observation does not fetch or write. Core keeps
conflicts and unknown values explicit. A GUI can present these results without
changing Core's authority.

Strato evaluates policy. `_validate_request`, `_decide_valid_request`, and
`decide_governed` in [`strato.py`](../../../packages/strato/strato.py) lines 101-253
check actor authority, workspace fingerprint, scope, budgets, capsules, receipts,
and the next loop step. Strato does not start or persist agent sessions.

Exo provides graph coordination and caller-owned control transitions.
`workspace_state`, `cmd_conflicts`, `cmd_board`, and `cmd_claim` in
[`exo.py`](../../../packages/exo/exo.py) lines 155-390 can inform project and task views.
`governed_control` at lines 823-841 dispatches bounded Core operations. The
architecture lines 218-225 says Exo provides no scheduler, state store, agent runner,
network call, provider call, repair write, or publishing path.

The front door in [`vivary_cli.py`](../../../packages/vivary/vivary_cli.py) lines 49-103
uses a static table of ten task verbs and imports one component for each call. The
architecture lines 151-159 says it adds no component code, subprocess, or dynamic
discovery. It is a useful command boundary, but it does not own application state.

The passive capability report can populate an environment screen.
`capability_report` in `create_vivary.py` lines 8752-8757 uses bounded distribution
inspection. The architecture lines 244-251 says the probe does not import or start
optional packages.

## Missing application behavior

The following negative inventory concerns Vivary Python packages only. Agent-Native already provides native sessions, runs, transcripts, tasks, and other application owners; [the native inventory](native-owners.md) distinguishes those installed or documented capabilities from configured Workbench behavior.

No inspected Vivary Python package provides a desktop GUI, local application server, managed
project registry, project switcher, persistent session store, terminal supervisor,
or streaming agent transcript.

No package discovers preferred runtimes, starts or attaches to runtime sessions,
cancels their process trees, or persists runtime-specific session identity. The
`agents` and `claude` files created by `init` are instruction projections only.

Vivary does not provide a tool-permission broker. It has no Git lifecycle adapter for
clone, init, worktree, branch, commit, or push. It has no hosting provider or task
tracker connector. Core can observe Git, and Exo can model coordination, but neither
performs those operations.

The public `site/` directory is an Astro documentation and marketing site. It is not
the proposed local GUI. The repository has no OpenAPI description, HTTP application
API, A2A agent card, or `/.well-known/agent.json` file. It does publish
`site/public/llms.txt`, `site/public/llms-full.txt`, and `site/public/robots.txt`.
The optional MCP package is a local read-only standard-input and standard-output
adapter, as stated in the architecture lines 287-289.

These missing features belong to the proposed program. [Program design](design.md)
must define a separate application and session layer while leaving filesystem
workspaces authoritative. [Migration plan](migration.md) must state how useful
little-agent work moves into that layer. Deletion of legacy work remains deferred.

## Held template-installer program

The [external dependency contract](external-dependencies.md#held-template-installer-program) assigns portable template semantics and conformance fixtures to Vivary, template content and distribution to the Agent Workspace Catalog, and composition, adoption planning, human gates, and post-install checks to `create-vivary`.

The dependency remains held. Its six outcomes cover semantic and transport contracts, read-only discovery, combined planning, atomic apply, adversarial and catalog-wide proof, and synchronized documentation and installed-artifact release evidence. Ticket 19 cannot start until the hold is explicitly lifted, all six outcomes have evidence, a compatible installed API exists, and a canonical approved source packet is available.

## Website, documentation, and release evidence

Canonical prose lives in `docs/`. The repository contract lines 91-103 says the site
copies are generated and must not be edited directly. The root `README.md` owns
publication truth, and `CHANGELOG.md` records each development line.

[`sync-docs.mjs`](../../../site/scripts/sync-docs.mjs) owns the canonical-doc to site-doc
mapping and the generated LLM files. The
[release workflow](../../RELEASE-WORKFLOW.md) lines 114-121 requires
`npm run sync-docs` and a clean diff for site docs, `llms.txt`, and
`llms-full.txt`. The same workflow requires the site build when canonical docs or
release-facing files change.

[Release plan](release.md) must cover canonical docs, user guides, generated site
docs, the GUI product pages, screenshots, link checks, browser proof, package and
docs parity, repository tests, Ozone review, installed-artifact proof, deployment,
and live verification. It must keep source versions separate from published registry
truth.

The deployed production URL must receive a real isitagentready.com check. A recorded
100 percent result is a release gate before announcements. The evidence must include
the tested URL, date, checker result, and redirects. A local or mocked score does not
close this gate. The checker criteria can change, so the plan must use the actual
checker result rather than a presumed local replica.

OpenAPI belongs in the release only if Vivary ships real HTTP routes. A2A belongs in
the release only if Vivary implements and tests an A2A adapter. The docs must not
claim either capability before the code and live checks exist.
