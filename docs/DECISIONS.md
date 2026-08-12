# Vivary decisions

This is a compact index, not a second specification. Follow the first link in each
entry for the canonical detail. Decisions and evidence links were reviewed on
**2026-08-09**.

- [**D-001 — Named trains coordinate independent package semvers.**](RELEASE-WORKFLOW.md#train-and-version-lifecycle)
  **Vivary Governed Context** is a release label, not a suite version. Packages bump only when their
  own surface changes; only `create-vivary` and `@vivary/create` use the same version.
  This is the selected resolution of [#149](https://github.com/vivary-dev/vivary/issues/149).
- [**D-002 — `vivary-core` is a shared seam, not a fifth role or CLI.**](ARCHITECTURE.md#the-shared-seam-vivary-core)
  Tropo observes and retrieves, Strato decides, Ozone verifies and proposes, and Exo
  projects caller-owned control state. Their manifests provide the executable
  [dependency evidence](ARCHITECTURE.md#package-dependency-map).
- [**D-003 — The Python-owned CLI is the baseline agent interface; MCP is optional and narrower.**](SPEC-data-layer.md#agent-cli-contract)
  Python packages own behavior and command envelopes; the npm scaffolder is a launcher
  for the canonical Python CLI. MCP exposes four bounded read-only projections over
  operator-bound roots and cannot replace setup, migration, mutation, execution,
  approval, or publication commands. [MCP.md](MCP.md) owns its limits and authority boundary.
- [**D-004 — Memory remains optional and cannot silently become authored truth.**](bellamente-memory/ADR-0001-bellamente-agent-ltm-beside-tropo.md)
  Provider recall produces candidates; Core classifies them and returns a deterministic
  Learning Proposal before a create or supersede transition can receive exact human
  approval. [Recall tests](https://github.com/vivary-dev/vivary/blob/dev/packages/core/tests/test_recall.py)
  are the behavior evidence.
- [**D-005 — Unknown, conflicting, or omitted context stays visible.**](ARCHITECTURE.md#the-shared-seam-vivary-core)
  Core does not convert missing evidence into confidence. Task Capsules, Execution
  Receipts, Integrity Views, and ContextIntegrityEvents preserve the distinction; the
  [public vocabulary](SPEC-data-layer.md#public-governed-context-vocabulary) owns those
  terms.
- [**D-006 — Canonical source docs own truth; generated site pages are mirrors.**](RELEASE-WORKFLOW.md#3-keep-docs-and-site-in-sync)
  Behavior, migration, and release facts change in their named canonical owner first.
  Site synchronization happens only in the approved release workflow.

For a new hard-to-reverse choice, add a focused ADR beside the affected spec and link
it here. Use [MIGRATION-STATUS.md](MIGRATION-STATUS.md) for changing maturity status,
not an ADR.
