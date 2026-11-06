# Desktop quit and Windows crash cleanup

Verified: 2026-10-03. Issue: [#138](https://github.com/vivary-dev/vivary/issues/138). PR: [#173](https://github.com/vivary-dev/vivary/pull/173).
Accepted runtime source: `4f7a039407e63bbbcb7717ffebf767a523f5c365`.
Integrated base: `0794b941e3735db5ff7ff0e1d98903ea2706c5dc`.

**The fresh private Windows package passed all required shutdown and preview-cleanup journeys.** This supersedes the earlier `d8cb7665` server-first failure below. Documentation-only closeout preserves the tested runtime. Release authority and the contributor approval and session-capture gates are separate from this acceptance record.

## Final 4f7a0394 acceptance

Zo built from clean source after installing the exact frozen PR #175 patch and lockfile. The installed Core patch hash begins `c8415a61`. No dependency versions changed during integration. The actual TypeScript checker, all four applicable Zo CI waves, and all nine [GitHub CI jobs](https://github.com/vivary-dev/vivary/actions/runs/37130832501) passed. The real built desktop server exited with code zero in 17.08 ms. Browser access, owner sign-in and hosted MCP application checks passed.

The Windows ZIP is 222,641,997 bytes with SHA-256 `fe613b34d9f3c52883d2218c65db34f15e3eb14e26622da48dedec800e65969b`. Transfer hash, archive integrity, extraction bounds, preview-owner bridge digest and license passed. Package metadata records clean `4f7a0394` source, zero tracked overlays and a matching source snapshot. Its Workbench output remains labeled prebuilt with `sourceCommitVerified: false`. The separate clean build and built-server receipts establish the source-to-output relationship. Runtimes are Node 24.19.0, Electron 44.3.0 and Python 3.12.14.

| Fresh packaged journey | Main process exit | Complete observation | Result |
| --- | ---: | ---: | --- |
| Idle, normal window close | 573.01 ms | All package processes gone in 760.50 ms | Passed |
| Active scheduled run, normal close | 318.73 ms | All package processes gone in 449.30 ms | Passed |
| Active webhook run, normal close | 301.20 ms | All package processes gone in 454.31 ms | Passed |
| Active preview, normal close | 354.40 ms | Package processes gone in 522.81 ms. Full 14-identity and closed-port observation in 2,023.78 ms | Passed |
| Abrupt Electron-only termination with active preview | Deliberate root termination | All 14 recorded identities gone and preview port closed in 1,758.38 ms | Passed |
| Abrupt server-only termination | Electron remained alive | All 16 recorded server-tree identities gone in 612.23 ms | Passed |

The active preview used the unchanged registered test root and a real pnpm command, command shell, Node HTTP preview and ordinary non-detached Node child. The server-first journey also kept a real Code worker and an offline synthetic Codex CLI active, and held an actual bundled Python catalog command through the existing bounded observer. The preview Python owner, manager, shell, preview, child, Code worker, synthetic CLI and original Python command were all gone before manual cleanup. The observer exited zero. Subsequent cleanup closed only the surviving Electron application. Normal and parent-loss checks likewise recorded identities and results before their cleanup blocks.

Schedule and webhook checks used separate fresh profiles and a synthetic loopback response stream. Each required the actual run and linked agent to be running before normal close. SQLite then recorded that same run as interrupted and its agent as aborted for shutdown. The scheduled run lease was deleted, with no held lease remaining. The webhook task returned from processing to pending, refunded its claimed attempt from 1 to 0, retained its dispatch count and had no completion time. These checks establish application dispatch, persistence and shutdown, with no claim of real provider or external tool effects. They do not add acceptance for the separate #141 Details-refresh journey.

The original registered directory, original profile and grants were preserved. All five original file hashes and the exact five-file count matched after restoration. Six temporary fixture files were removed. Three pnpm-generated files were archived and hash-checked before removal. The synthetic CLI mode was restored, and the application, preview and gateway fixtures were stopped.

## Review corrections and verification limits

The [Windows job](https://github.com/vivary-dev/vivary/actions/runs/37130832501/job/111225453837) passed two startup-cancellation tests, the shutdown suite with 28 passes and one unrelated skip, and Core with 806 passes and 71 skips. Its actual preview server-death, Stop and natural-command-exit cases each recorded no surviving descendants. The earlier full Linux Core run on unchanged Core source recorded 870 passes, seven skips and 40 subtest passes on an existing supported tmpfs mount. The failed earlier run on an unsupported filesystem remains failed setup evidence.

The startup callback refuses command execution only when host EOF or a pipe failure has already been observed before resume. Its native regression uses an actual closed pipe and suspended process, with a control that executes when only the callback is removed. It does not establish an atomic guarantee against host death after that check. The no-PID spawn regression first failed with the port still reserved, then passed after the non-launch released only its own reservation. A real launched-owner cleanup failure remains retained and unavailable. The public schema and Windows UI identify the PID as the preview owner. The Core test adds its own source import path, and isolated collection passes.

Three private observer issues were corrected without changing the product or rebuilding the package. Windows PowerShell 5 lost a redirected child's exit code when first read after exit. Retaining its handle preserved the actual nonzero control result. A process sample raced an exiting process, so polling now compares one PID and creation-time snapshot and retains unverifiable identities. PowerShell 7 converted JSON timestamps to typed dates, and reparsing their culture strings shifted UTC by six hours. Typed UTC normalization preserves the exact identity checks and tolerance. The corrected final crash wrapper exited zero. Earlier attempts remain failures or pre-action refusals, even where their process observations showed no survivors. A renderer-startup refusal was retried only after readiness, before any termination.

The separately approved PR #178 dependency correction is integrated. Site audit and build passed without PR #176's rejected waiver. PR #175 is integrated with its patch, lockfile and tests unchanged. Historical failures, superseded candidates and their original limits remain below.

## Historical checkpoints

The following records describe earlier source boundaries. Their unresolved gates and remaining-work statements apply to those earlier checkpoints, not to the accepted `4f7a0394` runtime above. The last failed packaged runtime was `d8cb7665a2d09a0ab46af137db25938ca0f23c8f` on base `c17a8cae993d6abb3a87c4949b2a047abb462224`.

## Approved containment implementation

The owner approved the bounded Core reuse design on 2026-10-03. Workbench now starts one non-detached Python owner for each active Windows preview. It uses the bundled interpreter and Core's extracted Windows process scope. The scope creates the approved package manager suspended, assigns it to a kill-on-close job, and only then resumes it. Assignment failure aborts and reaps the suspended child. Existing package-manager arguments, reviewed folder, sanitized environment, raw stdout/stderr and empty manager stdin are preserved.

The owner's stdin carries no messages. EOF, input failure or manager exit initiates cleanup. A zero owner exit means the job's active-process count reached zero within the cleanup deadline. Workbench observes child and stdin errors from spawn, closes the lifetime pipe on Stop, and uses the same cleanup promise for natural exit. A failed or unverified cleanup stays unavailable. Readiness, socket ancestry and the closed-port assertion retain their existing owners. The bundled runtime records the owner bridge's path, digest and license. No new dependency, service, host-security setting or control protocol was introduced.

The new native tests retain the actual pnpm/cmd/preview/ordinary-child chain and add Stop and natural command exit alongside server death. The ancestry observer reads only process id, parent id and name, with a 15-second bound for a cold Windows provider. Required readiness, each real ancestry edge and the five-second no-survivors assertion are unchanged. Separate Core tests hold the Popen handle during the job-empty check and verify that failed job assignment never executes its suspended child. The documentation-head fa1af27c run timed out in its earlier five-second ancestry observer before termination, so it is not a second cleanup regression result.

Independent review found no actionable blocker in the implementation. Zo checks passed: 12 capped-runner tests, 10 runtime packaging tests, 14 preview and isolation tests, Python syntax and diff hygiene. The actual TypeScript checker ran in the development environment with `--noEmit --pretty false --extendedDiagnostics` and exited zero after checking 3,369 files. The typecheck wrapper's earlier production-auth diagnostic is not counted as checker proof. The two native Core tests correctly skip on Linux. Native Windows CI and a fresh clean-source package remain pending. Historical observations below retain their original source boundaries.

## Candidate and normal quit

Zo built Workbench from clean source, checked the real built server, and packaged Windows x64 from that same revision. The built server exited normally in 18.29 ms. Browser access, owner sign-in, and hosted MCP application checks passed. The ZIP is 222,625,228 bytes with SHA-256 `b7b387d1209098bea4b1c0d7fa62a54052653119902ee06f52523b743aef762a`. Transfer hash, archive bounds and packaged source metadata passed. Metadata reports clean source, zero overlays and a matching source snapshot. Workbench output remains marked prebuilt with `sourceCommitVerified: false`. The separate clean-source build receipt supplies that relationship. Runtimes are Node 24.19.0, Electron 44.3.0 and Python 3.12.14.

| Fresh d8cb7665 journey | Main exit | All observed package processes gone | Result |
| --- | ---: | ---: | --- |
| Idle, normal window close | 302.63 ms | 607.83 ms | Passed |
| Active scheduled run, normal window close | 391.24 ms | 634.77 ms | Passed |
| Active webhook, normal window close | 443.78 ms | 729.21 ms | Passed |

The schedule and webhook used separate fresh profiles. Each check required a real running automation and linked running agent plus an open response stream before closing the app. SQLite then recorded the same run as interrupted and the agent as aborted for shutdown. The scheduled run lease was deleted, with no held lease remaining. The same webhook task returned from processing to pending, refunded its claimed attempt from 1 to 0, kept its dispatch count, and had no completion time. The held response was synthetic and loopback. Application dispatch, persistence and shutdown were real. No provider or tool side effects are claimed.

The first scheduled attempt stopped in its read-only observer before active-run proof because the fresh profile had not created its lazy automation tables. Later inspection of the same database confirmed their creation. The observer now treats only missing startup tables as empty collections. It still requires a running run and agent before quit and every persisted outcome afterward. That failed attempt and its cleanup remain recorded separately. An unexecuted webhook attempt sharing the scheduled profile was canceled to avoid ambiguous stream attribution.

## Reproduced server-first failure

The actual packaged application revalidated an existing registered test root through its supported GET catalog route. Its original directory and grants were unchanged. The approved preview action started a real pnpm script, which started a Node HTTP preview and an ordinary non-detached Node child. The same server also ran a real Code worker connected to an offline synthetic Codex CLI. Its original-runtime adapter started the actual bundled Python catalog command, briefly suspended by the existing bounded external observer.

After recording the live process identities, the observer terminated only the server. It did not use a tree kill or terminate Electron for this observation. Electron was still alive five seconds later.

| Process class | State after 5,004.02 ms |
| --- | --- |
| Desktop server, pnpm launcher and command shell | Gone |
| Code worker and synthetic CLI | Gone |
| Bundled Python command | Gone |
| Actual preview Node and its non-detached Node child | **Still alive** |
| Two related console hosts | Still alive |

The preview chain was server -> pnpm -> command shell -> preview Node -> Node child. The Python observer recorded exit 558 ms after suspension, before its 60-second resume deadline and the command's 30-second deadline. The process-tree result itself is the failure evidence. The observer's final wrapper exit was confirmed separately during cleanup.

Libuv's per-process job protects direct non-detached children, but that did not clear the complete shell-launched preview chain in this observation. The test does not establish that detaching the server introduced this failure compared with the earlier launch configuration. It does establish that the current package fails server-first descendant cleanup. [Pinned Node implementation](https://github.com/nodejs/node/blob/v24.19.0/deps/uv/src/win/process.c#L65).

Proof and failure receipts were written before manual cleanup. That separate cleanup removed the recorded survivors, closed the owned Electron process and confirmed observer exit. It is not product cleanup evidence. The original five fixture files retained their hashes. Six temporary fixture files were removed. Three pnpm-generated files were copied to private evidence, hash-checked and removed by exact path. The original registered directory and grant remained intact. The synthetic CLI mode was restored.

## Regression and CI evidence

The launch correction follows a separate behavioral regression that exercised the real fork call. It first produced 19 passes and one failure at the Windows detachment assertion, then all 20 cases passed. Independent source and documentation review found no actionable issue before the new native crash observation.

Native Windows [job 111130614007](https://github.com/vivary-dev/vivary/actions/runs/37097593805/job/111130614007) passed all 13 lifecycle cases, including controlled pending and rejected cleanup, real tree kills, parent loss before and during shutdown, successful cleanup, and a root-only-kill control requiring its detached descendant to survive. Its combined suite had 25 passes and one unrelated skip. Earlier targeted mutations detected missing fallback creation, missing tree dispatch and parent loss after a prior shutdown request. These controlled cases do not substitute for packaged preview cleanup.

The same clean source passed the selected Zo guards, workbench and maintained waves. The site wave failed only its dependency audit. The GitHub run had eight successful jobs and a failed site job. The separate [PR #176](https://github.com/vivary-dev/vivary/pull/176) proposes a temporary GHSA exception, not a dependency fix. Its separate owner approval is not supplied by this work. No audit waiver was applied here.


## Launch-boundary design decision

Test-first commit `2d3a251b` added a native regression through the actual preview service and real pnpm launcher. Its [first Windows job](https://github.com/vivary-dev/vivary/actions/runs/37105543687/job/111153227260) failed during setup. Node's bundled Corepack shim tried to fetch pnpm while preview networking was disabled. No readiness, ancestry or cleanup assertion was reached. That failure is preserved separately.

Test-only correction `3a349b66` locates the existing global pnpm installation, verifies its version against the CI pin, and scopes the real resolver to that directory. It adds no installation or network access. In [Windows job 111156476327](https://github.com/vivary-dev/vivary/actions/runs/37106673797/job/111156476327), the HTTP preview became ready and all five live process identities and ancestry edges passed. The test then killed only the service process. It failed at the intended five-second assertion that server death must clean the complete pnpm/cmd/preview/ordinary-child chain. The preview and ordinary child survived. The diagnostic and assertion preceded manual cleanup, which checked the command shell and every other recorded process. All 13 earlier lifecycle cases passed. The combined suite recorded 25 passes, one expected regression failure and one unrelated skip.

Independent review found no launch-option correction that preserves arbitrary supported npm, pnpm and Bun scripts. The launcher already uses `shell: false` and a non-detached Windows child. Another cmd wrapper moves the uncontained hop. Direct script execution or a substitute shell changes package-manager or command semantics.

| Containment option | Required change |
| --- | --- |
| Reuse [Core's Windows process scope](../../../../packages/core/vivary_core/workspace_observe.py) | Extract its suspended launch and kill-on-close job into a supported preview adapter. A persistent Python owner must retain the job handle and bridge output, exit and Stop. |
| Own the job directly from Node | Add a native binding or helper for suspended creation, job assignment and resume. This adds another native integration to package and maintain. |

**Recommended owner decision:** authorize a separate bounded design and implementation using the existing Core containment mechanism. Its private bounded-command API is not a preview API. The owner must approve the persistent process owner, streaming lifecycle and packaging contract first. No job owner, supervisor, native dependency or runtime change was introduced in this wave. The original failed-cleanup fallback and parent-loss behavior remain unchanged. PR #173 stays blocked.

## Remaining work and handoff

The approved implementation must pass actual native Windows CI, including the held-handle and before-execution assignment checks. Then a fresh clean-source package must pass active-preview normal quit, abrupt Electron loss and server-first termination while Electron remains observable. Each journey must record the original process identities and the result before manual cleanup. Idle, schedule and webhook persistence, final CI, review and Entire gates remain required. The existing registered test root and its grants must be retained, with its original file hashes restored.

Jeff rejected PR #176's temporary audit waiver. The separate dependency-remediation lane must supply a reviewed real fix, which must be integrated before final candidate gates. No waiver is supplied by this work. The controller owns the supported local session-capture refresh. Source mirroring does not establish session capture. No merge, release, deployment or branch deletion has occurred.

## Historical 5ce5468c acceptance

The following observations retain their original candidate boundary.

Date: 2026-10-02, America/Denver. Active Windows checks ran on October 3 UTC.
Issue: [#138](https://github.com/vivary-dev/vivary/issues/138)
Candidate source: `5ce5468c95f3858dce712b89fb4fa135f916fb45`
Base: `c17a8cae993d6abb3a87c4949b2a047abb462224`

### Change and candidate

The dedicated desktop launcher sets the existing standalone process marker before loading the server. Its lifecycle exits after local-work cleanup and, on success, Nitro close. On this candidate, rejected cleanup waited for other stops before exiting with failure. Hosted lifecycle ownership stays with its host. The desktop's 15-second fallback remained configured, but review subsequently found that Windows failure exit could remove the live server PID needed by `taskkill /T`. Windows failure-fallback preservation remains pending. The [Windows fallback review](https://github.com/vivary-dev/vivary/pull/173#discussion_r4170897427) and [owner handoff](https://github.com/vivary-dev/vivary/pull/173#issuecomment-5964016108) track the separate correction. The successful normal-quit observations below remain evidence for this candidate. This candidate includes the merged #139 scheduler lease patch.

Zo built Workbench and packaged Windows x64 from the same clean source. The ZIP is 222,623,411 bytes with SHA-256 `d8952c3b4c141824ffb3d2d12804f1c82b5d031fb52e30ab486068946f7ae1f3`. Archive integrity passed. Metadata records `sourceDirty: false`, zero tracked overlays, and `commitMatchesPackagedSource: true`. Node is 24.19.0, Electron 44.3.0, and Python 3.12.14. Workbench output remains `prebuilt` with `sourceCommitVerified: false`. The separate clean-source build record supplies that relationship. The verified candidate is a private preview with no release publication.

### Windows observations

Normal window close requested quit. Timing starts at that request. The observer followed candidate process identities.

| Journey | Main process exit | All observed candidate processes gone |
| --- | ---: | ---: |
| Earlier `042dce25` idle baseline | 16,359.15 ms | 16,687.44 ms |
| Combined `5ce5468c` idle | 4,181.73 ms | 4,456.45 ms |
| Combined `5ce5468c` active scheduled run | 329.85 ms | 582.87 ms |
| Combined `5ce5468c` active webhook run | 309.92 ms | 559.27 ms |

Every combined observation ended with no surviving candidate process. These measurements establish the named runs, rather than a close-time guarantee. Before both active quits, SQLite held actual running automation and agent rows, and the local gateway recorded an open response stream. Its stream closed during shutdown.

After scheduled quit, the same run was `interrupted` with `background_automation_interrupted` and a non-null finish time. Its agent was `aborted` for `shutdown`. The run lease was deleted. The global scheduler lease's owner and expiry fields were null before and after quit. This observes #139's run-lease release at quit, without establishing its complete two-automation Windows journey.

After webhook quit, the same run was interrupted with that error and its agent aborted for shutdown. The same task changed from `processing` to `pending`. Its `attempts` changed from 1 to 0, refunding the claimed attempt. `dispatch_attempts` stayed 1 and `completed_at` stayed null. This matches Core's existing quit regression that requires a normal quit not to spend an attempt.

### Fixture corrections and verification

The first webhook evidence helper incorrectly required an equal attempt count and reported a false failure. It was corrected against `packages/workbench/tests/automation-quit.test.mjs`, in the case that returns an interrupted webhook call to the queue. Read-only validation of the recorded before and after states passed for both journeys. A control removing persisted interruption was rejected. No application fix or repeated provider call was needed for this correction.

An offline schedule-pause helper failed before mutation because its requested `closeDbExec` export was absent. Pause was not verified, and the schedule remained enabled. The webhook was created and closed before the next launch's first scheduler tick. The recorded state showed one current active webhook run and the previous scheduled run already interrupted.

The actual built server exited normally in 62.09 ms on `5ce5468c`. Three hosted application checks and 43 targeted regressions passed. GitHub reported nine jobs green on that revision, and Entire trail98 recorded one approval. Final CI on the later acceptance documentation commit remains pending and must be reported separately.

### Evidence boundary

The held Builder response was synthetic and loopback. Application startup, SQLite writes, dispatch, interruption, requeue, lease release, and Windows shutdown used the real packaged application. No real provider or tool side effects are claimed. Stuck Windows cleanup was not exercised. The existing controlled regressions did not establish preservation of the Windows fallback after cleanup rejection. That review finding requires separate regression coverage and acceptance.

Webhook relaunch and redelivery, full #139 Windows acceptance, and #140 and #141 remain separate. Historical receipts retain their named-candidate evidence. This receipt does not establish a finished desktop release. Package records, process observations, SQLite snapshots, gateway logs, and corrected validation stay private. No private host path, profile identity, credential, or raw webhook payload is included here.

## Historical parent-loss correction evidence

The complete earlier section below records the boundary investigation before the fresh d8cb7665 packaged journeys. Its pending-acceptance statements describe that earlier point in the work. The current results and unresolved server-first defect above supersede those status statements. The failed native cases and fork comparison remain evidence.

### Subsequent Windows parent-loss correction

The first parent-loss implementation passed 12 Zo cases and three targeted mutations, but its three new native Windows cases failed. Windows killed the non-detached fixture server when its intermediary parent died, before cleanup could run. The fixture now detaches its server and descendant on Windows. A negative control must leave the descendant alive when only the server is killed. Native Windows execution remains a distinct gate.

A controlled native Electron comparison then found the same problem in the production launch options. It used an unchanged copy of the packaged Electron 44.3.0 executable, SHA-256 `c86ca45c26e900916a285830bb6c2a84716d1a60266046777ce5bc399b05df87`, ordinary Node 24.19.0, and owned fixture processes. Killing only the Electron parent with the previous launch options killed the server before its disconnect callback. The detached descendant survived. With server detachment enabled, disconnect was recorded, both processes remained alive one second later, and the real 15-second self-tree fallback removed both by 15,444.20 ms. Recorded fixture processes were checked and cleared after each case.

The production correction detaches the server on Windows while preserving IPC, hidden windows, the normal parent fallback and its PID guard. These fixture observations establish the Windows launch boundary and tree operation. Fresh packaged idle, scheduled, webhook, preview-descendant and parent-loss acceptance remain pending. No synthetic dependency response is claimed as a real provider response.
