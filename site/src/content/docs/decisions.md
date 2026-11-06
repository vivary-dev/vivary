---
title: "Decisions"
description: "Hard-to-reverse Vivary decisions and links to their canonical owners."
editUrl: "https://github.com/vivary-dev/vivary/edit/dev/docs/DECISIONS.md"
---

This is a compact index, not a second specification. Follow the first link in each
entry for the canonical detail. The initial decisions and evidence links were
reviewed on **2026-08-09**. Later decisions carry their approval date.

- [**D-001 — Named trains coordinate independent package semvers.**](/release-workflow/#train-and-version-lifecycle)
  **Vivary Governed Context** is a release label, not a suite version. Packages bump only when their
  own surface changes; only `create-vivary` and `@vivary/create` use the same version.
  This is the selected resolution of [#149](https://github.com/vivary-dev/vivary-cli/issues/149).
- [**D-002 — `vivary-core` is a shared seam, not a fifth role or CLI.**](/architecture/#the-shared-seam-vivary-core)
  Tropo observes and retrieves, Strato decides, Ozone verifies and proposes, and Exo
  projects caller-owned control state. Their manifests provide the executable
  [dependency evidence](/architecture/#package-dependency-map).
- [**D-003 — The Python-owned CLI is the baseline agent interface; MCP is optional and narrower.**](https://github.com/vivary-dev/vivary/blob/dev/docs/SPEC-data-layer.md#agent-cli-contract)
  Python packages own behavior and command envelopes; the npm scaffolder is a launcher
  for the canonical Python CLI. MCP exposes four bounded read-only projections over
  operator-bound roots and cannot replace setup, migration, mutation, execution,
  approval, or publication commands. [MCP.md](/mcp/) owns its limits and authority boundary.
- [**D-004 — Memory remains optional and cannot silently become authored truth.**](https://github.com/vivary-dev/vivary/blob/dev/docs/bellamente-memory/ADR-0001-bellamente-agent-ltm-beside-tropo.md)
  Provider recall produces candidates; Core classifies them and returns a deterministic
  Learning Proposal before a create or supersede transition can receive exact human
  approval. [Recall tests](https://github.com/vivary-dev/vivary/blob/dev/packages/core/tests/test_recall.py)
  are the behavior evidence.
- [**D-005 — Unknown, conflicting, or omitted context stays visible.**](/architecture/#the-shared-seam-vivary-core)
  Core does not convert missing evidence into confidence. Task Capsules, Execution
  Receipts, Integrity Views, and ContextIntegrityEvents preserve the distinction; the
  [public vocabulary](https://github.com/vivary-dev/vivary/blob/dev/docs/SPEC-data-layer.md#public-governed-context-vocabulary) owns those
  terms.
- [**D-006 — Canonical source docs own truth; generated site pages are mirrors.**](/release-workflow/#3-keep-docs-and-site-in-sync)
  Behavior, migration, and release facts change in their named canonical owner first.
  Learn-by-doing prose lives in `docs/` and syncs to generated Starlight routes under
  `site/src/content/docs/`. Those generated files remain output-only. Development and
  builds may refresh them through `sync-docs`. The release workflow governs publication.
  Any future interactive tutorial shell lives under `site/src/pages/` at a distinct
  route and links to the canonical guide instead of duplicating its prose.

- [**D-007 — Product engineering is the default.**](https://github.com/vivary-dev/vivary/blob/dev/ENGINEERING.md)
  Jeff approved this policy on **2026-09-12**. Implement a coherent user capability,
  run relevant checks, exercise the real app, fix failures, and commit. Invoke
  [high-assurance mode](https://github.com/vivary-dev/vivary/blob/dev/docs/verification/high-assurance-mode.md) for a named dangerous
  failure. Preserve existing evidence, budgets, and specific external-action authority.

For a new hard-to-reverse choice, add a focused ADR beside the affected spec and link
it here. Use [MIGRATION-STATUS.md](/migration-status/) for changing maturity status,
not an ADR.
