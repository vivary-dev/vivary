# Coding worker environment and startup

Issue [#98](https://github.com/vivary-dev/Vivary-New/issues/98) asks for the coding worker, which
starts Codex and Claude Code, to start without the server's credentials. Issue
[#117](https://github.com/vivary-dev/Vivary-New/issues/117) asks for a worker that reports ready
after its startup deadline to be stopped without starting its run. This receipt records the change on
`fix/coding-worker-without-credentials` and its verification.

Delivery status: PR #125 merged into `dev` as `9cf1ed7` after all eight checks passed, including
Entire Gates, and the owner closed issues #98 and #117 on 2026-09-27.

## Source and artifacts

- Source: `fix/coding-worker-without-credentials`, branched from `dev` at `44fa147`. `752a849` adds
  the failing #98 tests, and `96c64cc` fixes #98. `b794fcc` adds the failing #117 test, and
  `0ff66f2` fixes #117. `987b5f5` and `d5c960c` hold the first review fixes, and `2956463` hardens
  two tests after the re-review.
- Package before the fix: the unpublished `ec82a872` package from the
  [#113 receipt](113-webhook-automations.md).
- Package after the fix: `Vivary-windows-x64-d5c960ce.zip`, 223,878,950 bytes, SHA-256
  `ab6fbcd693dfe643c5befcb2a2dc1d4d653e5fc317d61bb14238370ab786015c`, built on Zo from `d5c960c` and
  checked on Zo and the Windows laptop. `2956463` and the commit that adds this receipt change only
  tests and documents.
- Codex: its own ChatGPT sign-in, the YOLO execution mode, and the model GPT-6-Astra. YOLO gives
  Codex full host access, so its sandbox could not hide what the probe read.
- Launch environment: an invalid OpenRouter-shaped key and a random probe token under
  `VIVARY_PROBE_TOKEN`. No value was printed.

## How it works

- `code-execution-host.ts` forks the coding worker with `codingRuntimeEnvironment(process.env)`, the
  filter the Codex launch and the CLI status checks use, and still removes `VIVARY_DESKTOP_HOST` and
  `VIVARY_STANDALONE_HOST`. The worker starts without the sign-in secret, the database URLs, provider
  keys, or a user's own token variables.
- A worker that reports ready after the host asked it to stop never receives its run. The 15-second
  startup deadline or the owner's abort makes that request. The deadline error reads "The coding
  worker did not start within 15 seconds.", and the run records it as its failure.

## Why the worker needs no handoff

Issue #98 proposed that the server resolve Core's merged MCP configuration and pass it to the worker
over IPC. The investigation for this change read `@agent-native/core` 0.176.5 as installed with
Vivary's patch and found that the worker needs none of it:

- The worker starts only Claude Code runs and native Codex runs.
- Native Codex returns into `executeCodexAppServerRun` at line 1304 of
  `dist/cli/code-agent-executor.js`, before `buildMergedConfig` at line 1316. Codex uses its own
  configuration and its own MCP servers.
- Claude Code gets `--strict-mcp-config` with no MCP configuration
  (`dist/cli/claude-code-participant.js`, line 117).
- Runs are stored in files under `AGENT_NATIVE_CODE_AGENTS_HOME`, which the filter keeps, not in the
  database.

So the worker needs no credential, database, or MCP secret, and the filtered fork alone fixes the
defect.

## Verification on Zo

- The #98 host test forks a disposable worker through the host with random values seeded under
  `BETTER_AUTH_SECRET`, `DATABASE_URL`, `OPENROUTER_API_KEY`, and a random credential-shaped name. A
  child of the worker reads the worker's `/proc/<pid>/environ`. On `752a849` it found all four seeded
  names (7 tests, 6 pass, 1 fail). On `96c64cc` the file passes 7 of 7.
- `code-run-worker.test.ts` runs the real worker source under tsx with a stub Claude CLI that walks
  its ancestors below the test process. It failed on `752a849` because an ancestor held a
  credential-shaped name, and it passes on `96c64cc`. It also fails if the worker writes any file in
  the `data` folder of its working folder. A throwaway probe that added one database query to the
  worker failed on that check.
- The #117 test forks a worker that reports ready only after a stop request. On `b794fcc` both
  subtests, startup deadline and abort, failed because the worker received its run (10 tests, 7 pass,
  3 fail). On `0ff66f2` the file passes 10 of 10. With the ready guard removed locally on `2956463`,
  both subtests fail again after the check that the worker sent its late ready passes.
- Zo CI on `d5c960c` passed workflow lines 112 to 115 (69, 392, 34, and 67 tests), the Python suite,
  the workbench typecheck, and `test:maintained`.

## Packaged Windows check

The owner's Windows laptop ran each package once with the same launcher and profile. In a test
project, a new Code conversation asked Codex to run a probe script. The probe walked up from its
shell and read the names, never the values, in each ancestor's environment block. It counted the
names that the credential rule matches.

| Depth | Process | Before, `ec82a872` | After, `d5c960ce` |
| --- | --- | --- | --- |
| 1 | Tool shell, `powershell.exe` | 57 names, none credential-shaped | 57 names, none credential-shaped |
| 2 | Codex, `codex.exe` | 99 names, none | 99 names, none |
| 3 | Codex's Node wrapper, `node.exe` | 97 names, none | 97 names, none |
| 4 | Coding worker, `node.exe` | 110 names, 10 credential-shaped | 100 names, none |
| 5 | Server, `node.exe` | 108 names, 10 credential-shaped | 108 names, the same 10 |
| 6 | Desktop process, `vivary.exe` | 80 names, 3 credential-shaped | 80 names, the same 3 |

- The ten names were the sign-in secret `BETTER_AUTH_SECRET`, four database URL names
  (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `VIVARY_DATABASE_URL`, and
  `VIVARY_DATABASE_URL_UNPOOLED`), the provider key `OPENROUTER_API_KEY`, the probe token
  `VIVARY_PROBE_TOKEN`, a user-level Windows variable, `COOKIE_DOMAIN`, and `NITRO_SSL_KEY`.
  `bin/start.mjs` sets the last two empty, and the rule matches them by name.
- The desktop process held the provider key, the probe token, and the user-level Windows variable
  from launch. Depths 1 to 3 held no credential-shaped name in either run, so the launch filter
  already kept these names from Codex.
- Before the fix the worker held all ten. After it, the worker held none of the 100 names read.
- The server held the same ten names in both runs. That row proves the probe could read an
  ancestor's block, and it is the limit the HLDD states.
- In the after run, the same prompt then called `resolve-library-id` on Codex's own context7 MCP
  server, whose entry in Codex's configuration carries a secret header. It answered with the library
  ID `/reactjs/react.dev`, and Codex completed the turn. Codex keeps its own MCP servers under the
  filtered worker.

## Startup time for #117

The laptop forked the packaged worker with the bundled Node and no credential, five times per
package, and timed its ready message. The `d5c960ce` worker became ready in 621 ms on the first run
after extraction, then in 546 to 594 ms. The `ec82a872` worker took 1,221 ms on its first run, then
506 to 519 ms. The slowest run is under a tenth of the 15-second deadline.

## Review rounds

The reviews used Claude models only. Opus and Fable reviewed `0ff66f2`. They found that the late-ready
test failed on Windows and broke the tests after it, that its deadline case could hang, that no test
caught the worker opening an empty default database, and that the HLDD understated what stays
readable in the server's start environment and overstated memory reads on Linux. `987b5f5` and
`d5c960c` fix these. Both reviews also named the packaged Windows run, a real Codex turn, and the
#117 load time as missing evidence, which this receipt records.

Fable re-reviewed `d5c960c` and found low items in the memory-read wording, the database tripwire, the
late-ready test, and two Last change review phrases. `2956463` and the commit that adds this receipt
fix them.

The Windows lockout after a worker exits on its own before ready is deferred to
[issue #121](https://github.com/vivary-dev/Vivary-New/issues/121). Skipping the grace timer when no
run was sent is declined. The grace is bounded at 5 seconds and unchanged from `dev`, and the measured
start is far inside the deadline.

## Remaining limits

- Every credential in Vivary's launch environment, such as provider keys and a user's own token
  variables, stays in the start environment of the server and of the desktop process that starts it,
  and a same-user command can read it there.
- On Windows, the settings that `bin/start.mjs` assigns at startup, including the sign-in secret, sit
  in the server process's environment block, and a same-user process can read another's memory where
  the operating system allows it. The server row above shows this in both runs.
- A same-user process can still read the private data folder, including the sign-in secret file and
  the database.
- The worker starts without database settings. A future Core call that queried the database from the
  worker would open an empty default database, and only the test on the Claude Code path catches it.
- The Linux proof is the tests. The Windows proof is one packaged run before the fix and one after, on
  one laptop, and the load times come from the same laptop. No packaged Claude Code run was checked.
- The issue's MCP acceptance item describes a handoff that the fix showed unnecessary, as
  [why the worker needs no handoff](#why-the-worker-needs-no-handoff) explains. Codex's own MCP server
  with a secret header worked in the after run.
