# vivary-core

The governed-context shared seam Vivary role packages use:

- **`canonical`** — canonical JSON serialization, sha256 fingerprints, deterministic
  IDs, and the public UTF-16 ordering key used by role adapters. Same input, same bytes,
  on every machine and runtime.
- **`event_contract`** — the frozen **ContextIntegrityEvent v0** envelope:
  pure construction, machine-readable validation (pinned reason codes), an
  append-only project-scoped event log that fails closed on cross-project and
  private-to-public writes, and a rebuildable projection with a pinned
  fingerprint.
- **`receipt`** — integrity receipts: what actually ran, bound to the exact
  capsule and workspace fingerprint it ran against. Core owns and exports the exact
  top-level capsule and receipt field sets; complete policy artifacts reject additions
  as well as omissions. Construction refuses incomplete bindings or an invalid runtime
  actor. A receipt never declares success beyond its checks; provenance references are
  labeled provenance only, never proof of correctness.
- **`evidence_store`** — an append-only JSONL evidence store under
  `.vivary/evidence/` with replay-on-open idempotency and typed, fail-closed
  corruption errors.
- **`evidence_sync`** — snapshots the evidence directory onto
  `refs/vivary/evidence` as an append-only commit chain via pure git
  plumbing; push-first-then-advance so a rejected sync is inert, never
  forced, failing closed on divergence.
- **`capsule_digest`** — a pure, fingerprint-bound serializer producing a
  compact digest of a Task Capsule with nothing dropped: conflicts and
  unknowns byte-verbatim, every omission recorded.
- **`workspace_observe`** — read-only checkout observation: explicit
  allowlisted roots only; ambient Git injection sanitized without discarding
  Git-parsed worktree EOL or explicit host ignore policy; bare repositories
  positively confirmed; symlink/junction escapes re-checked post-resolution
  and refused. Never fetches, never writes, never crawls.
- **`workspace_model`** — pure projection of observations into a typed
  evidence graph; divergent checkouts become explicit unresolved conflicts
  with both sides and their evidence preserved — never auto-resolved.
  Known fact values must match their fact-specific semantic type, and unknown facts
  require a reason. Known dirty-entry paths must be normalized, safe
  checkout-relative paths. Repair graphs retain a nonempty traversal-free canonical
  allowlist. Checkout, worktree-root, and Git-common-dir paths are canonical absolute;
  duplicate persisted checkout identities fail closed. The workspace fingerprint
  commits each emitted checkout's path, effective worktree root, semantic fact status
  and value, and normalized observation refusals. Evidence command text does not enter
  that identity. Persisted drive and UNC path identities compare case-insensitively on
  every verifier host.
- **`workspace_content`** — bounded, read-only `git grep` search over each checkout's
  named HEAD commit tree, with every truncation recorded. Duplicate checkout identities
  are observed once; noncanonical accepted roots are refused before Git access.
- **`capsule_compile` / `capsule_select`** — the bounded Task Capsule:
  relevance-ranked, explainable claim selection with fail-closed structured filters.
  Declared scope roots are absolute, traversal-free, and cardinality-bounded; blank
  filter values fail at the compiler boundary. Checkout/content-candidate counts,
  source-path containment and prefix construction, and
  candidate-by-question-term-and-filter scalar work have fixed ceilings.
  Complete claims retain their compiler-derived identity, subject path, fact, text,
  `known` status, evidence,
  and selection explanation. Complete conflicts retain their repository, question,
  review decision, reason codes, and at least two checkout/path sides. Scoped
  compilation reconstructs every compiler-owned omission, including conflicts that
  cross the declared boundary. Content-match narration accepts only normalized
  checkout-relative paths and ranks source records in canonical path/line/term order.
  Complete, meaningful `vivary.workspace-content/v0` observations require a
  timezone-aware timestamp, a nonempty traversal-free absolute allowlist, uniquely
  identified contained checkouts and matches, and reason-consistent refusals.
  Nonempty-term searches require both the named revision actually searched and the
  effective ignore-policy fingerprint shared with the workspace graph; the capsule
  commits the source fingerprint. Malformed, field-smuggled, partial, or
  work-unbounded sources fail closed.
  A complete observation with no checkouts or refusals is semantically empty and keeps
  absent-content capsule bytes. Graph-context verification requires the exact
  meaningful observation and reconstructs the complete capsule from it.
  Derived checks bind checkout-scoped identities, execution workspaces, and exact
  observation evidence. A repair-topology
  fingerprint commits checkout IDs and paths, repository nodes, and `checkout_of`
  relationships.
  Malformed topology identifiers, graph nodes, or facts are rejected rather than
  partially compiled. Every budget cut is a recorded omission.
- **`collation`** — JS `localeCompare` ordering (claim/node/edge ranking is
  part of the frozen contract), pinned as an empirical weight table
  extracted from the reference runtime and verified on ~2.1M probe pairs;
  characters outside the pinned domain fail loud rather than silently
  diverging.
- **`policy_*`** (Strato) — budgets, capsule/receipt gates, and the loop
  step, all fail-closed with pinned reason codes; malformed configured budget
  scalars exhaust the affected dimension, while omission alone means unbounded.
  Receipt integrity is independently rechecked before a gate can clear. Bound,
  fingerprinted Ozone verdicts add evidence but never waive receipt evidence.
- **`verify_*`** (Ozone) — receipt-integrity verdicts (fingerprint and
  deterministic-identifier recomputation for tamper detection), gate
  sufficiency, and bounded context-repair proposals as pure dry-run JSON.
  Capsule identity and workspace bindings are mandatory, and optional null
  gate constraints remain absent constraints. Every proposed write is named
  and carries `requires_gate`. Duplicate check names preserve their worst
  recorded outcome.
  Graph-backed verification reconstructs compiler selection from the supplied graph.
  Added, removed, or rewritten graph claims fail closed. Capsules with content-derived
  claims, unknowns, or omissions require an exact fingerprinted content observation;
  removing that binding cannot downgrade them to capsule-attested content. Core
  recompiles the complete capsule, so content-derived records cannot be deleted or
  rewritten. Selection omissions cannot understate the graph-reconstructable minimum
  and match exactly when their counts equal it. Unknown or reshaped omission variants
  fail closed.
  Repair graphs are reprojected from checkout paths, facts, and normalized refusals;
  every derived node, edge, conflict, unknown, omission, deterministic ID, evidence
  field, canonical allowlist, and workspace fingerprint must match. Invalid fact
  statuses or semantic values fail closed. Explicit task-required checks use unique
  nonblank names, remain visible in the capsule even without a graph, and bind to an
  observed Git checkout execution root related to task scope. They add to rather than
  replace evidence-derived checks and resolve undetermined-check unknowns only for that
  checkout. Graphless verification requires the capsule's effective check list to equal
  the task declaration exactly.
- **`control_*`** (Exo) — Core-owned lifecycle decisions over caller-owned values.
  Claims, leases, dependency cycles, handoffs, execution evidence, and task views use
  typed projections that do not mutate the supplied ledger or log. See
  [Governed Exo control](#governed-exo-control).
- **`recall_*`** (Bellamente) — bounded candidate classification and caller-owned
  recall transitions. [SPEC §6.2](https://github.com/vivary-dev/vivary/blob/dev/docs/bellamente-memory/SPEC-bellamente-memory.md#62-required-distinct-results)
  owns the decisions, conditions, and truth/mutation rules. Core never rewrites
  authored truth.

## Governed Exo control

`vivary_core.control` is the public Core lifecycle surface. Its clean-cutover
interfaces and typed projections replace earlier standalone control signatures. Exo
adapts this surface. It does not define a second lifecycle model.

- An actor is exactly `{kind, id}`. Core validates both the actor kind and authority
  class. Only a human actor can hold owner-class authority.
- A claim request is exactly `{scope, actor, now, authority_class?, lease?}`. `now`
  is required. A lease is live only when `granted_at <= now < expires_at`, and a
  persisted claim must have been created within that interval. The claim ID binds the
  normalized scope, exact actor, authority class, lease, and creation time. Caller
  ledgers must contain unique, recomputable active claims with pairwise-disjoint scopes.
  Malformed, duplicate, or overlapping entries fail closed. A projection beyond
  10,000 active claims or 10,000 total scope paths returns `claim_work_unbounded`.
  Expired entries remain until the caller explicitly projects them through
  `expire_leases`.
- Dependency evaluation returns one decision with unmet dependencies or an integrated
  cycle result. It does not leave cycle detection to an adapter.
- A handoff reads a live caller ledger and records evidence. It never transfers or
  changes a claim. It binds the exact holder, sender, recipient, scope, timestamps,
  workspace revision, complete capsule, and authorized receipt. The receipt runtime
  actor must be the holder. Its creation time cannot predate the claim or lease or
  follow the handoff.
- `record_execution` derives edges only from an exact capsule and its authorized
  receipt, then returns `{edges, added, reason_codes}`. Exact replays add nothing.
  The same edge ID with different evidence refuses without changing the log. Logs or
  receipts exceeding 10,000 evidence edges fail closed before derivation.
- Completion changes only a task's control status. `task_integrity_view` always returns
  failed execution evidence for the task's capsule.

The [Exo command reference](../../docs/COMMANDS.md#governed-control-development-source)
owns the request-file envelope and CLI exit behavior.

## Governed recall firewall

`vivary_core.recall` is the public Core surface. It exports the bounded classifier,
provider firewall, transition projector, and their pinned constants.

- Classification requires normalized fingerprinted evidence. Resolved candidates and
  recalled assertions must reference known graph node IDs. Unresolved identity remains
  explicit and review-required.
- Preflight is iterative and cycle-safe. It caps depth at 64, each collection at
  10,000 values, and each UTF-8 string at 1 MiB. Aggregate caps are 16 MiB of UTF-8
  data and 100,000 values. Provider and classification failures remain visible as
  `provider_degraded`.
- Integer inputs must stay within JavaScript's lossless canonical range before they can
  participate in deterministic assertion or proposal identity.
- `preserve` is read-only and ungated. `create` applies only to a novel accepted
  candidate. `supersede` applies only to an explicit correction of a named assertion.
- A permitted write first returns a deterministic proposal. Core applies it only with
  an exact proposal-bound human approval. Applied records use learned authority and
  retain the proposal, operation, and approving actor as transition provenance.
- The caller owns and persists the assertion ledger. Core appends superseding records
  and references without rewriting history. Exact replay adds nothing. Identity or
  approval-provenance conflicts refuse without changing the ledger.
- Core validates the full append-only ledger, including freshness. It then classifies
  against only assertions relevant to the candidate or its named correction target.
  Unrelated stale history remains preserved without blocking new transitions.
- Ledgers and projections cap at 10,000 assertions. Invalid or over-budget state
  refuses atomically.

Core adds no provider, network call, store, workspace policy, or clock. Bellamente
remains independently installable and disabled by default.


Zero runtime dependencies. Python 3.11+.

This package is unpublished development source. [The root release status](../../README.md#release-status)
owns version and publication truth.

## Provenance and proof

Core uses reference fixtures to test named frozen contracts. Byte-exact assertions
apply to the ContextIntegrityEvent v0 conformance and replay fixtures, evidence-store
JSONL bytes and Git object SHAs, and captured capsule-digest and receipt bytes.
`control_*` is a Vivary-owned contract. It makes no Agent Relay compatibility or
byte-parity claim.

**ADAPTATION — CandidateRecallProvider:** [the Bellamente memory SPEC](../../docs/bellamente-memory/SPEC-bellamente-memory.md#62-required-distinct-results)
owns firewall-result truth and intentionally supersedes the frozen Node
vocabulary here. `accepted` is evaluation rather than write permission;
explicit corrections remain review-required, human-gated proposals; and stale,
degraded, or unfingerprinted inputs reject fail-closed. The cross-language
parity harness lives with the reference implementation; its frozen fixtures
travel here (`tests/fixtures/`) so this package's own test suite re-verifies
the remaining contract bytes on every run.

## Tests

```sh
pip install pytest
python -m pytest packages/core/tests/ -q
```

The current platform-specific proof is **771 tests on Windows**. On Linux, it is
**770 passed plus 1 skip**. The suite translates the reference contracts across
observation, capsules, receipts, the Strato/Ozone/Exo/Bellamente role-policy surfaces,
corruption handling, real-git evidence-store round trips, and byte-exact cross-runtime
fixtures.
