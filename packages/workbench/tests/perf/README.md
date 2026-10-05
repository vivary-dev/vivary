# Conversation responsiveness (#188)

A repeatable measurement of what a person waits for in the real built app: startup to a usable
conversation list, switching conversations until messages and the current composer state are
usable, search until the correct conversation is listed, idle network and server load, and memory.
It guides performance experiments; it is not a CI test. CI guards kept wins with deterministic,
socket-free tests (`pnpm test:conversation-perf`).

```sh
pnpm build
node tests/perf/responsiveness.mjs --size both --output /tmp/vivary-perf/candidate.json
```

Requires system Chrome (`VIVARY_PERF_CHROME`, default `/usr/bin/google-chrome`) and the pinned dev
dependency `playwright-core` 1.63.0; no browser download. Defaults: both sizes, three fresh servers
per size (`--repeats`, minimum 3) and 15 cold and warm samples per runtime and for search
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
  card). Cold is the first visit in a browser context; warm revisits right after leaving through the
  shortest listed conversation of the other runtime. Pools are the conversations a person can reach
  in the bounded sidebar. Results split the longest conversations from the others.
- Search: Enter until the expected conversation is listed, clicking "Search more history" as a person
  would when the automatic budget stops; settled when no search is running. Every listed hit must
  belong to the expected conversation. Targets alternate runtimes and span newest to oldest.
- Idle: 30 seconds on a long Code run: requests and transferred bytes (CDP), per-second server event
  loop delay (opt-in `VIVARY_PERF_METRICS=1` plugin) and server RSS.
- Memory journey, last: 30 switches between the longest Native thread and a long Code run. After
  every timed switch the trace file (`<output>.trace.jsonl`) records JS heap, DOM nodes and the RSS
  of every Chrome renderer, so a crash still leaves evidence. A renderer crash is recorded as the
  run's outcome (`status: crashed`, phase and last memory sample), and the remaining runs continue.

Markdown lists each run's median and p90 and the spread of the per-run medians (between-run noise).
