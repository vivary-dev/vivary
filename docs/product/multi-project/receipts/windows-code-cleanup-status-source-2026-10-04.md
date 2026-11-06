# Windows Code cleanup and status source verification

Checked 2026-10-04 against implementation commit
`e240f31ef3edde6a793ab086929195233bce542b` plus the closeout changes on
`fix/windows-code-cleanup-status`, based on
`97ca56b2f988dfec198d1d4961dd6f31a5ec5e33`. This is source verification for
the follow-up to historical, merged PR #173. The timeout-category review fix
and Wave 2 and Wave 3 runs below are on the closeout tree, not `e240f31`.
It does not establish packaged
Windows acceptance or acceptance of the complete desktop release.

## Implementation and failure boundary

The Code host retains fixed Windows scan-failure categories in a cleanup
refusal without storing raw scanner process output, stderr, or commands.
Unavailable verification continues to refuse new work. The scan timeout,
process identity checks, and cleanup decisions remain unchanged. The review
fix categorizes a deadline `TimeoutError`, or an `AbortError` caused by one,
as `timeout`; a plain `AbortError` remains `aborted`. A focused cleanup test
checks these three failure forms without retaining error text.

Code state now reads the selected run and history after awaited discovery,
permission, and host-state work. Runtime metadata and the recorded model for
follow-up use the refreshed selection, including when a newer conversation
becomes the default. Three held-discovery regressions change the run store
while model discovery is held and check that status, history, runtime metadata,
and the retained Codex model come from the refreshed selection.

The historical packaged Windows scanner failure was **not reproduced**.
Its original cause remains unknown. Simulated Windows scanner subprocesses
on Linux verify failure classification and refusal persistence; they do not
reproduce the historical failure or prove the real Windows scanner works.

## VPS results (2026-10-04)

Jeff authorized implementation, builds, and automated tests on a Linux VPS
for this task. The actual environment was Ubuntu 26.04.1 LTS, Linux x64,
Node 24.21.0 (ABI 137), pnpm 10.33.2, Python 3.14.4, and Git 2.53.0.
CI specifies Node 22 and Python 3.11; these results retain that environment
difference and are not GitHub Actions results.

Dependencies were installed with
`pnpm --dir packages/workbench install --frozen-lockfile`, using
project-local store and caches. The existing permitted
`better-sqlite3@12.11.1` install script and main binding definition were
inspected. Other dependency build scripts remained blocked.

The focused Workbench tests used
`pnpm --dir packages/workbench exec tsx --test --test-concurrency=1`
with the files listed below. Every command in this table exited 0.

| Check | Command or test files | Actual result | Execution |
| --- | --- | --- | --- |
| Post-fix host, cleanup refusal, and status regressions | `tests/code-execution-host.test.ts tests/local-code-cleanup-refusal.test.ts tests/code-state-snapshot.test.mjs` | 74 passed, 0 failed, 0 skipped (46 host; 25 cleanup refusal; 3 status) | Wave 2 |
| Host regressions after DOMException polish | `tests/code-execution-host.test.ts` | 46 passed, 0 failed, 0 skipped | Wave 3 |
| Baseline affected host and agent | `tests/code-execution-host.test.ts tests/local-code-agent.test.ts` | 61 passed, 0 failed | Wave 1 (`e240f31`) |
| Workflow contract | `python scripts/check_ci_workflow.py`; `python scripts/tests/test_ci_workflow.py` | Contract passed; 28/28 tests | Wave 1 (`e240f31`) |
| Workbench types | `pnpm --dir packages/workbench typecheck` | Exit 0; printed `BETTER_AUTH_SECRET`-unset production configuration errors for build and runtime phases | Wave 2 |
| Doctor | `pnpm --dir packages/workbench run doctor` | Clean, no findings | Wave 2 |
| Source navigation | `python -B scripts/check-source-navigation.py --check`; `python -B scripts/tests/test-source-navigation.py` | Clean; 16 passed, 2 Windows-only junction tests skipped | Wave 1 (`e240f31`) |
| Package documentation | `python scripts/check_package_docs_parity.py`; `python scripts/tests/test_package_docs_parity.py` | Nine manifests match; 10/10 tests | Wave 1 (`e240f31`) |
| Documentation links | `tests/documentation-links.test.mjs` | 3 passed, 0 failed | Wave 1 (`e240f31`) |
| Existing commit HLDD | `python scripts/check_hldd.py --base 97ca56b2f988dfec198d1d4961dd6f31a5ec5e33 --head HEAD` | One introduced commit passed; covers only `e240f31`; the closeout commit is checked separately | Wave 1 (`e240f31`) |
| Text hygiene | `python scripts/check_line_endings.py`; `git diff --check` | Passed | Wave 2 |

Typecheck's exit status does not establish production configuration or runtime
health. No deployment configuration or credentials were changed. Commands,
exit codes, durations, diagnostics, and individual logs are retained outside
Git in the task's private `logs/wave1/`, `logs/wave2/`, and `logs/wave3/` evidence directories.
The post-fix Wave 2 run covers only the three test files listed in its row,
typecheck, Doctor, line endings, and diff hygiene; documentation sync is
recorded separately. The 61-test host/agent result is baseline Wave 1 evidence
on `e240f31`, not a post-fix rerun of `local-code-agent.test.ts`.

Previously reported Zo results were status regressions 3/3, cleanup refusal
25/25, affected host/agent 61/61, workflow contract 28/28, typecheck, Doctor,
source-navigation, and documentation checks. Those remain **historical Zo
evidence**. The table above records distinct VPS executions and identifies
their wave. Neither set establishes a Windows or GitHub Actions pass.

## Capture and remaining delivery

`e240f31` has no `Entire-Checkpoint` trailer. No implementation transcript
association or delivery is claimed. The native session metadata check found
a Codex session, but session-current and status disagreed on its liveness,
and the checkpoint list was empty with remote delivery unavailable.
Successful new checkpoint capture remains unverified. Existing reviewer-only
checkpoint evidence stays review evidence. The upload hold remains in place.

Source publication, a ready PR into `dev`, Jeff's human Entire approval,
and laptop packaged acceptance remain separate required gates.

No replacement package was built in this check. The supported Linux
cross-package command is
`npm --prefix packages/desktop run package -- --windows-x64`. Installed
prerequisites are incomplete: the path requires Workbench built with exactly
Node 24.19.0, while this host has 24.21.0; the default Python used for these
checks is 3.14.4 and no `python3.12` executable was found on PATH. Desktop
dependencies and built Workbench output are absent.

Windows-only workflow jobs and real desktop acceptance were not run.
Package identity and transfer checks, real desktop cleanup, Stop, and restart
remain a pending laptop gate. The earlier failed package, profile, and evidence
must remain preserved until a replacement passes its affected journey.
