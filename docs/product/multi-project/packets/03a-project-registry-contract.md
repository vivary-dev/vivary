# 03a: Define the portable registry contract and acceptance fixtures
Type: packet
Parent: 03
Status: done
Depends-on: []
Owner: Codex integration agent
Scope: Contract, data fixtures, and test expectations only; no persistence implementation.
Verification-kind: inspection
Evidence: [Registry inspection receipt](../receipts/03a-registry-contract.md)
Timebox: One context window; stop after the contract and fixtures are reviewed.

## Goal

Define the project identities and authority rules that an implementation can
test without first choosing a database or importing application code.

## Context

Read [project and authority terms](../CONTEXT.md), [the filesystem model](../design.md#filesystem-and-repository-model),
[native owners](../native-owners.md), and `packages/create-vivary/create_vivary.py`
where the thin workspace's portable schema is defined. Existing graph project
records are not an application registry. This preparatory packet has no import,
live connection, or production-placement prerequisite.

## Owned files

- Create `docs/product/multi-project/contracts/project-registry.md`.
- Create `docs/product/multi-project/fixtures/project-registry.json`.
- Create `docs/product/multi-project/receipts/03a-registry-contract.md`.
- Prepare the exact implementation and execution checks in packet 03b before closing.

## Done condition

1. Define stable project identity separately from portable content identity,
   local path, common repository identity, checkout identity, runtime session,
   and BrowserPod execution-copy identity. Define revision-checked write-back;
   do not imply that the pod disk is the original device folder.
2. Define registration as a read-only inspection plus a registry write. It must
   not initialize VCS, modify project files, create remotes, or adopt implicitly.
3. Define deterministic expected results for no-VCS, Git, linked worktree,
   monorepo, colocated Jujutsu, moved root, missing root, duplicate registration,
   stale policy, and ambiguous ownership cases.
4. Show that exported project data contains no machine path or secret. State
   precisely which duplicate inputs converge and which ambiguity is refused.
5. Define shared-repository serialization and crash-recovery requirements without
   claiming that a JSON fixture implements locks or persists data.
6. A second reader verifies every fixture against the written rule. Remaining
   production placement and platform questions are explicit, with owning outcomes.

## Verify

Compare each fixture's input, expected result, and named invariant with the
contract. Inspect the diff and run the existing documentation guard in CI.
These are contract checks, not runtime behavior proof. Packet 03b owns executable
adapter checks inside BrowserPod once the required toolchain is verified.

```console
git diff --check
git diff -- docs/product/multi-project/contracts/project-registry.md docs/product/multi-project/fixtures/project-registry.json
gh pr checks
```

## Stop conditions

Do not choose a database, import source, create a project, or start a runtime.
Do not ask for those choices to write the independent contract. When source
semantics conflict, record the competing facts and the affected fixture rather
than inventing a production default. Current execution authority belongs to
[the execution rules](../execution-contract.md); BrowserPod is unavailable.

## Log

- 2026-09-05: Prepared as independent contract work. App placement and future output files are no longer circular start prerequisites. No registry implementation or behavior result is claimed.

- 2026-09-05: Codex integration agent claimed 03a under the owner's instruction to take the next issue. One reader inspects existing schema semantics; only the integration agent writes this contract and fixtures. Browserbase was requested for verification and its connection is being checked. No runtime, source import, or database selection is needed for this inspection packet.

- 2026-09-05: Source review, two-reader contract/fixture review, JSON inspection, exact record expectations, and documentation checks completed. Browserbase was requested but is not exposed to this session. No browser or product runtime ran. The executable successor is 03b, which requires 10b's actual BrowserPod toolchain proof. Parent 03 remains in progress; PR #328 carries final publication checks.
