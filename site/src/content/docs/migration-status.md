---
title: "Migration status"
description: "Current status of stable, optional, experimental, held, deprecated, and planned Vivary surfaces."
editUrl: "https://github.com/vivary-dev/vivary/edit/dev/docs/MIGRATION-STATUS.md"
---

This page is the canonical classification of public and development surfaces. The
[root release status](https://github.com/vivary-dev/vivary/blob/dev/README.md#release-status) owns exact source and registry
versions; [DECISIONS.md](/decisions/) routes durable choices. Status was reconciled
against the linked manifests, contracts, and registry pages on **2026-08-10**.

## Classification

| Status | Meaning | Current surfaces | Evidence or next gate |
|---|---|---|---|
| **Stable** | Published and supported; this is not a promise of post-1.0 API stability. | The registry versions and their baseline CLI/workspace behavior listed in the [release-status table](https://github.com/vivary-dev/vivary/blob/dev/README.md#release-status). | Registry links live in that table; baseline regressions live with [Tropo](https://github.com/vivary-dev/vivary/blob/dev/packages/tropo/tests/test_tropo.py), [Ozone](https://github.com/vivary-dev/vivary/blob/dev/packages/ozone/tests/test_ozone.py), [Exo](https://github.com/vivary-dev/vivary/blob/dev/packages/exo/tests/test_exo.py), and [create-vivary](https://github.com/vivary-dev/vivary/blob/dev/packages/create-vivary/tests/test_create_vivary.py). |
| **Optional** | Installed, configured, or invoked only by explicit choice; optional is independent of maturity. | Ozone and Exo beyond the Tropo + Strato baseline; storage and semantic-memory capabilities including `vivary-memory-cognee`; Obsidian and active-context integrations; and `vivary-mcp` (also experimental while unpublished). | [Architecture boundaries](/architecture/#2-the-first-principles-baseline), [semantic-memory gates](/semantic-memory/#non-negotiables), [active-context gates](/active-context/), and the [MCP install boundary](/mcp/#install-boundary). |
| **Experimental** | Implemented in development source, opt-in where callable, and not registry-available at the source versions. | The `thin-v0.3` init/adoption contract in `create-vivary 0.4.0`; `vivary-core`; governed Tropo, Strato, Ozone, and Exo paths; the provider-neutral recall firewall; and the optional read-only `vivary-mcp` adapter. | [Thin adoption regressions](https://github.com/vivary-dev/vivary/tree/dev/packages/create-vivary/tests), [Core contract tests](https://github.com/vivary-dev/vivary/tree/dev/packages/core/tests), [role envelopes](/commands/#governed-machine-readable-envelopes-development-source), and [MCP contract tests](https://github.com/vivary-dev/vivary/tree/dev/packages/mcp/tests). |
| **Held** | Complete or partial source work that must not be described as published, graduated, or default-enabled. | Publication of the named **Vivary Governed Context** train, including every unpublished source version in the root release status. | The release policy resolved by [#149](https://github.com/vivary-dev/vivary/issues/149), the documentation acceptance completed by [#210](https://github.com/vivary-dev/vivary/issues/210), and the remaining per-item human gates in the [release workflow](/release-workflow/#gates). |
| **Deprecated** | Formally discouraged with a documented replacement and removal policy. | **None.** Legacy full workspace layouts and legacy Exo graph commands remain read-compatible surfaces, not deprecations. New init/adopt no longer generate the full layout. | [Doctor compatibility contract](/commands/#doctor-compatibility-and-declared-configuration) and [legacy Exo commands](/commands/#legacy-graph-coordination). |
| **Planned** | Described intent with no shipped behavior claim. | Cloud storage adapters and non-file/cloud migration targets; any broader MCP transport or named-client compatibility. | [Data-layer future work](https://github.com/vivary-dev/vivary/blob/dev/docs/SPEC-data-layer.md#future--cloud-adapters-03x); MCP external conformance remains explicitly [unproven](/mcp/#contract). These are plans or hypotheses until implementation evidence exists. |

## Moving forward without rewriting history

Existing releases keep their independent package versions; no historical tag,
changelog entry, or registry artifact is renumbered. A named train coordinates a set
of versions but is not itself a package version. Only the two distributions of the
same scaffolder—`create-vivary` on PyPI and `@vivary/create` on npm—remain numerically
lockstep. The policy and lifecycle are owned by the
[release workflow](/release-workflow/#train-and-version-lifecycle), resolving the
choice requested by [#149](https://github.com/vivary-dev/vivary/issues/149).

Until the held train is separately approved, published install commands resolve the
registry versions in the root table. Development-source users must install from one
explicit checkout and should not infer publication from a manifest version. After a
train is verified, the same root table changes from old registry truth to new registry
truth; this page changes only if a surface's classification changes.
