# Credential redaction

Issue [#97](https://github.com/vivary-dev/Vivary-New/issues/97) asks that credentials never appear in
anything Vivary shows, stores, or sends to a model, even when an agent, a tool, or a provider error
prints one. The owner asked for this on 2026-09-26 with user safety as the reason. This receipt
records the change on `fix/credential-redaction` and its verification on 2026-09-27.

Delivery status: PR #118 merged into `dev` as `8e7a8fc` after all eight checks passed, including
Entire Gates, and the owner closed issue #97 on 2026-09-27.

## Source and artifacts

- Source: `fix/credential-redaction`, branched from `dev` at `c39e22f`. `9b1e78b` records the #51
  closure. The code commits are `dc47f47` (Native chat, errors, commands, and logs), `3c20c07` (Code
  run transcripts through worker fingerprints), `5afa551` (a build-doctor marker), `75721b4` (review
  fixes), and `88b60dd` (two regressions found in re-review).
- Package: `Vivary-windows-x64-88b60dd9.zip`, 223,859,898 bytes, SHA-256
  `3548b07affeb291ee54a5ad09dc72513a47c83b9f9d9eb3ff811b3cb3eca4970`, built on Zo from `88b60dd` and
  checked on Zo and the Windows laptop. Zo CI on `88b60dd` passed workflow lines 112 to 115 (69, 388,
  28, and 40 tests), the Python suite, the workbench typecheck, and `test:maintained`, which runs the
  35-test sequential redaction suite.
- Provider for the packaged check: OpenRouter with `stealth/space-bunny-alpha`. The owner's key
  reached Vivary only through the launch environment.

## What redacts and where

One Vivary module, `packages/workbench/server/credential-redaction.ts`, replaces a credential with a
placeholder such as `[redacted OPENROUTER_API_KEY]` or `[redacted credential]`.

- Held values: credential-named server environment values, app secrets (provider keys, MCP headers,
  integration token bundles), and legacy stores. Each value is matched exactly, with its URL-encoded,
  JSON-escaped, and base64 forms, through a linear rolling-hash scan. Values under 16 characters and
  ordinary settings such as base URLs, hosts, and ports are not held. The held set reloads at
  startup, before each Native and Code send, and after each secret write or delete.
- Patterns for values Vivary does not hold: common key prefixes (OpenAI and OpenRouter `sk-`, GitHub
  tokens, AWS `AKIA`, Google `AIza`, Slack `xox`, Stripe live keys, GitLab `glpat-`), JWTs, bearer
  tokens, passwords inside URLs, and credential-named `name=value` or `name: value` lines, including
  `.env` dumps. Names that carry ordinary data, such as IDs, paths, expiry times, pagination tokens,
  and public, cache, storage, or idempotency keys, stay readable.
- Surfaces: Native tool results before truncation and before the model sees them, tool and provider
  error text, the run event stream with a holdback so a value split across stream chunks is still
  caught, the recovered-result ledger and its replay, saved and forked threads, earlier turns the
  browser sends back, automation run errors, original-command output and receipts, project context,
  Code run transcripts and run records, the Codex approval card, and log writes.
- The coding worker receives salted fingerprints, never raw values, and matches them with the same
  rolling hash.

## Verification

- Zo live checks on built apps at `3c20c07` and `75721b4`, with a random 40-character token in the
  server environment and a fake `ghp_` token: an MCP tool result, a model echo split across stream
  deltas, 500 and 401 provider errors, browser-sent history, a Claude Code stub run, and a Codex
  approval. Raw copies in SQLite, the code-runs folder, server output, and all data files: 0. The
  approval card showed `Bearer [redacted VIVARY_PROBE_TOKEN]`. A paginated result's `nextPageToken`
  stayed readable.
- Adversarial single-line inputs of 1 MB (dash-joined words, base64url, repeated `a.`, key-like runs,
  repeated `=`, `://`, and `Bearer `) each finished in under 0.6 seconds in re-review, and time grew
  linearly with size.
- Packaged Windows check on `88b60dd9`, with a random synthetic `VIVARY_PROBE_TOKEN` in the launch
  environment and a disposable resource holding that token, a fake `ghp_` token, and an `X_API_KEY`
  hex line. A Personal workspace Native chat read the resource. The tool result shown and given to
  the model read `held token: [redacted VIVARY_PROBE_TOKEN]`, `github token: [redacted credential]`,
  and `X_API_KEY=[redacted credential]`. The database held no raw copy outside the fixture row, and
  the saved accessibility trees held none. After the fixture was removed, a full byte scan found 0.
- The project-read tool withheld a Git fixture file holding the same values from the model, with
  reason `sensitive_content`. That existing protection runs before #97 redaction.

## Review rounds

The reviews used Claude models only. Opus and Fable reviewed `dc47f47`, `3c20c07`, and `5afa551`.
Both found a quadratic URL password pattern (30 seconds for a 256 KB line). Opus also found that the
recovered-result ledger stored and replayed raw text. Their medium findings covered tool input
streaming, long values, false positives on ordinary names, uncovered surfaces, and values starting
with `/`. `75721b4` fixes all fourteen findings. Fable re-reviewed `75721b4` and found two
regressions in the `name=value` rule (names containing pagination words such as `NEXTAUTH_SECRET`,
and webhook URLs). `88b60dd` fixes both with tests that fail on `75721b4`. `88b60dd` had no separate
review.

## Remaining limits

- Pattern matching misses hex, reversed, line-split, partial, and compressed forms, custom formats
  Vivary does not hold, and base64 of values it does not hold. There is no entropy detection.
- Redaction can hide text that only looks like a credential. If a model rewrites a file it read, it
  can write the placeholder back into that file.
- A key typed into chat reaches the model in the turn it is typed. Later turns carry the placeholder.
- Records saved before this change keep their raw text.
- A coding CLI still sends raw tool output to its own provider and keeps its own session files. The
  coding worker still inherits the server environment until
  [#98](https://github.com/vivary-dev/Vivary-New/issues/98).
- Fingerprints let a process that reads the worker test a weak held value of 16 or more characters
  offline.
- A configured error-tracking provider receives raw error messages, and the desktop startup error
  dialog is not redacted.
- While text streams, the last word or two appears slightly later. A held value with internal spaces
  can still split across stream chunks.
- A worker that reports ready after its startup deadline still receives the run. Tracked in
  [#117](https://github.com/vivary-dev/Vivary-New/issues/117).
