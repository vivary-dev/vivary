# Conversation responsiveness (#188)

A repeatable measurement of what a person waits for in the real built app: startup to a usable
conversation list, switching conversations until messages and the current composer state are
usable, search until the correct conversation is listed, idle network and server load, and memory.
The full mode guides performance experiments. Deterministic, socket-free regressions
(`pnpm test:conversation-perf`) protect formatter construction and file-read counts.
The shorter `--size large --switches-only` mode reuses the same setup and switch
measurements, but limits timed Native targets to 200 messages and skips search, idle
and the memory journey. It times three fixed targets per runtime, repeating in
fresh contexts to collect fifteen samples. Its fixture puts six Code runs ahead
of Native histories and the other Code runs behind them so the required targets
fit the fifteen-row expanded sidebar independently of seeding speed. Each context
explicitly opens untimed Code 5 before measuring Code 1–3 and Native 196/195/194;
this avoids reopening a timed target from the server's saved selection. Native 193
is the other untimed hop. These are first visits within a browser context, with
server caches retained. Its paired latency budgets and CI integration are awaiting
calibration; do not treat an uncalibrated threshold as a passing performance gate.

```sh
pnpm build
node tests/perf/responsiveness.mjs --size both --output /tmp/vivary-perf/candidate.json
```

Requires system Chrome (`VIVARY_PERF_CHROME`, default `/usr/bin/google-chrome`) and the pinned dev
dependency `playwright-core` 1.63.0; no browser download. Defaults: both sizes, three fresh servers
per size (`--repeats`, minimum 3) and 15 first-pass and warm samples per runtime and for search
(`--samples`, minimum 15). Compare builds only under identical host, Chrome, fixture and flags, one
heavy job at a time. Each result records the commit, a hash of any uncommitted change, the harness
hash and a build identity (asset names and sizes) so a number can be traced to what produced it.

## Fixture

Seeding uses the real owner transport on an unmeasured setup server; each measured server restarts
on the same data with a fresh browser. Runtime readiness is simulated, provider requests are blocked
and nothing is sent. The fixture never reads your profile or credentials. PRNG seed 188.

- Small: 10 Native x 20 messages, 10 Code runs x 50 events.
- Large: 200 Native x 200 messages (the three newest have 2,000) and 1,000 Code runs x 400 events
  (the five newest have 5,000; the Code view shows the newest 400).

## What each number means

- Startup: server spawn to ready; five page loads (the first meets a just-started server) to the
  first sidebar row and to an enabled composer.
- Switching: click to the target's last message visible plus its current composer state: Code's
  composer enabled; Native's provider state settled (the fixture has no provider, so its Connect AI
  card). The legacy `ColdMs` fields contain first-pass clicks, which can include the
  startup-selected Code conversation and a Native target visited during an untimed hop.
  They are not proof that every click is a first visit. Warm samples revisit right after
  leaving through the shortest listed conversation of the other runtime. Pools are the conversations a person can reach
  in the bounded sidebar. Results split the longest conversations from the others.
- Search: Enter until the expected conversation is listed, clicking "Search more history" as a person
  would when the automatic budget stops, at most 10 times; beyond that the sample is reported as not
  found rather than timed. Settled means no search is running. Every listed hit must belong to the
  expected conversation. Targets alternate runtimes and span newest to oldest. A search page reads at
  most 25 conversations or 500 messages, so finding old conversations in a large history needs many
  pages; the not-found count shows that cost.
- A run that fails for a reason other than a renderer crash is recorded as `failed` with its phase
  and error, and the harness exits nonzero.
- Idle: 30 seconds on a long Code run: requests and transferred bytes (CDP), per-second server event
  loop delay (opt-in `VIVARY_PERF_METRICS=1` plugin) and server RSS.
- Memory journey, last: 30 switches between the longest Native thread and a long Code run. After
  every timed switch the trace file (`<output>.trace.jsonl`) records JS heap, DOM nodes and the RSS
  of every Chrome renderer, so a crash still leaves evidence. A renderer crash is recorded as the
  run's outcome (`status: crashed`, phase and last memory sample), and the remaining runs continue.

Markdown lists each run's median and p90 and the spread of the per-run medians (between-run noise).

The recorded baseline and E1/E2 acceptance comparisons retain the original harness
SHA-256 `6ba32494e8961e85b25841a9fb930fe4c30ddbaca0a1448c710468930743e793`.
The shorter mode is a separate calibration of this harness, not a replacement baseline.
A paired budget compares fresh baseline/candidate measurements on the same runner;
`responsiveness-budget.mjs` rejects incomplete runs and mismatched conditions,
recomputes medians from raw samples and refuses a different candidate commit.
