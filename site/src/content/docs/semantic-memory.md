---
title: "Optional semantic memory"
description: "Implemented contract for Tropo-backed semantic-memory adapters and their boundary from independent agent LTM."
editUrl: "https://github.com/vivary-dev/vivary/edit/dev/docs/SEMANTIC-MEMORY.md"
---

Status: architecture note plus first optional Cognee adapter slice
[#84](https://github.com/vivary-dev/vivary/issues/84), now split into
[#85](https://github.com/vivary-dev/vivary/issues/85) for presets/capabilities and
[#86](https://github.com/vivary-dev/vivary/issues/86) for semantic memory/Cognee,
aligned with [#20](https://github.com/vivary-dev/vivary/issues/20). The setup slice
landed `knowledge-work`, `create-vivary capabilities`, `--memory local|cognee`,
`.vivary/memory.toml`, scaffolded policy docs, and doctor memory reporting. The first
runtime slice adds an optional `vivary-memory-cognee` package with `vivary-cognee`
doctor/index/recall/forget commands.

## Position

Vivary remains graph-first, modular, local, file-first, and inspectable. The baseline
is still:

- `tropo` owns deterministic typed graph truth.
- `strato` owns the agent loop and retrieval behavior.
- `create-vivary init --preset second-brain` gives users a clean personal knowledge
  scaffold without semantic memory by default.
- Optional semantic providers can improve recall, but they only return candidates for
  the agent to inspect through the typed graph.

Cognee is a useful reference and possible provider because it presents graph memory
and long-term agent recall as first-class concepts. It must not become Vivary's
foundation, default install, or second source of truth.

## Non-negotiables

- Do not make Cognee default.
- Do not add Cognee to core `create-vivary`, `vivary-tropo`, `vivary-ozone`,
  `vivary-exo`, or the default install path.
- Do not replace `tropo`, `tropo query`, graph traversal, or `tropo check`.
- Do not create a second undocumented source of truth.
- Do not implement naive chunked RAG over arbitrary Markdown.
- Do not specialize the generic `second-brain` preset around one person's vault.
- Do not require a server, daemon, API key, hosted account, or heavyweight runtime by
  default.
- Filter privacy boundaries before any indexing, embedding, export, cache write, or
  recall.

## Presets and capabilities

Presets and capabilities are separate axes:

| Axis | Examples | Job |
|---|---|---|
| Preset | `coding`, `second-brain`, `knowledge-work`, `writing` | Shape the starter graph, modules, first change, and verification path. |
| Capability | `storage:file`, `storage:embedded`, `memory:local`, `memory:cognee`, `active-context:cocoindex-code` | Add optional runtime power behind explicit install/config gates. |

This keeps Cognee and database choices composable. A `writing` workspace can use no
semantic memory, local semantic memory, or Cognee. A `knowledge-work` workspace can do
the same. The preset should never imply a heavyweight provider.

Recommended preset direction:

| Preset | Purpose | Starter module | First verification |
|---|---|---|---|
| `second-brain` | Personal knowledge base: notes, sources, concepts, memory, retrieval routines. | `knowledge-base` | Retrieve a known note through the typed graph. |
| `knowledge-work` | Agent-operable workbench for research, decisions, artifacts, proof, and publish/deploy readiness. This is the generic version of the local-gate-plus-proof pattern, not a personal vault. | `workbench` | Produce or locate one artifact and verify it with a local gate or proof check. |
| `writing` | Drafts, research, editorial passes, publication gates, and release/publish copy. | `manuscript-system` | Review one draft against editorial criteria and linked sources. |

`second-brain`, `knowledge-work`, and `writing` all receive the same optional memory
capability path. `knowledge-work` is a generic workbench preset, not a renamed
personal vault.

## Provider model

Semantic memory is a `strato` retrieval sidecar over a `tropo` graph snapshot. A
**SemanticMemoryAdapter** is a Tropo-backed projection: it resolves a workspace and
builds the privacy-filtered typed snapshot that it indexes or uses to validate recall.
The category can cover local and Cognee-backed projections; the observed concrete
implementation is `CogneeMemoryAdapter`. It never owns canonical content.

```text
files + frontmatter
        |
        v
tropo typed graph  -->  tropo query / graph / blast / check
        |
        v
CogneeMemoryAdapter(root)
  resolves workspace + builds privacy-filtered snapshot per operation
        |
        v
rebuildable provider dataset  -->  typed, known-node RecallHit candidates
        |
        v
strato retrieve step  -->  agent reads source files
```

The adapter, not its caller, owns snapshot construction and privacy filtering.
`index` and `recall` each build a current snapshot from the resolved workspace; callers
do not supply nodes or edges. Provider state is rebuildable from the typed graph plus
approved source files. If provider state and source files disagree, source files plus
`tropo` win.

### Adjacent memory terms

- **SemanticMemoryAdapter** — a Tropo-backed projection for semantic recall. Its
  candidates remain typed graph leads, not canonical content.
- **AgentLTM** — an independent agent long-term-memory store, not a Tropo projection
  or semantic-adapter dataset. Bellamente is discussed only in the separate
  [AgentLTM documentation](https://github.com/vivary-dev/vivary/tree/dev/docs/bellamente-memory).
- **CandidateRecallProvider** — a provider-neutral, optional source of normalized
  prior assertions for the `vivary-core` candidate-recall firewall in
  [#205](https://github.com/vivary-dev/vivary/issues/205). It is not a provider wire
  protocol or a synonym for SemanticMemoryAdapter. Before Core evaluates a
  Bellamente candidate, normalization must supply typed evidence and either a known
  stable Tropo node ID or the explicit unresolved-identity marker defined by the
  [Bellamente contract](https://github.com/vivary-dev/vivary/blob/dev/docs/bellamente-memory/SPEC-bellamente-memory.md#6-candidaterecallprovider-contract).
  The unreleased `vivary_core.recall` surface then classifies the candidate and can
  project a caller-persisted transition. Learned memory never silently becomes
  authored truth.

## Minimal interface

The current seam keeps provider writes separate from health reporting. The
`SemanticMemoryAdapter` name below documents the shape implemented by
`CogneeMemoryAdapter`; it is not a published shared provider base class.

```python
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

@dataclass(frozen=True)
class MemoryNode:
    id: str
    type: str | None
    path: str
    title: str
    text: str
    fields: dict[str, Any]

@dataclass(frozen=True)
class MemoryEdge:
    source_id: str
    field: str
    target_id: str

@dataclass(frozen=True)
class RecallHit:
    node_id: str
    type: str | None
    path: str
    score: float
    reason: str
    source: str  # fixed "provider" label from the Cognee adapter
    edge_context: list[MemoryEdge]
    provider: str

@dataclass(frozen=True)
class MemorySnapshot:
    root: str
    dataset: str
    fingerprint: str
    nodes: list[MemoryNode]
    edges: list[MemoryEdge]
    private_patterns: list[str]

class SemanticMemoryAdapter(Protocol):
    async def index(
        self, *, dry_run: bool = False, approved: bool = False
    ) -> dict[str, Any]: ...

    async def recall(self, query: str, *, k: int = 10) -> list[RecallHit]: ...

    async def forget(self, *, approved: bool = False) -> dict[str, Any]: ...

def doctor(root: str | Path) -> dict[str, Any]: ...
```

Minimum current contract:

- `CogneeMemoryAdapter(root)` resolves the workspace. `index` and `recall` each build
  their own current, privacy-filtered snapshot; they do not accept caller-supplied
  nodes, edges, or recall filters.
- `index(dry_run=True)` reports node/edge counts and the fingerprint for the whole
  snapshot without returning its contents or performing provider writes.
  A non-dry-run index is an async whole-dataset refresh: after the configured approval
  gate, it removes the prior dataset and remembers every current snapshot node.
- `recall` is async and returns only typed hits whose stable node IDs occur in the
  current snapshot. Its `k` is normalized by the adapter; `tropo query` applies
  type, path, and edge filters after recall.
- `forget(approved=True)` is async whole-dataset removal, not targeted node deletion;
  it also removes the adapter manifest.
- `doctor(root)` is a separate, module-level, read-only declarative report. It builds
  a snapshot and inspects config, package availability, and manifest state without
  constructing the adapter, importing Cognee, or calling the provider.
- The optional Cognee runtime is imported only for live adapter operations. Missing
  extras produce status or a helpful adapter error, not an import-time core failure.

## Cognee provider

Cognee plugs in through the separate optional `vivary-memory-cognee` adapter package.
Future packaging options may still include `vivary-strato[cognee]` if `strato` becomes
packaged code, or `create-vivary[cognee]` if the scaffolder owns provider setup rather
than core runtime.

The adapter maps:

| Vivary | Cognee adapter responsibility |
|---|---|
| workspace root | resolve the workspace before every operation |
| `tropo graph` snapshot | build a rebuildable, privacy-filtered provider input |
| typed node and edge | encode the current snapshot with stable Vivary node IDs and recall context |
| privacy policy | filter before packets reach the provider |
| `RecallHit` | return a typed Vivary node candidate for `strato` to inspect |
| provider state | cache/index only, safe to delete and rebuild |

Cognee-specific details stay behind the adapter: package imports, initialization,
LLM/embedding model settings, data directories, optional server/UI usage, and any
remote/API key configuration. The default Vivary install should not import Cognee or
run a Cognee doctor. Including a Cognee layer "in Vivary" means the monorepo owns an
optional adapter, tests, docs, and install flow; it does not make Cognee a dependency
of core packages or the default preset output.

Current commands:

```bash
vivary-cognee doctor --root . --json
vivary-cognee index --root . --dry-run --json
vivary-cognee index --root . --yes --json
vivary-cognee recall "what should I read about auth?" --root . --json
vivary-cognee forget --root . --yes --json
```

## Config

Use `.vivary/memory.toml`, not `.vivary/storage.toml`.

Reason: `.vivary/storage.toml` configures `tropo` storage and search. Semantic memory
is retrieval policy for `strato` plus optional provider state. Keeping it separate
prevents users from treating a semantic index as graph truth and lets storage and
memory be installed independently.

Approved activated Cognee-policy example:

```toml
# .vivary/memory.toml
# Activated optional semantic memory. Provider state is rebuildable cache, not source
# truth.

[memory]
enabled = true
mode = "semantic-provider"
provider = "cognee"   # vivary-local | cognee

[memory.privacy]
respect_gitignore = true
respect_vivary_private = true
private_paths = ["USER.md", "MEMORY.md", "memory/**", "heartbeat-reports/**", ".strato/private/**"]
fail_closed = true

[memory.cognee]
state_path = ".vivary/memory/cognee"
require_explicit_index = true
allow_network = false
api_key_env = ""
allow_without_api_key = false
allow_telemetry = false
```

Approved scaffold contract: selecting a memory capability writes only disabled
policy/config and inert documentation. It must not install, enable, index, call a
provider, or mutate memory. Human activation is a separate gate; install and live
proof remain separate explicit gates after activation.

Current scaffold output diverges: it writes `enabled = true` with runtime gates closed
(`allow_network = false` and `require_explicit_index = true`). It installs nothing,
indexes nothing, and makes no provider call, but does not yet meet the approved
disabled-policy contract.

In the source checkout's unreleased `vivary-memory-cognee` 0.1.2 adapter, privacy
filtering is owned by `build_snapshot`. Built-in private patterns and
`memory.privacy.private_paths` always apply. When `respect_gitignore` is `true` (the
default), the adapter passes only relative Markdown candidates through Core's
fail-closed `content_privacy_policy` and analyzes only the admitted absolute paths.
`respect_vivary_private` and `fail_closed` remain accepted and type-checked policy
fields, not filtering switches. Snapshot construction refuses linked, out-of-root,
hard-linked, or unstatable source files instead of silently skipping them. [Behavioral
evidence](https://github.com/vivary-dev/vivary/blob/dev/packages/memory-cognee/tests/test_memory_cognee.py); verified: 2026-08-09.

### Privacy boundary

The source checkout and next `vivary-memory-cognee` release include
`.strato/private/**` in the built-in floor and compare explicit privacy patterns
case-insensitively on Windows. The currently published 0.1.0 package lacks that
built-in `.strato/private/**` entry; its generated Vivary configuration lists the path
in `memory.privacy.private_paths`, but hand-written or older configuration must add it
explicitly before indexing.

Git-ignore privacy now uses Core's Git-equivalent policy rather than the adapter's
former dependency-free approximation. Core executes bounded
`git check-ignore --no-index` work at the canonical workspace root and fails closed
when policy cannot be established. Built-in and explicit private paths remain the
independent privacy floor even when `respect_gitignore` is `false`.

Runtime/index state belongs under `.vivary/memory/` and should be ignored. The adapter
binds Cognee's data, system, cache, and log roots to the configured `state_path`
before importing Cognee, so provider side effects stay in the workspace cache instead
of user-home or package directories. The policy file can be committed if it contains
no secrets. API keys and hosted endpoints should use environment variables.

`allow_network = false` is an enforced default. `vivary-cognee doctor` and
`vivary-cognee index --dry-run` can still prove package readiness and packet counts,
but provider writes/recalls/forgets require `allow_network = true`; they also require
either a populated `api_key_env` whose environment variable exists, or the explicit
local-provider escape hatch `allow_without_api_key = true`. Cognee telemetry/tracing
is forced off by default through `allow_telemetry = false`, even when inherited
environment variables try to enable tracing; setting it to `true` is an explicit
third-party telemetry opt-in.

Provider recall is graph-fingerprint gated: if the manifest is missing or stale, recall
refuses and asks for `vivary-cognee index --yes`. Approved index replaces the prior
workspace-bound dataset before remembering current node packets, and `forget --yes`
requests dataset deletion rather than a memory-only reset. Dataset names include a
workspace path hash even when a label is configured, so committed config cannot
accidentally target another workspace's provider dataset.

Storage/database remains independently configured in `.vivary/storage.toml`. A user
may choose file storage with Cognee disabled, embedded storage with no semantic memory,
or embedded storage plus semantic memory. The install flow should explain those as
separate choices instead of collapsing them into one "smart memory" switch.

## Setup flow

The default presets remain small:

```bash
create-vivary init my-notes --preset second-brain
create-vivary init my-work --preset knowledge-work
create-vivary init my-book --preset writing
```

They produce file-first workspaces unless the user explicitly chooses optional
capabilities. Interactive wording is plain English:

```text
Which optional capabilities should this workspace offer?

1) Typed graph only
   Smallest setup. Use tropo graph, tropo query, and files.

2) Local database/search
   Add embedded local storage for larger graphs. No account or server.

3) Local semantic memory
   Add semantic recall policy and local provider hooks. No Cognee, no network.

4) Cognee semantic memory
   Add Cognee provider policy and verification docs. Install and indexing remain
   explicit gates.
```

If the user chooses a semantic option, ask one more approval-oriented question:

```text
Do you want extra recall beyond the typed graph?

1) No semantic memory
   Smallest setup. Use the typed graph and text search only.

2) Local Vivary search only
   Keep everything local. No embeddings, account, server, or Cognee.

3) Optional semantic memory provider
   Add provider policy files, but do not install or index yet.

4) Cognee provider
   Add Cognee provider policy and verification docs. Install and indexing remain
   explicit later gates.
```

Agent/non-interactive flags should stay explicit and composable, for example:

```bash
create-vivary init my-notes --preset second-brain --memory none --no-wizard
create-vivary init my-notes --preset second-brain --memory local --no-wizard --yes --json
create-vivary init my-notes --preset second-brain --memory cognee --no-wizard --dry-run --json
create-vivary init my-work --preset knowledge-work --storage embedded --memory local --no-wizard --yes --json
create-vivary init my-book --preset writing --memory cognee --no-wizard --dry-run --json
```

`--auto` must not silently choose Cognee. At most, `--auto --size large --privacy local`
may choose local Vivary search, while Cognee requires an explicit provider flag or
interactive answer.

Agent-mode discovery does not require the agent to know package names.
`create-vivary capabilities --json` reports available capabilities:

```json
{
  "preset": "knowledge-work",
  "default_capabilities": ["storage:file", "memory:none"],
  "available_capabilities": [
    {
      "id": "storage:embedded",
      "label": "Local database/search",
      "default": false,
      "requires_install": ["vivary-tropo[embedded]"],
      "requires_approval": true,
      "network": false
    },
    {
      "id": "memory:cognee",
      "label": "Cognee semantic memory",
      "default": false,
      "requires_install": ["vivary-memory-cognee"],
      "requires_approval": true,
      "requires_explicit_index": true,
      "network": "configurable, default false",
      "adapter_status": "optional-package"
    }
  ]
}
```

The agent may present those choices to the user, write config in dry-run, or install
only the explicitly selected pieces. It must not index source text, private memory, or
remote services merely because a capability exists.

## Doctor behavior

`vivary_cognee.doctor(root)` is the current module-level, read-only semantic-memory
report. It is separate from `CogneeMemoryAdapter`: it resolves the workspace, parses
the memory config, builds the privacy-filtered Tropo snapshot, checks Cognee
availability without importing it, and, when Cognee is available, resolves and
compares the manifest. It does not construct an adapter or make provider, embedding,
or LLM calls.

Doctor resolves and confines `state_path` before checking provider availability. An
unsafe path is therefore `misconfigured` whether Cognee is installed or absent, and
that refusal occurs before Cognee is imported, probed, or called. A safe
`unavailable` report confirms both that the configured state path stays in the
workspace and that the package is absent.
[Doctor regressions](https://github.com/vivary-dev/vivary/blob/dev/packages/memory-cognee/tests/test_memory_cognee.py);
verified: 2026-08-09.

Its current states are:

| State | Meaning |
|---|---|
| `disabled` | semantic memory is disabled or its provider is `none` |
| `not-cognee` | another enabled provider is configured; this adapter does not handle it |
| `unavailable` | Cognee is configured, its state path is confined to the workspace, and its package is not installed |
| `misconfigured` | root, config, snapshot, or state-path validation failed |
| `stale` | Cognee is available but the manifest is absent, unreadable, or does not match the current snapshot |
| `healthy` | Cognee is available and the manifest matches the current snapshot |

The report is declarative: it describes config, snapshot, package, and manifest state;
it never activates or talks to the provider.

### Workspace doctor (`create-vivary doctor`)

The workspace doctor separately returns a `memory` report without requiring a provider
runtime or invoking live provider operations. Its status vocabulary is intentionally
different from the adapter-package doctor:

| State | Meaning |
|---|---|
| `disabled` | no memory config, `enabled = false`, or provider `none` |
| `privacy-failed` | private workspace paths are not actively ignored |
| `healthy` | the `vivary-local` policy is configured |
| `configured` | Cognee policy and its adapter are available; indexing still requires approval |
| `unavailable` | Cognee policy is configured but the adapter is unavailable |
| `misconfigured` | config is invalid or the provider is unknown |

For example, the no-config case is agent-gateable JSON:

```json
{
  "memory": {
    "enabled": false,
    "provider": "none",
    "mode": "none",
    "status": "disabled",
    "config": null,
    "privacy": "not-indexed",
    "detail": ""
  }
}
```

## Complementary retrieval

Semantic recall is candidate retrieval, not truth.

Recommended retrieval order:

1. Use `tropo check` to prove the graph is valid.
2. Use `tropo graph`, `tropo blast`, and explicit edges when relationships matter.
3. Use `tropo query` for deterministic text search over typed nodes.
4. Use semantic recall only when meaning-based candidates are likely to help.
5. Read the returned source files directly before acting.
6. Verify with the same workspace checks and human gates.

Current adapter safeguards:

- Recall mapping drops a provider item without a stable Vivary node marker or whose
  node ID is absent from the freshly rebuilt, privacy-filtered snapshot. Private and
  Git-ignored documents are therefore ineligible for recall even if a stale provider
  item names them.
- If semantic score and graph edges disagree, prefer graph edges for truth and use the
  semantic hit as a lead to inspect.
- `tropo query --mode semantic` is the shipped optional-provider bridge. It invokes
  the adapter's async recall boundary, then applies type, path, and edge filters to
  typed results before returning them. It stays unavailable until the user explicitly
  configures, installs, and indexes a supported provider.

## Implementation files

Files touched by the setup slice and likely files for the Cognee adapter PR:

- `docs/SEMANTIC-MEMORY.md` - this architecture and setup note.
- `docs/COMMANDS.md`, `docs/GETTING-STARTED.md`, `docs/HOWTO.md`, and the homepage FAQ -
  user-facing setup and command docs.
- `docs/ARCHITECTURE.md` and `docs/SPEC-data-layer.md` - boundary updates.
- `site/scripts/sync-docs.mjs` and generated `site/src/content/docs/*` - website docs.
- `site/src/pages/index.astro` - homepage copy if semantic memory becomes a named
  public capability.
- `README.md` and package READMEs - release truth and quickstart
  surfaces.
- `packages/create-vivary/create_vivary.py` - `--memory`, capability discovery JSON,
  `knowledge-work` preset, wizard choices, scaffold writes, stale cleanup, and doctor
  reporting.
- `packages/create-vivary/tests/test_create_vivary.py` and
  `packages/create-vivary/tests/test_assets_parity.py` - scaffold/doctor/parity tests.
- `packages/create-vivary/README.md`, `packages/create-vivary/npm/README.md`, and
  npm package metadata - install examples for optional storage and memory capability
  selection.
- `packages/memory-cognee/` - optional Cognee adapter package and fake-provider
  tests.
- `packages/tropo/` - only for shared typed-node export helpers if the memory layer
  needs a stable graph snapshot API; do not put Cognee imports in tropo.
- `.github/workflows/ci.yml` - only if new package tests or extras need CI coverage.
- `CHANGELOG.md` - when behavior, packages, or public install flow actually change.
- `docs/RELEASE-WORKFLOW.md` - only if the release checklist itself changes.

## Tests

Tests for the setup slice and future provider code:

- Adapter tests: `CogneeMemoryAdapter` resolves the workspace and builds its own
  privacy-filtered snapshot for `index` and `recall`; `forget` is approved
  whole-dataset removal and `doctor` remains module-level and provider-free.
- Contract tests: recall hits include `node_id`, nullable `type`, `path`, `score`,
  `reason`, the Cognee adapter's fixed `source = "provider"` label, `provider`, and
  edge context.
- Privacy regression tests: `USER.md`, `MEMORY.md`, `memory/**`,
  `heartbeat-reports/**`, `.strato/private/**`, and configured ignored paths are
  filtered before indexing and never recalled.
- Doctor tests for absent config, disabled config, a non-Cognee provider
  (`not-cognee`), missing Cognee dependency, invalid config, stale index, and privacy
  failure.
- Scaffold tests: default `second-brain` creates no semantic memory dependency and
  no enabled provider.
- Wizard/agent-mode tests: `--auto` never selects Cognee; explicit Cognee choice writes
  disabled/approval-gated policy and does not install or index.
- Config tests: `.vivary/memory.toml` rejects secrets committed as literals and uses
  env var references for API keys.
- No-network default test: all core suites pass without Cognee installed and without
  external API keys.
- Capability discovery tests: agent-mode JSON lists optional storage, local memory,
  and Cognee choices with install requirements, default state, network state, and
  approval gates.
- Preset tests: `second-brain`, `knowledge-work`, and `writing` can all scaffold with
  memory disabled, local memory configured, and Cognee policy configured without
  installing or indexing by default.
- Install-flow tests: explicit local database/search install remains separate from
  semantic memory; explicit Cognee selection does not imply cloud/network/indexing.
- Complementarity tests: semantic hits for deleted/unknown node ids are ignored as
  stale; graph edges win when they conflict with provider ranking.
- Release-surface tests/checks: docs sync, site build, npm dry-run, PyPI package
  metadata, and version/changelog consistency when the implementation changes public
  install behavior.

## Release and install rollout checklist

When this becomes implementation work, treat it as a behavior and public-copy change:

1. Cut a feature branch from `dev`.
2. Write the tests above before provider code.
3. Implement or maintain semantic adapters around the workspace-root and
   adapter-built-snapshot seam. The first Cognee adapter slice is in
   `packages/memory-cognee/`.
4. Add capability discovery so human and agent flows can see optional database,
   local-memory, and Cognee choices before installing anything.
5. Add optional Cognee adapter only behind an explicit extra/package.
6. Add or update `second-brain`, `knowledge-work`, and `writing` preset flows so each
   can opt into memory capabilities without making them defaults.
7. Update `create-vivary init`, wizard, `doctor`, JSON output, and package README
   install examples.
8. Update root docs, website docs, homepage copy if named publicly, and
   `CHANGELOG.md`. Keep private handoffs and agent-to-user continuity notes outside
   the public repo.
9. Run `cd site && npm run sync-docs && npm run build`.
10. Run all Python suites, assets parity, `git diff --check`, and package dry-runs.
11. Stop for explicit human approval before push, PR, merge, PyPI publish, npm publish,
   GitHub release, or launch copy.
12. After publish approval, verify the new package versions from public npm/PyPI and
    record exact smoke commands in the release truth.

## Open questions

- Whether a future `strato` package should wrap `vivary-memory-cognee` or keep the
  adapter package separate.
- Whether local Vivary semantic recall should be implemented before Cognee using this
  adapter seam, without a third-party dependency.
- Whether adapters beyond Cognee must use the current fingerprint and manifest
  algorithm.
- When the scaffold will be brought into conformance with the approved
  disabled-policy contract.
