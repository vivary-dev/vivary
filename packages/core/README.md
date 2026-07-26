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
  capsule and workspace fingerprint it ran against. A receipt never declares
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
  allowlisted roots only, ambient-git-env sanitized, bare repositories
  positively confirmed, symlink/junction escapes re-checked post-resolution
  and refused. Never fetches, never writes, never crawls.
- **`workspace_model`** — pure projection of observations into a typed
  evidence graph; divergent checkouts become explicit unresolved conflicts
  with both sides and their evidence preserved — never auto-resolved.
- **`workspace_content`** — bounded, read-only `git grep` content search
  over tracked files only, every truncation recorded.
- **`capsule_compile` / `capsule_select`** — the bounded Task Capsule:
  relevance-ranked, explainable claim selection with fail-closed structured
  filters; every budget cut is a recorded omission.
- **`collation`** — JS `localeCompare` ordering (claim/node/edge ranking is
  part of the frozen contract), pinned as an empirical weight table
  extracted from the reference runtime and verified on ~2.1M probe pairs;
  characters outside the pinned domain fail loud rather than silently
  diverging.

Zero runtime dependencies. Python 3.11+.

## Provenance and proof

This package is a **reference-guided port** of a proven Node.js
implementation developed and hardened in The Little AI Company's
governed-context research program (589 tests, adversarially reviewed,
benchmarked on real workspaces). The port did not reinterpret a spec — the
Node modules and their tests are the executable oracle, and the port is
proven **byte-identical** on every JSON contract: the frozen
ContextIntegrityEvent v0 conformance and replay fixtures (including the
pinned projection fingerprint), evidence-store JSONL bytes and git object
SHAs, and capsule digest and receipt bytes over captured real-pipeline
capsules. The cross-language parity harness lives with the reference
implementation; the frozen fixtures travel here (`tests/fixtures/`) so this
package's own test suite re-verifies the contract bytes on every run.

## Tests

```sh
pip install pytest
python -m pytest packages/core/tests/ -q
```

The suite is the Node reference suite translated 1:1 (135 tests): contract
conformance, replay determinism, fail-closed scope rules, evidence-store
round-trips against real git remotes, and byte-exact digest/receipt output
against the frozen fixtures.
