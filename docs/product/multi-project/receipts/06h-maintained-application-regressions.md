# Maintained application regression checks verification

Evidence-record: 06h
Date: 2026-09-18

[Issue #22](https://github.com/vivary-dev/Vivary-New/issues/22) and
[PR #62](https://github.com/vivary-dev/Vivary-New/pull/62) own acceptance and
delivery. PR #62 merged into dev on 2026-09-18. Jeff accepted the issue on
2026-09-18 after the merged result was verified end to end.

## Verified behavior

- Every maintained Workbench check has an ordinary package command:
  `pnpm --dir packages/workbench test:maintained` runs the registry actions,
  registry store, registry HTTP, project services, shell, both mutation
  suites, and chat-title in sequence from a clean environment, with
  disposable proof roots and a disposable database, and cleans up its
  children. The command completes in about two minutes on Zo under Node 22.
- The registry-actions metadata check inspects the private registry actions
  by name instead of asserting that the app actions folder is absent.
- The project-services check expects a cold-start gate on every project
  action path and a service route only on the four paths the plugin serves
  itself, matching the reconnection paths added in PR #45.
- The chat-title suite disables framework bootstrap plugins explicitly, uses
  a disposable database, closes it afterwards, and exits in seconds instead
  of running to the runner's limit.
- The mutation suites always place the database their parent and forked
  children share inside the fixture root they remove; an inherited
  `DATABASE_URL` is never used.
- The legacy Doctor snapshot comparison settles its capture before comparing,
  so read-only Doctor runs no longer look like writes under load on Zo's 9p
  filesystem; all assertions stay byte-for-byte and timestamp-for-timestamp.
- The three Core chmod refusal proofs skip with a precise reason when the
  process is UID 0, and the fsmonitor hook proof skips only when its own
  probe shows the temp directory refuses execution; product assertions are
  unchanged. The Core README documents the supported unprivileged invocation.
- The proof-only 05b GUI runner test was removed with its obsolete assumption
  and replacement coverage recorded in the packet log.
- CI runs the maintained checks in the tests job.

## Checks and limits

- Merged dev at `f3b87ba`: Zo CI 63 of 63 applicable Linux steps against the
  session-start base; GitHub Actions green on the dev push including both
  Windows jobs; `test:maintained` green from a clean environment with no
  repository residue; Core as root 869 passed and 5 skipped with reasons.
- Independent review: Codex (GPT-6 Astra) returned seven findings on PR #62;
  each was fixed in its own commit before merge.
- Known host limits stay recorded, not claimed away: the Node major must
  match the one that built the native SQLite module (CI pins Node 22); Core
  creates an empty `data/` directory under the working directory, which the
  package scripts keep inside `packages/workbench` where it is ignored; the
  MCP adapter's cancellation test has a pre-existing timing race that passes
  on rerun and is a candidate follow-up issue.

## Acceptance

Jeff accepted issue #22 on 2026-09-18. The packet moves to done with this
receipt as its evidence.
