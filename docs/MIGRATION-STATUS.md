# Vivary migration status

This page is the canonical classification of public and development surfaces. The
[root release status](../README.md#release-status) owns exact source and registry
versions; [DECISIONS.md](DECISIONS.md) routes durable choices. Status was reconciled
against the linked manifests, contracts, and registry pages on **2026-08-10**.

## Classification

| Status | Meaning | Current surfaces | Evidence or next gate |
|---|---|---|---|
| **Stable** | Published and supported; this is not a promise of post-1.0 API stability. | The registry versions and their baseline CLI/workspace behavior listed in the [release-status table](../README.md#release-status). | Registry links live in that table; baseline regressions live with [Tropo](https://github.com/vivary-dev/vivary/blob/dev/packages/tropo/tests/test_tropo.py), [Ozone](https://github.com/vivary-dev/vivary/blob/dev/packages/ozone/tests/test_ozone.py), [Exo](https://github.com/vivary-dev/vivary/blob/dev/packages/exo/tests/test_exo.py), and [create-vivary](https://github.com/vivary-dev/vivary/blob/dev/packages/create-vivary/tests/test_create_vivary.py). |
| **Optional** | Installed, configured, or invoked only by explicit choice; optional is independent of maturity. | Ozone and Exo beyond the Tropo + Strato baseline; storage and semantic-memory capabilities including `vivary-memory-cognee`; Obsidian and active-context integrations; and `vivary-mcp` (also experimental while unpublished). | [Architecture boundaries](ARCHITECTURE.md#2-the-first-principles-baseline), [semantic-memory gates](SEMANTIC-MEMORY.md#non-negotiables), [active-context gates](ACTIVE-CONTEXT.md), and the [MCP install boundary](MCP.md#install-boundary). |
| **Experimental** | Implemented in development source, opt-in where callable, and not registry-available at the source versions. | The `thin-v0.3` init/adoption contract in the `create-vivary` development source; `vivary-core`; governed Tropo, Strato, Ozone, and Exo paths; the provider-neutral recall firewall; and the optional read-only `vivary-mcp` adapter. | [Thin adoption regressions](https://github.com/vivary-dev/vivary/tree/dev/packages/create-vivary/tests), [Core contract tests](https://github.com/vivary-dev/vivary/tree/dev/packages/core/tests), [role envelopes](COMMANDS.md#governed-machine-readable-envelopes-development-source), and [MCP contract tests](https://github.com/vivary-dev/vivary/tree/dev/packages/mcp/tests). |
| **Held** | Complete or partial source work that must not be described as published, graduated, or default-enabled. | Publication of the named **Vivary Governed Context** train, including every unpublished source version in the root release status. | The release policy resolved by [#149](https://github.com/vivary-dev/vivary/issues/149), the documentation acceptance completed by [#210](https://github.com/vivary-dev/vivary/issues/210), and the remaining per-item human gates in the [release workflow](RELEASE-WORKFLOW.md#gates). |
| **Deprecated** | Formally discouraged with a documented replacement and removal policy. | **None.** Legacy full workspace layouts and legacy Exo graph commands remain read-compatible surfaces, not deprecations. New init/adopt no longer generate the full layout. | [Doctor compatibility contract](COMMANDS.md#doctor-compatibility-and-declared-configuration) and [legacy Exo commands](COMMANDS.md#legacy-graph-coordination). |
| **Planned** | Described intent with no shipped behavior claim. | Cloud storage adapters and non-file/cloud migration targets; any broader MCP transport or named-client compatibility. | [Data-layer future work](SPEC-data-layer.md#future--cloud-adapters-03x); MCP external conformance remains explicitly [unproven](MCP.md#contract). These are plans or hypotheses until implementation evidence exists. |

## Moving forward without rewriting history

Existing releases keep their independent package versions; no historical tag,
changelog entry, or registry artifact is renumbered. A named train coordinates a set
of versions but is not itself a package version. Only the two distributions of the
same scaffolder—`create-vivary` on PyPI and `@vivary/create` on npm—remain numerically
lockstep. The policy and lifecycle are owned by the
[release workflow](RELEASE-WORKFLOW.md#train-and-version-lifecycle), resolving the
choice requested by [#149](https://github.com/vivary-dev/vivary/issues/149).

Until the held train is separately approved, published install commands resolve the
registry versions in the root table. Development-source users must install from one
explicit checkout and should not infer publication from a manifest version. After a
train is verified, the same root table changes from old registry truth to new registry
truth; this page changes only if a surface's classification changes.
