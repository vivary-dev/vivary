# vivary-core

The governed-context shared seam every Vivary role package will speak through:

- **`canonical`** — canonical JSON serialization, sha256 fingerprints, and
  deterministic IDs. Same input, same bytes, on every machine and runtime.
- **`event_contract`** — the frozen **ContextIntegrityEvent v0** envelope:
  pure construction, machine-readable validation (pinned reason codes), an
  append-only project-scoped event log that fails closed on cross-project and
  private-to-public writes, and a rebuildable projection with a pinned
  fingerprint.
- **`receipt`** — integrity receipts: what actually ran, bound to the exact
  capsule and workspace fingerprint it ran against. Construction refuses
  incomplete bindings or an invalid runtime actor. A receipt never declares
  success beyond its checks; provenance references are labeled provenance
  only, never proof of correctness.
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
  The workspace fingerprint commits each emitted checkout's path, effective worktree
  root, and core facts. Repeated observations that collapse to one checkout identity
  cannot create an unverifiable commitment.
- **`workspace_content`** — bounded, read-only `git grep` content search
  over tracked files only, every truncation recorded.
- **`capsule_compile` / `capsule_select`** — the bounded Task Capsule:
  relevance-ranked, explainable claim selection with fail-closed structured filters.
  Complete claims retain their compiler-derived identity, subject path, fact, text,
  status, evidence, and selection explanation. Complete conflicts retain their
  repository, question, review decision, reason codes, and at least two checkout/path
  sides. Derived checks bind checkout-scoped identities, execution workspaces, and exact
  observation evidence. A repair-topology fingerprint commits checkout IDs and paths,
  repository nodes, and `checkout_of` relationships. Malformed topology identifiers,
  graph nodes, or facts are rejected rather than partially compiled. Every budget cut is
  a recorded omission.
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
  Graph-backed verification reconstructs compiler selection from the supplied graph
  and retained content-match candidates. At a fixed budget and retained content set,
  added, removed, or rewritten graph claims fail closed. Repair graphs are reprojected
  from checkout paths and facts; every derived node, edge, conflict, unknown, omission,
  deterministic ID, evidence field, and workspace fingerprint must match.
  Explicit task-required checks remain visible in the capsule, bind to an observed Git
  checkout execution root related to task scope, and add to rather than replace
  evidence-derived checks. They resolve undetermined-check unknowns only for that
  checkout. Otherwise, graph-derived checks and undetermined-check unknowns are
  re-derived during verification.
- **`control_*`** (Exo) — claims, leases, handoffs, dependency cycles,
  execution evidence, and task views over caller-owned state; one active claim
  per scope, including equivalent Win32 device-path spellings. Malformed leases
  cannot hold a scope forever, receipt integrity is rechecked before handoffs
  or execution edges are created, and completing a task cannot erase a failed
  verification edge.
- **`recall_*`** (Bellamente) — an evaluation-only candidate-recall firewall.
  [SPEC §6.2](https://github.com/vivary-dev/vivary/blob/dev/docs/bellamente-memory/SPEC-bellamente-memory.md#62-required-distinct-results)
  owns its decisions, conditions, and truth/mutation rules; it never rewrites
  authored truth.

Zero runtime dependencies. Python 3.11+.

This package remains unpublished until the coordinated release train. See the
[release workflow](https://github.com/vivary-dev/vivary/blob/dev/docs/RELEASE-WORKFLOW.md#2-set-release-truth-first) for
version ownership.

## Provenance and proof

This package is a **reference-guided port** of a proven Node.js
implementation developed and hardened in The Little AI Company's
governed-context research program (adversarially reviewed, benchmarked on real
workspaces). Frozen JSON contracts remain byte-identical
where their owning authority is unchanged: the ContextIntegrityEvent v0
conformance and replay fixtures (including the pinned projection fingerprint),
evidence-store JSONL bytes and git object SHAs, and capsule digest and receipt
bytes over captured real-pipeline capsules.

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

The current platform-specific proof is **645 tests on Windows**. On Linux, it is
**643 passed plus 2 skips**. The suite translates the reference contracts across observation,
capsules, receipts, the Strato/Ozone/Exo/Bellamente role-policy surfaces, corruption
handling, real-git evidence-store round trips, and byte-exact cross-runtime fixtures.
