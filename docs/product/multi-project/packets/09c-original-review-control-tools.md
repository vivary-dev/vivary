# 09c: Expose original review and control tools in Native
Type: packet
GitHub-issue: https://github.com/vivary-dev/Vivary-New/issues/20
Parent: 09
Status: done
Depends-on: [09b, 07d]
Evidence: [Original review and control tools receipt](../receipts/09c-original-review-control-tools.md)
Verification-result: passed
Owner: Root-assigned governed-tool integrator
Scope: Expose decide, review, impact, and control without replacing original policies or records.
Verification-kind: runtime
Timebox: One governed-tool increment with focused refusals and a visible review journey.

## Goal

Let the application and agent inspect original policy decisions, review findings,
impact, and control results while preserving the authority of each source owner.

## Context

Read [the desktop release plan](../desktop-release.md), [ENGINEERING.md](../../../../ENGINEERING.md),
[Native ownership](../native-owners.md), and the original context/review source map.
Reuse the original CLI routing and the shared bundled-package adapter from 09b.
A policy decision or returned control state does not itself execute the proposed work.

## Owned files

- `packages/strato/strato.py`: `decide_governed` and its existing request contract.
- `packages/ozone/ozone.py`: `cmd_review` and `cmd_impact`.
- `packages/exo/exo.py`: `governed_control`; `packages/core/vivary_core/control.py` owns transitions.
- Deterministic actions in `packages/workbench/actions/` and their existing server adapter.
- Existing review/result UI and focused original policy/control tests.

## Done condition

Expose decide, review, impact, and control through typed, project-scoped actions.
Retain original schemas, reason codes, policy versions, and supported operation
semantics. Resolve actor and project authority at the server boundary. Do not trust
an input field that claims an elevated role, approval, or verification result.

The app and agent receive the same result and can inspect the relevant source
records. Preserve required review gates and original ownership of writes.
Returned state remains a result until its authorized owning operation persists it.
Do not manufacture receipts from successful dispatch or duplicate records in Native.
Unsupported enforcement or missing evidence produces an explicit refusal.

## Verify

Compare installed CLI and action results for a permitted request and the relevant
denied cases: wrong actor/project, stale input, missing approval, and malformed data.
Exercise the GUI review and the registered Native tools. Confirm refusals leave
authored records unchanged and approved effects use only the original writer.

```console
python -B -m pytest packages/strato/tests/test_strato.py packages/ozone/tests/test_ozone.py packages/exo/tests/test_exo.py packages/core/tests/test_control.py -q
pnpm --dir packages/workbench typecheck
git diff --check
```

## Stop conditions

Do not turn `act` into execution authority, enable strict mutation on local-stat
roots, bypass a source policy, launch workers, or create another executor/store.

## Log

- 2026-09-13: Drafted for the desktop release. No new tool or authority is activated.
- 2026-09-26: Claimed on `feat/review-control-tools` from `dev` `a08405d`.
  Dependencies #19 and #15 are closed. The owner resolved the needs on the
  issue. Review and impact get a privacy-filtered public path, so the panel and
  the agent receive the same result. Native tool calls to decide and control
  bind a server-derived agent actor with contributor authority. A tool caller
  cannot submit decide's receipt or verdict, and control results are not
  persisted.
- 2026-09-26: Implemented in `60f78a0` to `e96871d`. Review and impact join
  `vivary-project-read`. Decide and control move to the new
  `vivary-project-evaluate` agent tool and an owner action. The agent may run
  decide, claim, release, expire_leases, and dependencies. A three-model review
  of `e96871d` found an existence oracle over private files, a codec that
  rewrote capsule text, and Core refusals shown as successes. Fixes landed in
  `5aa6aa6` and `24461c0`. A second review found four more refusals shown as
  successes, fixed in `33cbcbb`. A third review of `33cbcbb` found no new
  issues. The 22-step hosted journey passed three runs in a row on `33cbcbb`
  with a fake provider. The [receipt](../receipts/09c-original-review-control-tools.md)
  records the evidence. A real provider turn has not run. The PR is pending
  owner approval, and the work is not accepted.
- 2026-09-26: The unpublished `1249572d` Windows package, built from
  `1249572`, passed Review, Impact, Decide, claim, and release in Project
  details and a 14-check agent turn with a fake provider. Project files kept
  their snapshots. Owner acceptance and issue closure are pending.
- 2026-09-26: PR #95 merged into `dev` as `7fb73bd` after all checks passed
  on its head `1513a82`, and the owner accepted the result and closed issue #20.
  Marked done. No real provider turn has run. That belongs to issue #50.

## Shared desktop and web behavior

The same review/control flows and explicit approvals must remain usable at narrow browser widths. Browser access does not widen execution authority.
