---
title: "Optional semantic memory"
description: "Architecture and adapter plan for optional semantic memory providers such as Cognee."
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

Semantic memory is a `strato` retrieval sidecar over a `tropo` graph snapshot. It
consumes typed nodes and edges, then returns typed Vivary node candidates. It never
owns canonical content.

```text
files + frontmatter
        |
        v
tropo typed graph  -->  tropo query / graph / blast / check
        |
        | privacy-filtered typed nodes + edges
        v
MemoryProvider / RecallProvider
        |
        v
typed RecallHit candidates  -->  strato retrieve step  -->  agent reads source files
```

The provider may keep an index, embeddings, graph projections, or provider-specific
state, but that state is rebuildable from the typed graph plus approved source files.
If provider state and source files disagree, source files plus `tropo` win.

## Minimal interface

The first implementation should keep indexing and recall separate enough that a
workspace can disable writes while still reporting health.

```python
from dataclasses import dataclass
from typing import Literal, Protocol

@dataclass(frozen=True)
class MemoryNode:
    id: str
    type: str
    path: str
    title: str
    text: str
    fields: dict

@dataclass(frozen=True)
class MemoryEdge:
    source_id: str
    field: str
    target_id: str

@dataclass(frozen=True)
class RecallHit:
    node_id: str
    type: str
    path: str
    score: float
    reason: str
    source: Literal["tropo", "semantic", "provider"]
    edge_context: list[MemoryEdge]
    provider: str

class RecallProvider(Protocol):
    name: str

    def doctor(self) -> dict: ...
    def recall(
        self,
        query: str,
        *,
        k: int = 10,
        filters: dict | None = None,
    ) -> list[RecallHit]: ...

class MemoryProvider(RecallProvider, Protocol):
    def index(
        self,
        *,
        nodes: list[MemoryNode],
        edges: list[MemoryEdge],
        dry_run: bool = False,
    ) -> dict: ...

    def forget(self, node_ids: list[str]) -> dict: ...
```

Minimum contract:

- `index` receives only privacy-approved typed nodes and typed edges.
- `recall` returns node ids, types, paths, scores, reason text, and edge context, not
  opaque chunks.
- `forget` removes provider state for deleted or newly private nodes.
- `doctor` reports disabled, unavailable, healthy, stale, or misconfigured without
  breaking a core Vivary workspace.
- Providers must be optional imports. Missing extras produce helpful status, not an
  import-time failure.

## Cognee provider

Cognee plugs in as an adapter behind the provider interface through a separate
optional package:

- `vivary-memory-cognee`

Future packaging options may still include:

- `vivary-strato[cognee]` if `strato` later becomes packaged code
- `create-vivary[cognee]` only if the scaffolder owns provider setup, not core runtime

The adapter maps:

| Vivary | Cognee adapter responsibility |
|---|---|
| typed node | approved memory item with stable Vivary node id |
| typed edge | relationship/context metadata preserved during recall |
| privacy ignore result | hard pre-index filter |
| `tropo graph` snapshot | rebuildable provider input |
| `RecallHit` | typed Vivary node candidate for `strato` to inspect |
| provider state | cache/index only, safe to delete and rebuild |

Cognee-specific details stay behind the adapter: package imports, initialization,
LLM/embedding model settings, data directories, optional server/UI usage, and any
remote/API key configuration. The default Vivary install should not import Cognee or
run a Cognee doctor.

Including a Cognee layer "in Vivary" means the monorepo owns an optional adapter,
tests, docs, and install flow. It does not mean Cognee becomes a dependency of the
core packages or the default preset output.

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

Cognee-policy example:

```toml
# .vivary/memory.toml
# Optional semantic memory. Default scaffold may omit this file or write disabled
# policy only. Provider state is rebuildable cache, not source truth.

[memory]
enabled = true
mode = "semantic-provider"
provider = "cognee"   # vivary-local | cognee

[memory.privacy]
respect_gitignore = true
respect_vivary_private = true
private_paths = ["USER.md", "MEMORY.md", "memory/**", "heartbeat-reports/**"]
fail_closed = true

[memory.cognee]
state_path = ".vivary/memory/cognee"
require_explicit_index = true
allow_network = false
api_key_env = ""
allow_without_api_key = false
allow_telemetry = false
```

Runtime/index state belongs under `.vivary/memory/` and should be ignored. The adapter
binds Cognee's data, system, cache, and log roots to the configured `state_path`
before importing Cognee, so provider side effects stay in the workspace cache instead
of user-home or package directories. The policy file can be committed if it contains
no secrets. API keys and hosted endpoints should use environment variables.

`allow_network = false` is an enforced default. `vivary-cognee doctor` and
`vivary-cognee index --dry-run` can still prove package readiness and packet counts,
but provider writes/recalls/forgets require `allow_network = true`; they also require
either a populated `api_key_env` whose environment variable exists, or the explicit
local-provider escape hatch `allow_without_api_key = true`. Cognee telemetry is
disabled by default through `allow_telemetry = false`; setting it to `true` is an
explicit third-party telemetry opt-in.

Provider recall is graph-fingerprint gated: if the manifest is missing or stale, recall
refuses and asks for `vivary-cognee index --yes`. Approved index replaces the prior
dataset before remembering current node packets, and `forget --yes` requests dataset
deletion rather than a memory-only reset.

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

`create-vivary doctor` includes a semantic memory section without requiring any
provider dependency.

Recommended states:

| State | Meaning |
|---|---|
| `disabled` | no `.vivary/memory.toml`, or `[memory].enabled = false` |
| `enabled` | provider configured and policy says semantic recall can run |
| `healthy` | provider import/config works and privacy probe passes |
| `unavailable` | optional provider dependency is not installed |
| `misconfigured` | invalid provider, missing required fields, secret literal in config, or forbidden network mode |
| `stale` | provider index exists but graph fingerprint or indexed node count is outdated |
| `privacy-failed` | ignored/private probe path would be indexed or recalled |

Doctor checks:

- Parse `.vivary/memory.toml` if present.
- Report disabled cleanly when absent or disabled.
- Validate provider name and mode combinations.
- Confirm private paths are actively excluded before provider calls.
- Use a fake private probe node to prove provider recall cannot return it.
- Confirm optional Cognee dependency status only when Cognee is configured.
- Return JSON that agents can gate on, for example:

```json
{
  "memory": {
    "enabled": false,
    "provider": "none",
    "status": "disabled",
    "privacy": "not-indexed"
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

Conflict rules:

- If semantic recall returns a node id that `tropo graph` does not know, mark it stale
  and ignore it.
- If semantic recall suggests content from a private/ignored path, treat it as a
  privacy failure and stop.
- If semantic score and graph edges disagree, prefer graph edges for truth and use the
  semantic hit as a lead to inspect.
- `tropo query --mode semantic` shares this provider contract. It calls the configured
  optional semantic-memory provider and returns typed Vivary node ids, not opaque
  chunks. It must stay unavailable until the user has explicitly configured, installed,
  and indexed a supported provider.

## Implementation files

Files touched by the setup slice and likely files for the Cognee adapter PR:

- `docs/SEMANTIC-MEMORY.md` - this architecture and setup note.
- `docs/COMMANDS.md`, `docs/GETTING-STARTED.md`, `docs/HOWTO.md`, `docs/FAQ.md` -
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

- Fake provider unit tests: `index`, `recall`, `forget`, and `doctor` behavior with
  typed nodes and edges.
- Contract tests: recall hits must include `node_id`, `type`, `path`, `score`,
  `reason`, `provider`, and edge context.
- Privacy regression tests: `USER.md`, `MEMORY.md`, `memory/**`,
  `heartbeat-reports/**`, and configured ignored paths are filtered before indexing
  and never recalled.
- Doctor tests for absent config, disabled config, enabled local provider, missing
  Cognee dependency, invalid config, stale index, and privacy failure.
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
3. Implement the provider abstraction with a fake provider first. Done for the first
   Cognee adapter slice in `packages/memory-cognee/`.
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
- Whether local Vivary semantic recall should be implemented before Cognee so the
  provider interface is proven without a third-party dependency.
- Whether #20's eventual `tropo query --mode semantic` should call this provider layer
  directly or stay a separate typed-node embedding path with the same result contract.
- Exact graph fingerprint/staleness algorithm for provider indexes.
- Whether `.vivary/memory.toml` is written by default as disabled policy or only
  written when the user opts into memory configuration.
