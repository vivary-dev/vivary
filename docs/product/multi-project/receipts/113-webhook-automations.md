# Webhook automations in the packaged app

Issue [#113](https://github.com/vivary-dev/Vivary-New/issues/113) asks for webhook automations to work
in the packaged app. The owner decided on 2026-09-27 that they should, that the desktop app keeps the
same port across launches so a webhook URL survives restarts, and that a call accepted before Vivary
quits runs once after restart. This receipt records the change on `feat/webhooks-and-local-providers`
and its verification.

Delivery status: PR #122 merged into `dev` as `15fed03` after all eight checks passed, including
Entire Gates, and the owner closed issue #113 on 2026-09-27.

## Source and artifacts

- Source: `feat/webhooks-and-local-providers`, branched from `dev` at `8e7a8fc`. The #113 commits are
  `746f404` (webhooks in the packaged app), `46ad53b` (visible refusals and bounded queues), and
  `9eaf055` (port notice, sweep paging, and expiry guard). `64480ee` records the #97 closure, and
  `ec82a87` merges `dev` at `0999044`.
- Package: `Vivary-windows-x64-ec82a872.zip`, 223,870,650 bytes, SHA-256
  `8da4046b13ba0356064367331607eeac0c0e76e901571c58b10716d6f268f763`, built on Zo from `ec82a87` and
  checked on Zo and the Windows laptop. Zo CI on `ec82a87` passed workflow lines 112 to 115 (69, 388,
  34, and 65 tests), the Python suite, the workbench typecheck, and `test:maintained`. `9eaf055` came
  after the package and changes only the port notice for a saved port outside the reuse range, the
  sweep's paging past other apps' tasks, and a guard on expiry. Its tests failed first and pass, and
  Zo CI passed on it.
- Provider: OpenRouter with `stealth/space-bunny-alpha`. The owner's key reached Vivary only through
  the launch environment.

## How it works

- A webhook call is authenticated by its token, deduplicated by its event id, and queued. The
  maintained Core patch runs queued webhook tasks inside the server process wherever the in-process
  scheduler runs, the same pattern #51 used for Run now. It needs no app URL or `A2A_SECRET`. The
  retry sweep uses the same runner, so a call accepted before a quit runs after restart.
- A task claimed in process keeps its claim for the run's lease (1.5 times the hard timeout, 15
  minutes by default, never below 5 minutes), so the sweep does not start it twice.
- Calls queued for more than 24 hours expire with a history row instead of running. An automation
  with 20 calls waiting answers new calls with 429 and `Retry-After`.
- A stored API key is required only for an automation with a condition. The condition check calls
  Anthropic, so it needs an Anthropic key and sends the request body there. Without one, the call
  fails at once with a history row that names the cause.
- Webhook runs keep the #51 local-only tool surface, and the payload stays fenced as untrusted input.
  The token is a stored secret, so #97 redaction hides it from the model and from logs.
- The desktop app saves its port in the data folder and picks new ports from 42100 to 42999, below
  the Windows dynamic range. It retries a saved port for about 3 seconds and shows a notice when the
  port changes. The Automations Details dialog shows the full URL, and its wording follows the access
  mode: local mode says the URL is reachable only from this computer while Vivary is open.

## Verification

- Zo live checks on built apps: an accepted call ran once, a repeated event id got a 200 duplicate, a
  wrong token got 404, a condition automation with only an OpenRouter-style key failed at once with a
  visible history row, a call planted 25 hours earlier expired on restart without running, and a call
  interrupted by a server stop reran once after the lease. The token appeared 0 times in logs and
  data files.
- Packaged Windows check on `ec82a872`, four launches of one profile (no key, a random invalid key,
  and the owner's key twice):
  - The first launch picked port 42746 and saved it. The third launch used it again, and the fourth
    answered on the same webhook URL. The second launch's port was not read.
  - A Personal Native chat defined `vivary-113-hook` (webhook, no condition, no MCP tools). The agent
    saw the token as `[redacted]`. Details showed the full URL and "Reachable only from this computer
    while Vivary is open."
  - A call with a new event id got 202 and a run that replied exactly "VIVARY-113 HOOK". The same id
    got a 200 duplicate. A wrong token got 404.
  - After a quit and relaunch, the same URL took a new call with 202, and a second run succeeded.
  - The raw token appeared 0 times in the profile data and the evidence.
  - Delete removed the automation, and the old URL then answered 404.

## Review rounds

The reviews used Claude models only. Opus and Fable reviewed `746f404` and found no double run, no
lost call, and no weakening of token checks. Their findings covered a silent failure for condition
automations, calls replayed after an upgrade, the queue size, ports in the Windows dynamic range, a
probe-then-bind race, docs about quitting mid-run, and the "who can call it" wording. `46ad53b` fixes
them. Fable re-reviewed it and found three smaller issues, fixed in `9eaf055`.

## Remaining limits

- An interrupted call reruns from the start, and it may repeat local steps such as a memory write.
  Later calls to that automation wait behind it. After a hard kill it reruns only after the lease. Since
  #114, a call whose run a normal quit interrupted goes back to the queue and runs at the first retry
  pass at least 90 seconds after the quit, as the [#114 and #115 receipt](114-automation-quit-and-status.md) records.
- Conditions need an Anthropic key and send the request body to Anthropic.
- Event-triggered automations keep Core's older key check.
- In local mode only programs on the same computer can call a webhook. A self-hosted install with a
  real address can accept outside callers.
- The port fallback and its notice are covered by unit tests, not by a packaged check.
- New strings exist in English only.
