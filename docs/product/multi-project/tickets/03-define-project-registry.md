# 03: Define project registry and authority contracts
Status: needs-info
Blocked-by: [01]
Needs: Human acceptance of ticket 01 plus selection of the application package and persistence owner. The contract must name exact production implementation files, and the future checker, test, and fixture paths below must exist before this ticket becomes actionable.
Unlocks: [04, 05, 06, 07, 08, 12, 14, 18]

## Goal

Define portable project identity, machine-local bindings, authority, idempotency, and serialization for a collection of independent project roots.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own the application contract under the proposed Vivary app package and canonical architecture docs named by `design.md`. Read `design.md`, `CONTEXT.md`, `evidence.md`, and the existing thin workspace schema in `packages/create-vivary/create_vivary.py`. Do not use the existing graph `project` type as an app registry.

## Done condition

Contract fixtures cover external roots, no-VCS folders, Git worktrees, monorepos, path moves, missing roots, duplicate registration, shared repository identity, and concurrent mutation ownership.

## Verify

Run contract tests that round-trip portable identity separately from local paths and secrets. Prove duplicate operations converge and shared repository mutations serialize.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Next packet

- Scope: define portable project identity, machine-local bindings, authority, idempotency, and repository-level mutation serialization. Do not build project UI or reuse the workspace-graph `project` type as the registry.
- Files: `docs/product/multi-project/contracts/project-registry.md`, `docs/product/multi-project/fixtures/project-registry.json`, `scripts/check_multi_project_registry_contract.py`, and `scripts/tests/test_multi_project_registry_contract.py`. The contract must name exact production implementation files before work starts.
- Acceptance: fixtures cover an external no-VCS root, Git repository, linked worktree, monorepo with two logical projects, colocated Jujutsu workspace, moved path, missing root, duplicate registration, shared repository identity, stale authority, and concurrent mutation ownership. Portable identity round-trips without a machine path or secret. Duplicate requests converge, and shared repository mutations serialize under one owner.
- Behavior commands after the missing owner and files exist:

```console
python -m pytest scripts/tests/test_multi_project_registry_contract.py -q
python scripts/check_multi_project_registry_contract.py --fixtures docs/product/multi-project/fixtures/project-registry.json --check
```

These commands define the required future interface. This ticket does not claim that the files exist or the commands pass.

## Log

- 2026-09-05: Initial public plan recorded. Implementation has not started.
