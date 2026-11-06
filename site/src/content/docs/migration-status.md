---
title: "Migration status"
description: "Current status of stable, optional, experimental, held, deprecated, and planned Vivary surfaces."
editUrl: "https://github.com/vivary-dev/vivary/edit/dev/docs/MIGRATION-STATUS.md"
---

This page classifies public and development surfaces. Published versions are
listed in the [Python](https://pypi.org/project/vivary/) and
[npm](https://www.npmjs.com/package/@vivary/create) registries.
[DECISIONS.md](/decisions/) routes durable choices. Baseline acceptance
retains the **2026-08-15** evidence. The **2026-09-13** registry availability check
and staged-source status do not add fresh installation acceptance.

## Classification

| Status | Meaning | Current surfaces | Evidence or next gate |
|---|---|---|---|
| **Stable** | Published and supported; this is not a promise of post-1.0 API stability. | The published Python packages and npm launcher with their baseline CLI/workspace behavior. | Public registry links appear above; baseline regressions live with [Tropo](https://github.com/vivary-dev/vivary/blob/dev/packages/tropo/tests/test_tropo.py), [Ozone](https://github.com/vivary-dev/vivary/blob/dev/packages/ozone/tests/test_ozone.py), [Exo](https://github.com/vivary-dev/vivary/blob/dev/packages/exo/tests/test_exo.py), and [create-vivary](https://github.com/vivary-dev/vivary/blob/dev/packages/create-vivary/tests/test_create_vivary.py). |
| **Optional** | Installed, configured, or invoked only by explicit choice; optional is independent of maturity. | Ozone and Exo beyond the Tropo + Strato baseline; storage and semantic-memory capabilities including `vivary-memory-cognee`; Obsidian and active-context integrations; and the published but experimental `vivary-mcp`. | [Architecture boundaries](/architecture/#purpose-and-owner-intent), [semantic-memory gates](/semantic-memory/#non-negotiables), [active-context gates](/active-context/), and the [MCP install boundary](/mcp/#install-boundary). |
| **Experimental** | Published and opt-in where callable, with contracts that may still change before 1.0. | The `thin-v0.3` init/adoption contract in `create-vivary`; `vivary-core`; governed Tropo, Strato, Ozone, and Exo paths; the provider-neutral recall firewall; and the optional read-only `vivary-mcp` adapter. | [Thin adoption regressions](https://github.com/vivary-dev/vivary/tree/dev/packages/create-vivary/tests), [Core contract tests](https://github.com/vivary-dev/vivary/tree/dev/packages/core/tests), [role envelopes](/commands/#governed-machine-readable-envelopes), and [MCP contract tests](https://github.com/vivary-dev/vivary/tree/dev/packages/mcp/tests). |
| **Held** | Complete or partial source work that must not be described as published, graduated, or default-enabled. | The unpublished workspace-role repairs and local desktop application. The earlier Front Door PyPI components are available, but npm 0.4.3 is absent and the coordinated train is incomplete. | The release policy resolved by [#149](https://github.com/vivary-dev/vivary-cli/issues/149), the documentation acceptance completed by [#210](https://github.com/vivary-dev/vivary-cli/issues/210), and the per-item human gates in the [release workflow](/release-workflow/#gates). |
| **Deprecated** | Formally discouraged with a documented replacement and removal policy. | **None.** Legacy full workspace layouts and legacy Exo graph commands remain read-compatible surfaces, not deprecations. New init/adopt no longer generate the full layout. | [Doctor compatibility contract](/commands/#doctor-compatibility-and-declared-configuration) and [legacy Exo commands](/commands/#legacy-graph-coordination). |
| **Planned** | Described intent with no shipped behavior claim. | Cloud storage adapters and non-file/cloud migration targets; any broader MCP transport or named-client compatibility. | [Data-layer future work](https://github.com/vivary-dev/vivary/blob/dev/docs/SPEC-data-layer.md#future--cloud-adapters-03x); MCP external conformance remains explicitly [unproven](/mcp/#contract). These are plans or hypotheses until implementation evidence exists. |

## Moving forward without rewriting history

Existing releases keep their independent package versions; no historical tag,
changelog entry, or registry artifact is renumbered. A named train coordinates a set
of versions but is not itself a package version. Only the two distributions of the
same scaffolder—`create-vivary` on PyPI and `@vivary/create` on npm—remain numerically
lockstep. The policy and lifecycle are owned by the
[release workflow](/release-workflow/#train-and-version-lifecycle), resolving the
choice requested by [#149](https://github.com/vivary-dev/vivary-cli/issues/149).

Published install commands resolve the versions in their respective registries. Do not
infer publication from a manifest version. Source versions and verification evidence are maintained separately from registry
availability. This page changes when a surface's classification changes.
