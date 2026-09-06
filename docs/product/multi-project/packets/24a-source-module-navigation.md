# 24a: Index canonical sources and module ownership

Type: packet
Parent: 24
Status: ready-for-agent
Depends-on: [12a]
Owner: Source-navigation agent, sole writer, with an independent retrieval reviewer
Scope: Configure a bounded typed source graph and four module routes over canonical source references. Preserve source ownership and distinguish implemented behavior from proposals.
Verification-kind: inspection
Timebox: One context window. Stop after the source graph and four module routes pass independent retrieval checks.

## Goal

Let a fresh agent find the owning source, related contract, implementation,
verification, and current task without reading the complete program or copying
its documents. This is preparatory work under outcome 24. It does not complete
installed guides or alter the parent outcome's release dependencies.

## Context

Read [execution rules](../execution-contract.md), [program context](../CONTEXT.md),
[architecture](../../../ARCHITECTURE.md), and [native owners](../native-owners.md).
Use [source evidence](../evidence.md), [migration](../migration.md),
and the [accepted 12a receipt](../receipts/12a-root-vcs-observation-contract.md)
to distinguish source locations and implementation gaps.

Read `packages/tropo/SPEC.md` for schema and graph semantics. Read
`packages/tropo/packs/repo-graph.toml` before reusing that pack.
Its relationship text lists do not form Tropo edges and cannot be retyped by an
overlay. Use additive `ref-list` fields named `contract_refs`, `source_refs`,
`test_refs`, `evidence_refs`, and `module_refs` where needed.

The 2026-09-06 inspection found no repository-wide module graph in the canonical
or preserved implementation checkout. Recheck before creating records.
Brain OKF and Tropo project schemas retain their separate owners. This task
requires no Brain import or changes to personal knowledge stores.

Tropo analyzes the entire tree under its configured root. Use the dedicated
`docs/product/multi-project/source-map/` subtree so unrelated repository content
stays outside the graph. References resolve inside that tree. Source-reference
records point to canonical files outside it through repository-relative locators.
Their brief purpose and locator are navigation metadata, not another specification.

## Owned files

- Create `docs/product/multi-project/source-map/tropo.toml` and `index.md`.
  Define the module and source-reference types and the additive typed fields.
  Keep the tree-level index as the router rather than adding a fifth module record.
- Create four records at `docs/product/multi-project/source-map/modules/NAME/index.md`,
  where `NAME` is exactly `root-observation`, `project-registry`, `native-runtime`,
  or `project-writeback`.
- Create source-reference records in `docs/product/multi-project/source-map/sources/`
  using the exact filenames and locator mappings below. Each record contains a
  concise purpose, repository-relative locator, and required graph metadata.
- Create `scripts/check-source-navigation.py` and
  `scripts/tests/test-source-navigation.py` for the source-locator, graph-identity,
  typed-edge, and negative navigation checks below. Reuse Tropo through its existing
  commands or tested library functions. Add no parser or graph engine.
- Update `AGENTS.md` and `docs/README.md` with a short conditional pointer to the
  source-map index. Preserve existing execution and release authorities.
- Update this packet, `docs/product/multi-project/tickets/24-write-product-docs-guides.md`,
  and generated `docs/product/multi-project/index.md` and `graph.md` through the
  planning renderer.
- Create `docs/product/multi-project/receipts/24a-source-module-navigation.md` for
  commands, candidate hashes, observed edges, negative checks, and independent retrieval.

| Source-reference filename | Canonical locator from repository root |
| --- | --- |
| `program-execution.md` | `docs/product/multi-project/execution-contract.md` |
| `root-observation-contract.md` | `docs/product/multi-project/contracts/root-vcs-observation.md` |
| `registry-contract.md` | `docs/product/multi-project/contracts/project-registry.md` |
| `registry-transactions.md` | `docs/product/multi-project/contracts/project-registry-transaction-map.md` |
| `native-owners.md` | `docs/product/multi-project/native-owners.md` |
| `checkout-observer-code.md` | `packages/core/vivary_core/workspace_observe.py` |
| `checkout-observer-tests.md` | `packages/core/tests/test_observe.py` |
| `registry-model-code.md` | `scripts/registry_contract_model.mjs` |
| `registry-model-tests.md` | `scripts/tests/test_registry_contract_model.mjs` |
| `observation-receipt.md` | `docs/product/multi-project/receipts/12a-root-vcs-observation-contract.md` |
| `registry-receipt.md` | `docs/product/multi-project/receipts/03c-registry-transaction-mapping.md` |

## Done condition

Every module record names its owning outcome, caller-visible behavior and errors,
hidden implementation concerns, and dependencies. Source and evidence relationships
use declared typed fields. Test references name existing tests only. Record an
absent implementation or test as a gap instead of inventing its source path.
Native runtime source remains preserved outside this checkout. Route to its
canonical owner inventory and receipt instead of copying private local paths.

The root-observation record links to its contract, Core source, tests, and receipt.
The registry record distinguishes its executable model from production storage.
The runtime record distinguishes host tests from real coding-runtime proof.
The write-back record distinguishes authorization from observed file effects.
Every module has typed contract/source and evidence relationships, or an explicit
gap for a relationship whose source does not exist. Reuse native capability owners.

Use graph JSON for directed-edge assertions. `find` proves bounded text retrieval.
`blast` proves inbound impact only. For example, module `root-observation` points
to source `root-observation-contract` through `contract_refs`. Blasting that source
must include the module. It is not an outbound related-source traversal.

Selected Markdown-document count must equal unique graph-node count. Every expected
record ID must resolve to exactly one path. Tropo's graph builder can retain only
the first duplicate ID, so successful graph output alone does not establish uniqueness.

## Verify

Use the existing repository Python toolchain for this inspection packet.
Preflight its version and required imports. Install nothing and start no app,
container, coding runtime, schedule, or paid service.
From the repository root, run:

```console
python -B packages/tropo/tropo.py check --root docs/product/multi-project/source-map
python -B packages/tropo/tropo.py graph --json --root docs/product/multi-project/source-map
python -B packages/tropo/tropo.py find "root observation" --budget 1200 --json --root docs/product/multi-project/source-map
python -B packages/tropo/tropo.py blast root-observation-contract --depth 2 --json --root docs/product/multi-project/source-map
python -B scripts/check-source-navigation.py --check
python -B scripts/tests/test-source-navigation.py
python -B scripts/check_multi_project_plan.py --render
python -B scripts/check_multi_project_plan.py --check
python -B scripts/check_line_endings.py
git diff --check
```

The navigation checker verifies the exact selected record IDs, unique identities,
expected directed edges, and source locators. Resolve each locator within the
canonical repository and reject missing targets or escapes. Check the graph's
source tree contains only the index, four modules, and eleven source records.
Keep evidence and generated mirrors outside that tree.

The focused tests use disposable local fixtures and the same checker. Prove a
broken typed reference, duplicate ID, missing locator, and escaping locator fail.
For movement, keep a source-reference record's filename and graph ID fixed.
Move its target fixture, update only the locator, and prove incoming edges still
resolve. This proves navigation continuity, not physical filesystem identity.

An independent reader starts at the root pointer and finds this packet, the
root-observation owner, contract, and receipt without loading the whole specification.
Record files read, commands, output, and limits. Save raw local output in ignored
storage. Public evidence quotes repository-relative nodes and edges and states
any path redaction. Preserve candidate hashes and the exact command exit status.

Retain the known Windows planning-test newline failure until a scoped rerun
establishes resolution. These checks prove source navigation, not application behavior.

## Stop conditions

Stop a conflicting edit if another writer owns the file. If this bounded tree
requires a new graph engine, protected parser changes, source import, or product
refactoring, record the concrete gap and stop that expansion. Do not select a
database or create a queue, session store, runtime binding, or write-back adapter.

Complete only the verified navigation and module map. Keep outcome 24 planned
until its installed-documentation acceptance passes. The receipt links to the
accepted 12a continuation guidance and marks the physical-observer packet as
proposed and absent unless the canonical graph independently contains one.
This packet neither creates nor claims 12b. Keep its preparation as a separate
future task governed by the accepted 12a guidance and the current generated frontier.
No publication, account change, or product activation occurs.

## Log

- 2026-09-06: Prepared after the owner's request for progressive disclosure,
  open knowledge, related-source navigation, specific information locations,
  and deep modules. Source graph and retrieval implementation remain pending.
