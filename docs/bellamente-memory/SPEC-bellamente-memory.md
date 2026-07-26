# SPEC: Bellamente AgentLTM beside tropo

**Status:** normative predecessor contract for future implementation. It is
intentionally ahead of [#190](https://github.com/vivary-dev/vivary/pull/190):
[#217](https://github.com/vivary-dev/vivary/issues/217) makes this specification
authoritative if implementation and contract differ.

## 1. Scope and decision

Bellamente is an optional **AgentLTM**, not a semantic-memory provider and not a
source of authored graph truth. If a human enables it, it holds durable
agent-usable assertions with provenance in its own workspace-local store. `tropo`
remains the typed source of project truth.

This specification does not claim that a Bellamente bridge, policy parser, capability
record, Doctor section, MCP activation flow, or public command exists today. It fixes
the requirements for those future surfaces.

## 2. The three seams

| Seam | Owns | Does not own |
|---|---|---|
| **SemanticMemoryAdapter** | Privacy-filtered projection and retrieval over typed `tropo` nodes; local/Cognee `RecallHit` results. | Durable independent agent memory or canonical truth. |
| **AgentLTM** | Bellamente's separately stored, approved agent memory and provenance. | A `tropo` projection, a semantic-provider slot, or automatic truth promotion. |
| **CandidateRecallProvider** | Optional normalized prior assertions supplied to the `vivary-core` candidate firewall. | `RecallHit` adaptation, privacy filtering for a semantic adapter, or mutation authority. |

The existing semantic `RecallHit` adapter protocol does not directly model AgentLTM.
Any AgentLTM information that crosses into Vivary must first become a normalized
`CandidateRecallProvider` assertion, then pass through the core firewall. A future
bridge may implement that boundary; package placement is deliberately undecided.

## 3. Default policy, storage, and privacy

### 3.1 Disabled by default

The default is **none**. A future scaffold or adopt integration may add only disabled
policy, inert setup documentation, and the `.bellamente/` runtime-data ignore entry.
It must not install software, activate AgentLTM, create a live data store, enable MCP,
generate an `AGENTS.md` section, or write/correct/forget/ingest memory.

The required future policy shape is separate from semantic-memory configuration. A
dedicated policy file may use this shape; it is **not** a currently supported config
surface:

```toml
# .vivary/agent-ltm.toml
[agent-ltm]
enabled = false
implementation = "bellamente"
data_path = ".bellamente/data/"

[agent-ltm.privacy]
private_paths = [
  "USER.md",
  "MEMORY.md",
  "memory/**",
  "heartbeat-reports/**",
  ".strato/private/**",
]
fail_closed = true
```

`[agent-ltm]` is never `[memory]`. In particular, future work must not occupy the
semantic `[memory].provider` slot with Bellamente. On a clean scaffold the policy is
created disabled. Adopt may create the absent dedicated policy file, but must leave an
existing file unchanged and never turn it on.

### 3.2 Independent physical store

When enabled after approval, AgentLTM data is workspace-local at
`.bellamente/data/` and ignored as runtime data. It must not share, alias, or fall
back to a physical store used by `tropo`, a SemanticMemoryAdapter, or `vivary-core`.
Only normalized IDs and evidence references may cross a seam. A disabled policy
reserves the path; it does not create or populate it.

### 3.3 Fail-closed private set

The following paths are private without exception:

- `USER.md`
- `MEMORY.md`
- `memory/**`
- `heartbeat-reports/**`
- `.strato/private/**`

Privacy is enforced before indexing, embedding, exporting, caching, recall, ingest,
or AgentLTM writes. SemanticMemoryAdapter implementations own that filtering for
semantic data. A future AgentLTM bridge must also withhold these sources from writes
and candidate emission. The core firewall is not a privacy adapter; it receives only
privacy-approved normalized assertions and rejects inadequate provenance rather than
trying to recover hidden data.

## 4. Explicit human gates

No earlier approval authorizes a later action. Each row is a separate human decision.

| Action | Required gate | Automatic behavior that is forbidden |
|---|---|---|
| Scaffold or adopt | User chose the optional policy surface. | Write disabled policy, inert guidance, and the `.bellamente/` runtime-data ignore entry; do not enable AgentLTM, install externally, invoke a provider, create the store, or mutate memory. |
| External installation | Explicit human approval. | Installer-managed installation or executable probing. |
| Policy activation | Explicit human approval to change `enabled` from `false`. | Activation implied by a preset, capability listing, or data path. |
| MCP enablement | Explicit human approval distinct from activation. | Writing or enabling an active MCP server configuration. |
| Write, correct, forget, or ingest | Explicit human approval for that operation. | A standing enablement flag authorizing later mutations. |
| Live proof | Explicit release/dogfood approval. | Installer verification or a unit-test replacement. |

The only MCP-related scaffold output may be inert instructions explaining that a
manual, separately approved decision is needed. It must not create active runtime
configuration.

## 5. Capability and Doctor requirements

When a Bellamente capability record is added to the existing capability report, it
must be optional, default `false`, and require approval. It must declare:

```text
requires_external_executable: ["bella"]
```

This is declarative metadata, not an installation requirement. It must not be placed
in a Python import requirement, trigger PATH lookup, import a module, or execute
`bella`.

The capability report always emits `installed`; the Bellamente capability record must
set it to `false` because capability discovery does not inspect the external
executable. A separately approved future runtime diagnostic may report external
readiness under a differently named field. `installed` must never imply that `bella`
is present or usable.

A future Doctor section is similarly declarative. It may parse AgentLTM policy,
validate the fail-closed private set, and report namespaced states:
`agent-ltm-disabled`, `agent-ltm-policy-present`, `agent-ltm-privacy-failed`, or
`agent-ltm-misconfigured`. It never locates, probes, imports, or calls `bella`.
Absent optional external runtime must not make a normal Vivary workspace broken.

Until that future wiring exists, use only current public commands:

```bash
create-vivary capabilities --json
create-vivary doctor <target> --json
```

## 6. CandidateRecallProvider contract

### 6.1 Normalized input boundary

A `CandidateRecallProvider` is an optional source of **prior assertions** for the
core firewall, not a direct authority to write. Before the firewall evaluates a
Bellamente candidate, normalization must supply at least:

- a known stable `tropo` subject node ID, never only a Bellamente record ID;
- a normalized assertion identity: subject, predicate, value, project/visibility
  scope, authority class, and relevant observation time;
- typed evidence and provenance for every assertion, including a stable fingerprint;
- any explicit correction target and authorization context; and
- provider freshness or degradation state.

Failure to resolve the stable node ID is an identity ambiguity, not permission to
invent a node. Missing fingerprinted evidence is rejected fail-closed with the frozen
v0 reason code `evidence_not_fingerprinted`. Bellamente candidates must map to typed
evidence and known stable `tropo` node IDs before core evaluation.

### 6.2 Required distinct results

The provider result and firewall decision must preserve these conditions as distinct,
observable outcomes required by [#205](https://github.com/vivary-dev/vivary/issues/205):

| Condition | Required result | Truth and mutation rule |
|---|---|---|
| Exact duplicate with the same evidence | `exact_duplicate` / preserve. | No new assertion or hidden rewrite. |
| Compatible assertion with independent evidence | `corroboration`. | Evidence may be proposed or linked only after its operation-specific approval; it is not authored-truth promotion. |
| Explicit correction of a named assertion | `explicit_correction` proposal. | Creation or supersession requires the named target, evidence, authorization, and separate human approval. |
| Unknown or ambiguous identity | `review_required` with `identity_unresolved`. | Preserve all available sides; create nothing automatically. |
| Incompatible value for the same identity | `review_required` with `value_conflict`. | Preserve both assertions; never elect a winner from similarity. |
| Stale candidate, node, or evidence | `stale`. | Do not promote or mutate until revalidated. |
| Missing, malformed, or failed optional provider | `provider_degraded`. | Keep degradation visible; do not silently bypass authority checks or mutate. |

Every result must carry a core decision (`accepted`, `review_required`, or `rejected`)
in addition to its condition label. That decision is not a write. It must make create,
supersede, preserve, and explicit-correction semantics testable. In every case,
learned memory cannot automatically replace authored truth.

## 7. Verification tiers

| Tier | What it proves | What it must not do |
|---|---|---|
| Contract tests | Normalization requires stable node IDs and fingerprinted evidence; duplicate, corroboration, correction, identity/conflict, stale, and degraded paths are distinct. | Use Bellamente, create stores, or mutate a workspace. |
| Scaffold/capability/Doctor tests | Default-disabled policy, exact private set, separate AgentLTM namespace, inert MCP guidance, and declarative capability/Doctor behavior. | Probe or execute the external executable, install a provider, enable MCP, or perform memory operations. |
| Release dogfood | A human-approved real write → recall → trace on the intended external runtime. | Run as installer behavior or a unit test. |

## 8. Non-goals and implementation handoff

This contract does not add a default memory capability, a shared store, automatic
installation, active MCP configuration, generated agent instructions, or a live
provider call. It does not decide bridge package placement, the UI for per-operation
approval, the trace format, or the exact execution method for release dogfood. Those
implementation details may vary only if they preserve every boundary and gate above.

Future implementation work is governed by this specification and by:

- [ADR-0001 — three-seam boundary](ADR-0001-bellamente-agent-ltm-beside-tropo.md)
- [Bellamente context — canonical vocabulary](CONTEXT.md)
- [#205 — governed candidate recall](https://github.com/vivary-dev/vivary/issues/205)
- [#207 — capability and Doctor wiring](https://github.com/vivary-dev/vivary/issues/207)
- [#217 — spec precedes implementation](https://github.com/vivary-dev/vivary/issues/217)
- [Vivary architecture / `vivary-core`](../ARCHITECTURE.md)
- [Optional semantic-memory adapter contract](../SEMANTIC-MEMORY.md)
- [Public command contract](../COMMANDS.md)

When these documents differ, this specification controls behavior, the ADR fixes the
architectural boundary, and `CONTEXT.md` fixes vocabulary.
