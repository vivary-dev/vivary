# Handoff to Codex Cloud: Vivary release continuation

Written 2026-10-18 about 02:05 UTC by the Claude Opus 5.5 coordinating session.
This branch (`handoff/codex-cloud-20261018`) holds only this file. Do not merge it.
It contains no credentials and no private personal data. Private logs stay on the
owner's build server, and this file summarizes their results.

## 1. Ownership

- The Claude session **relinquished write ownership** of every Vivary branch and
  worktree listed here when this file was pushed. It starts no new implementation or
  test job. Codex takes over only after the owner (Jeff) hands ownership to it.
- One detached job that the Claude session queued before the handoff may still be
  running on the build server (section 6). Let it finish. Do not start a competing
  heavy job until it has exited.
- Merges need the owner's approval. Section 4 lists exactly what is approved and on
  which conditions. Nothing here authorizes publication, releases, new spending,
  credentials or account access.

## 2. Branches and exact heads (GitHub `vivary-dev/vivary`, checked 02:00 UTC)

| Item | Branch | Head | State |
|---|---|---|---|
| `dev` | `dev` | `49d7f40cad5c3fc55d04c2a408cd51d9bb4ee370` | #237 merged at 2026-10-17 23:26:54 UTC |
| PR #236 Prepare handoff (A083/A084) | `feat/prepare-handoff-dev` | `e98fef3770f5d5303662ec7174f446142685934a` | Open, mergeable. Merge of dev into `31c5957`. 5 new review threads open (section 5) |
| PR #238 Windows CIM warm-up (test only) | `fix/windows-process-query-warmup-20261017` | `a2704fd2f1ae5e71109b97328df45f9a34dbe566` | Open, mergeable. Ready except Entire trail 146 |
| PR #239 random token vs classifier (test only) | `fix/stream-error-test-token-20261017` | `9249cf536f7136096c19fc4e35d81f0701bd1204` | Open, mergeable. Ready except Entire trail 147 |
| PR #241 `mcp` 2.2.0 pin (replaces #229) | `fix/mcp-sdk-2.2.0-20261017` | `d5cb7dd8f2c4297799fe7bff365dd28a12a64736` | Open, **conflicting** with dev, so GitHub has run no `ci` or review-gate job on it |
| PR #242 in-stream error classification (Core patch) | `fix/provider-stream-error-classification-20261018` | `45138bb2809e8b8fe90dfa361cc5523416dabeed` | Open, mergeable. Claude review 1: 0 findings. Codex bot result not checked at handoff |
| Dependabot #229 | `dependabot/pip/packages/mcp/pip-e915d3edbc` (base `main`) | `5bb097c` | Open. Cannot pass as written. Close it with a link to #241 only after #241 merges |

Uncommitted work: none. Both server worktrees used tonight were clean at handoff
(`feat/prepare-handoff-dev` at `e98fef3`, `fix/provider-stream-error-classification-20261018`
at `45138bb`). Every change is committed and pushed. No commit is untested. Section 3 marks the heads
without full verification.

## 3. Test results, bound to the tested head

Server full suite = Vivary preflight `--job test`, `pnpm --dir packages/workbench typecheck`,
the CI automation batch copied from `.github/workflows/ci.yml`, and
`pnpm --dir packages/workbench test:maintained`, on Node 24.20.0 with
`NODE_OPTIONS=--max-old-space-size=1024`.

| Head | Result |
|---|---|
| `f2ac6df` (#236 first head) | verify9: typecheck 0, CI batch 486 pass 0 fail, maintained 607 pass 0 fail |
| `a77bbd1` (#236 review 1 fixes) | New tests fail on `f2ac6df` source and pass on the fix (handoff 14/0, components 13/0). verify10: 486/0 and 614/0 |
| `31c5957` (#236 review 2 fixes) | Review-2 tests fail on `a77bbd1` and pass (components 14/0). verify11: 486/0 and 615/0. Claude review 3: 0 P1, 0 P2, 4 P3 (all deferred) |
| `e98fef3` (#236, merge of dev) | GitHub `ci`: success. Server verify12 **queued at handoff** (section 6). Claude review 4: 1 P2, 4 P3, threads open |
| `a2704fd` (#238) | GitHub CI green including Windows. Warm-up query 4,718 ms, timed queries 406 to 418 ms. Claude review 0 findings, Codex bot none |
| `9249cf5` (#239) | Server: the test file passed 15 of 15 runs. GitHub CI green. Claude review 0 findings, Codex bot none |
| `d5cb7dd` (#241) | `packages/mcp` tests with `mcp==2.2.0`: 31 pass, 1 skip (Windows only). create-vivary MCP tests: 4 pass. **No GitHub CI yet** (conflict). Claude review 1: 2 P2 (section 5) |
| `45138bb` (#242) | The 4 new cases fail on the previous patched Core and pass after (25/0). `test:native-chat` 164/0. Full suite: typecheck 0, 486/0, maintained 591/0. Claude review 1: 0 findings |

## 4. Approvals on record (owner, 2026-10-17 about 23:15 UTC)

- #237: approved and merged.
- #236, #238, #239: merge approved **conditionally**. Each exact final head must pass
  appropriate verification, the required independent review, CI and repository gates,
  with no blocker under the impact-based triage rule (section 8). Do not bypass or
  weaken a gate.
- #229 replacement: approved to prepare (#241). Its `ci.yml` change needs the owner's
  disposition of the review gate's workflow flag. **A merge of #241 is not yet approved.**
- #242: the owner asked for a confirmed blocker to be fixed with focused tests and
  review. **A merge of #242 is not yet approved.** Ask.
- Entire Gates needs the owner to approve each trail on the Entire web UI (the CLI
  approve returns HTTP 400). Pending trails: 144 (#236), 146 (#238), 147 (#239),
  148 (#241), 149 (#242). Verify with `entire trail show <n> --repo gh/vivary-dev/vivary`.
- Not approved: publication, releases, laptop configuration changes, new paid usage,
  credentials, deletion of dependency copies.

## 5. Open review findings and deferrals

### PR #236, review 4 on `e98fef3` (threads open, not yet triaged)

Comment IDs 4305334508 to 4305334516. Suggested triage, to verify against the code:

1. P2, Save writes back a stale row (4305334508). Same defect as #240 D, now with an
   ordinary scenario: Save in conversation A, then Prepare in conversation B before A's
   save returns. B's pending request is dropped. Data stays intact and recovery is
   Prepare again, but this is the strongest remaining candidate for a fix. Decide BLOCK or
   DEFER with a reproduction.
2. P3, Code submit always reports delivery (4305334509). Duplicate of #240 K.
3. P3, an existing STATE.md that is not editable is reported as missing (4305334512).
   New. Misleading message, nothing written.
4. P3, the Unavailable status offers no recheck (4305334515). New. UX only.
5. P3, a throw after the rename reports "previous version kept" and offers Retry
   (4305334516). New. Rare post-rename failure.

All 29 earlier #236 threads carry a written disposition and are resolved. The
dispositions are in each thread. Deferred items are in issue #240 (A to O), with code
path, trigger, impact and recovery for each, and a real-harness reproduction for A.

### PR #241, Claude review 1 on `d5cb7dd` (threads open)

1. P2 (4305339531), valid on reading: Doctor in `create_vivary.py` now hard-codes
   `sdk_compatible` to `(2, 2, 0)`, so the published `vivary-mcp` 0.1.3 with `mcp` 2.0.0
   reads `installed` but `sdk_compatible: false`. Likely fix: derive compatibility from
   the installed adapter's declared exact `mcp==` pin. Add a test for both adapter versions.
2. P2 (4305339602), the gate-file flag for `.github/workflows/ci.yml`. Only the owner can
   dispose of it. The test-file-list exception does not cover this change.

### PR #242

Claude review 1 on `45138bb`: 0 findings. Check the Codex bot before calling review complete.

### Other tracked limitations (preserve them in release notes)

- #228: one Code run at a time. Controlled concurrency is deferred.
- #235: deferred hardening from PR #227 (linked conversations).
- #240: deferred handoff hardening A to O.
- Linear MCP: consent and token refresh are unproven.
- Context Engine for Codex issue #4 (section 10).
- An untracked directory makes handoff freshness Unverifiable (#240 C).
- `LegalCopyright` in `vivary.exe` still reads Electron's "Copyright (C) 2015 GitHub, Inc.".
  The packager's `appCopyright` option would replace it. The owner must supply the text.

## 6. Detached jobs and the heavy lock at handoff

All on the build server, under the workspace root, each waiting on or holding the shared
heavy lock `ce-acceptance-20261009/.heavy.lock`. The Claude session holds no lock itself.
`.ce-pause` is absent.

| Job | What | Result location |
|---|---|---|
| verify12 | Full suite on #236 `e98fef3`, after relinking the shared store to #236's lockfile (relink done, test preflight 10/10 pass) | `tools/vivary-review/evidence/handoff-20261016/verify12/status`, then sum `ℹ pass` and `ℹ fail` in `maintained.log` and `ci-batch.log` |
| #242 Claude review | Finished 01:55 UTC, 0 findings | `tools/vivary-review/evidence/pr242-45138bb-review1-prep/` |
| #241 Claude review | Finished 01:56 UTC, 2 P2 | `tools/vivary-review/evidence/pr241-d5cb7dd-review1-prep/` |

A job is finished when its status file says `done` (verify) or `review-ended.txt`
exists (review), and its process has exited. Confirm the tested head before calling a
result a pass.

## 7. Environment and bootstrap

### Shared dependency store (read before any install)

On the build server, every Vivary worktree's `packages/workbench/node_modules/.pnpm` is a
symlink to the store of the checkout `vivary-unassigned-history-selection-20261012`.

- Never prune that store, and never delete a patched Core stage while any job runs. Two
  patched Core stages exist: `eaf3...` (current `dev` lockfile) and `02ad...` (PR #242).
- A frozen offline install in one worktree relinks every worktree's
  `@agent-native/core` to that worktree's stage. It did not prune the other stage on
  2026-10-18 (verified by before and after snapshots). At handoff, the links point to
  `eaf3` (for verify12).
- Before testing a branch, run its own install under the heavy lock:
  `pnpm --dir packages/workbench install --offline --frozen-lockfile --ignore-scripts`,
  after `vivary-preflight --storage-only --job patch`. Then confirm `vivary-preflight --job test` passes.
- One heavy job at a time. Cap test heaps at 1 GB. An unbounded assertion OOM-killed
  the server twice on 2026-10-17.

### Fresh cloud container (no server access)

- Node 24.20.0 exactly (ABI 137) and pnpm 10.33.2 (the CI pin). Python 3.11 or later for
  `packages/*` Python tests.
- `pnpm --dir packages/workbench install --frozen-lockfile`, then the commands in
  `.github/workflows/ci.yml` (typecheck, the CI batch, `test:maintained`), plus the
  focused targets named below.
- The independent-review publisher, the preflight tool, the package script and the #188
  diagnostic live only on the build server. A cloud session can implement and run tests,
  but the required `vivary/independent-review` status and Windows packaging need the
  server or the owner.

### Push and review routes on the build server

- Push from a worktree to the relay checkout, then from the relay to GitHub with the
  `gh` credential helper given on the command line. Refresh the relay's `dev` with
  `fetch origin dev:dev`. Worktrees whose git directory is `relay/vivary-v2` use the relay
  as `origin`, so refresh the relay first.
- Full verification: `tools/vivary-review/verify-retry-20261016.sh <checkout> <evidence-dir>`.
- Independent review: `tools/vivary-review/review-retry-20261016.sh <pr> <evidence-dir>`
  (Claude Opus, no Codex allowance). The Codex connector bot posts its own findings about
  10 minutes after each push. Wait for both before calling review complete.
- After resolving threads, rerun the "review gate" workflow for the current head.

## 8. Impact-based triage rule (owner, 2026-10-17)

Classify by demonstrated impact, not by the bot's priority label.

- BLOCK: credential or privacy exposure, loss or corruption of valid user data, broken
  ordinary supported workflows, or realistically reachable crash, retry or recovery
  failures with material impact. Fix before merge.
- DEFER: bounded hardening or unusual, malformed or hand-edited input where the app fails
  safely, keeps original data and exposes no secret. Track in an issue with reproduction,
  impact and recovery, then resolve the thread with the link.
- REJECT: invalid, duplicate or already fixed, with evidence.
- Every thread gets a written disposition before it is resolved. Uncertain material risks
  go to the owner as one batch.

## 9. Remaining Vivary tasks

Each task lists the expected outcome, focused tests, final verification and the
independent adversarial review. Run the review in a separate session that does not edit
the change, with the brief to find blockers under section 8.

### T1. Finish PR #236
- Outcome: every review-4 thread has a disposition. BLOCK items fixed, DEFER items added
  to #240. Merged under the conditional approval once trail 144 is approved.
- Focused tests: `pnpm --dir packages/workbench test:handoff`. For each fix, a test that
  fails on `e98fef3` and passes on the fix.
- Final verification: server full suite on the exact final head, GitHub `ci` and review
  gate green on that head, Entire Gates green.
- Adversarial review: Claude review of the final head plus the Codex bot, both complete,
  every thread resolved with its disposition.
- Unproven until the Windows window: a real-agent Prepare and Save, and the installed-Core
  cases (`prepareRequest` uses the returned `message` and `displayMessage`, an empty
  linked-target history includes `source.url`, and Core preserves `source_url`).

### T2. Merge PRs #238 and #239
- Outcome: both merged at their reviewed heads after the owner approves trails 146 and 147.
- Checks: confirm the heads are unchanged, the review gate and CI are green on them, and
  dev protection still requires only "required review gate" (not strict).
- #238's cause stays **unconfirmed**. Its diagnostics show a cold first query (4.7 s) but
  the failures needed more than 15 s.

### T3. PR #242 (Core patch fix)
- Outcome: review findings triaged. Merged only after the owner approves the merge and
  trail 149.
- Focused tests: `tests/native-stream-errors.test.ts` and `test:native-chat`, after
  relinking the shared store to the branch's lockfile (stage `02ad`).
- After #236 merges, merge `dev` into this branch (expect an `ARCHITECTURE.md` "Last change
  review" conflict, keep both entries newest first, regenerate the site with
  `node site/scripts/sync-docs.mjs`), then rerun the full suite and a review on that head.
- Adversarial review brief: confirm `http_429` for an in-stream `"code":429` still holds,
  and that no other caller depended on message classification.

### T4. PR #241 (replaces #229)
- Outcome: dev merged in (same conflict pattern), GitHub `ci` runs, including both wheel
  smokes, which install `mcp==2.2.0` offline. Review complete. The owner disposes of the
  `ci.yml` workflow flag and approves the merge. Then close #229 with a link.
- `ci.yml` change: 13 lines, version strings only, listed in the PR description.
- Evidence: `mcp` 2.0.0 carries GHSA-84m7-p3x7-pcfv, which affects only stateful
  Streamable HTTP servers. `vivary_mcp.py` uses only stdio, and neither package is in the
  Windows bundle. `vivary-mcp` goes to 0.1.4 (0.1.3 is published). The staged, unpublished
  create-vivary 0.4.4 carries its change without a new version.

### T5. Package final dev with Vivary branding (server, after T1 to T4)
- Outcome: a Windows package built from the final dev commit, with
  `build.json` matching that commit, a zip SHA-256, and the icon verified inside
  `vivary.exe`.
- Command: `python3 -I -B tools/vivary-review/package-dev-20261016.py <40-char commit>`.
- Icon check: read `vivary.exe` resources with `resedit` (the packager's library) and
  compare every icon entry with `packages/desktop/assets/vivary.ico`. On the old
  `3a0576ff` package the same check correctly shows Electron's four default icons.
- The copy to the owner's laptop and the hash check there wait for the owner.

### T6. #188 (performance, in release scope, ceilings unchanged: Native 0.75, Code 0.76)
- The bounded diagnostic ran 2026-10-17 22:48 to 2026-10-18 00:09 UTC, valid, outcome O3
  for both revisit scenarios on the build server (Code 0.748 and 0.726, Native 0.677 and
  0.697 on the guard endpoint). The endpoint change and the CI order do not explain the
  CI miss (Code 0.796 on a GitHub EPYC runner). The miss reads as runner sensitivity.
- Proposal awaiting the owner's acceptance: rebase `perf/responsiveness-188` (`f13862c`)
  onto dev (nine files conflict, the Core patch is the hard one), run the exact-head CI
  guard, and if Code misses again, find about 5 percent more real Code switching gain.
  Optional: rerun the unchanged guard pair on GitHub runners to measure noise (Actions
  minutes, needs the owner's yes). Never lower a ceiling.

### T7. Release documentation
- Outcome: install steps, release notes and known limitations for Vivary, reflecting the
  actual acceptance results. Draft content: Windows portable preview install (extract to a
  short path, keep the folder together, bring your own signed-in coding CLI), the merged
  features, and every limitation in section 5.
- Final check: each claim carries a source or a verified date. No publication.

### T8. Acceptance windows (owner present, not for Codex)
- Windows acceptance on the exact final package, including the installed-Core handoff
  cases and the packaged icon.
- Phone: does the `:8443` isolated preview iframe load, the status and body of
  `https://<host>:8443/_vivary/preview/bootstrap`, a listener on `127.0.0.1:42301`, and
  `chrome://inspect` over USB.
- Linear MCP option A: the owner names the workspace and creates one read-only key. Tool
  listing only, no model turn, then revoke the key and delete the connection in the same
  window. V13 wording keeps consent and token refresh unproven.

## 10. Context Engine

A separate handoff file is on branch `handoff/codex-cloud-20261018` in the private
`Jeff-Kazzee/context-engine` repository. Summary:

| Repository | dev | main |
|---|---|---|
| `Jeff-Kazzee/context-engine-claude` | `32304564a5b9e945790fdf880fa56b3dc24f76e3` | `bd4b181e53ac26c301a0de55b2abe1b074abd98a` |
| `Jeff-Kazzee/context-engine-codex` | `8ebbf48d0d2d846c7b10296f0bec8947d4b058e5` | `884145139365e7336c3ff7db70580572c306d2c7` |
| `Jeff-Kazzee/context-engine` (core) | none | `8360c58e695accfeb478c2521751ed831db3710a` |

Both distribution dev heads pass their Linux, macOS and Windows CI jobs. Core issue #26
(zombie lock) is fixed and waits for the owner to close it.

## 11. Finite release checklist

| # | Item | Owner | State |
|---|---|---|---|
| 1 | #236 review-4 triage, fixes, final verification and review, merge | Codex, then owner (trail 144) | Open |
| 2 | Merge #238 and #239 | Codex after owner approves trails 146 and 147 | Ready otherwise |
| 3 | #242 review, dev merge after #236, re-verify, merge | Codex, owner approves merge and trail 149 | Claude review clean, Codex bot to check |
| 4 | #241 Doctor P2 fix, dev merge, CI, review, `ci.yml` flag, merge, close #229 | Codex, owner approves flag, merge and trail 148 | Open |
| 5 | Package final dev, verify `build.json`, hash, icon | Server | Waits on 1 to 4 |
| 6 | `LegalCopyright` text for `appCopyright` | Owner | Question open |
| 7 | #188: accept the diagnostic report, then rebase and CI guard | Owner, then Codex | Report delivered |
| 8 | Windows acceptance on the final package | Owner present | Waits on 5 |
| 9 | Phone `:8443` window | Owner present | Waits on 5 |
| 10 | Linear MCP option A window | Owner present | Waits on 5 |
| 11 | Release documentation for both products | Codex | After 8 to 10 |
| 12 | Context Engine: close #26, Codex #4 wording, dev to main PRs, artifacts | Owner and Codex | Open |
| 13 | Publication decision for both products | Owner | Last |

## 12. Server evidence (private, summarized above)

All under `tools/vivary-review/evidence/` in the build server workspace:
`handoff-20261016/verify9` to `verify12`, `pr236-fixes-20261018`, `pr236-fixes2-20261018`,
`pr236-thread-resolution-20261018/receipt.json`, `repro240-20261018`,
`small-checks-20261018` (the retry check and the #239 loop), `stream-classification-20261018`
(before and after the patch refresh, with store snapshots), and the per-review
`pr<number>-<head>-review<n>` directories. The #188 run is in
`perf-188-diagnostic-20261017/evidence/run-20261017T224840Z/` (24 files, `SHA256SUMS`
verified). Keep that directory until the owner accepts the report.
