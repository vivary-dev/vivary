# 01: Reconcile migration provenance and product boundaries
Status: ready-for-human
Blocked-by: []
Owner: integration agent
Scope: Public documentation and provenance reconciliation only. Human action is limited to reviewing the documentation pull request.
Unlocks: [02, 03]

## Goal

Produce the reviewed source-to-destination and authority map that lets later work preserve Littleagent, Vivary, and HarnessMax evidence.

## Context

Program context: [design](../design.md), [migration](../migration.md), [release](../release.md), and [evidence](../evidence.md).

Own `docs/product/multi-project/migration.md` amendments and a new `docs/product/multi-project/receipts/01-migration-boundaries.md`. Read `design.md`, `migration.md`, `evidence.md`, `CONTEXT.md`, Littleagent `docs/product/workbench-plan.json`, and specifications S-00A through S-13. Recheck each source root, dirty state, active writer, license, and repository identity. Do not move source or retire legacy work.

## Done condition

The public receipt maps every source identity or class, S-00A and S-00 through S-13 responsibility, dirty-work class, known license finding, unresolved authority, and proposed destination owner. It identifies conflicts between old specifications and the Vivary program without publishing private provenance or claiming restoration.

## Verify

Review [the receipt](../receipts/01-migration-boundaries.md) against every row in `migration.md` and every S-00A/S-00 through S-13 entry. Run the planning validator, line-ending check, and diff check in the isolated Vivary worktree. A human can trace each retained responsibility to one source class, one proposed owner, and its unresolved preservation prerequisite.


Common planning checks (these checks do not prove product behavior):

```console
python scripts/check_multi_project_plan.py --check
python scripts/check_line_endings.py
git diff --check
```

## Log

- 2026-09-05: Public boundary receipt completed in the sanitized candidate. Status moved to `ready-for-human` for documentation pull-request review only. No preservation, retirement, publication, or real-runtime proof is claimed.

- 2026-09-05: Habitat graph/link/privacy guard passed for all 36 tickets; six adversarial guard fixtures passed. Public source was reviewed for private material. Line endings passed. Final diff hygiene and PR CI are recorded in the pull request. Ticket remains ready-for-human for documentation review; no source import or release gate is closed.

- 2026-09-05: Owner corrected the execution environment to BrowserPod and explicitly excluded Habitat/WSL. Historical checks retain their actual environment labels; BrowserPod proof is pending. Program and entry-point instructions now preserve this decision. Shared plan is in PR #328 for review.
