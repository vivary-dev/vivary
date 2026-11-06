# Real Native provider in the packaged Windows app

Issue [#50](https://github.com/vivary-dev/Vivary-New/issues/50) requires real Native-provider turns
through the normal packaged UI. This receipt records the owner-approved run on 2026-09-26, the three
defects it found and fixed on `fix/native-openrouter-in-package`, and the limits that remain.

Delivery status: [PR #100](https://github.com/vivary-dev/Vivary-New/pull/100) merged into `dev` as
`8a5d262` after all eight checks passed, including Entire Gates. The owner accepted the run and
closed issue #50 on 2026-09-26.

## Source, artifact, provider

- Source: `fix/native-openrouter-in-package` at `265a7ede474bc21050dab137c1ca845589b03ce3`, from `dev`
  `bff84c0`.
- Package: `Vivary-windows-x64-265a7ede.zip`, 223,839,131 bytes, SHA-256
  `035e17853143491d28b20768cb0c778c5fb12b47370f3768d9e78c9784846b5e`, checked on Zo and on the Windows
  laptop. The no-key checks and the first turn ran on the `df11518b` package from `df11518`, which
  differs only in the replayed tool-call ids and documents. Every later step ran on `265a7ede`.
- Provider and model: OpenRouter, `stealth/space-bunny-alpha`. OpenRouter lists the model at $0 per
  token, with tool calling and mandatory reasoning. The owner set a $5 budget.
- Credential: the owner's OpenRouter key, held encrypted on the host and passed to Vivary only as
  `OPENROUTER_API_KEY` in the launch environment. It was never typed into the app or saved in its
  profile. The launch script passed no other credential and limited `PATH` to the Windows system
  folders and Git, so the coding CLIs read as not installed.

## Setup path

Settings > Agent > AI provider > Manage shows the key source as "Connected via OPENROUTER_API_KEY"
and "OPENROUTER_API_KEY configured". The owner chose OpenRouter and typed the model id into the free
Model field. Test passed in 984 ms. A new Native chat then defaulted to "Model:
stealth/space-bunny-alpha". The in-chat Custom keys form is the other supported path, and it saves
the key encrypted in the profile. It was not used.

## Journeys and results

| Step | Result |
| --- | --- |
| No key | A Native chat shows "Connect AI. Use Builder.io (free credits), or add your own provider keys." The composer takes no text, and Send creates no conversation. |
| First turn in `relay-service` | The agent called `vivary-project-read` find and check. It named the gamma relay from `decisions/relay.md` and `README.md`, said it could not determine the route from the snippets, reported one file excluded for privacy (`git_ignored`), and reported the check finding E101 on `decisions/relay.md:1`. No private-note content appeared. |
| Follow-up | On `df11518b` every follow-up ended with "Engine stream error". On `265a7ede` the agent called `vivary-project-evaluate` dependencies three times, reported each `vivary_evaluate_input` refusal verbatim, and recalled the gamma relay from the first turn. |
| Project switch | A Native chat in `orchard-notes` found Honeycrisp and a harvest in the second week of September from its own files. Its relay search returned no results, and it never mentioned the gamma relay. |
| Second conversation | A new `relay-service` chat said it was the first message and knew nothing of the other conversations. |
| Rename, pin, archive | Rename changed the sidebar title. Pin moved an older chat to the top, and Unpin restored recency order. Archive removed the disposable chat from the list and kept the other. |
| Stop | Stop ended a long turn mid-sentence after its first report. The composer returned to "Write a message". |
| Provider failure | With a random invalid key, the turn failed with "The provider rejected the credential used for this request". Connect AI returned with Retry and Dismiss, and earlier history stayed. |
| Retry | After a relaunch with the real key, Retry answered and closed the card. The failed attempt and its error stayed in the thread. |
| Reopen and restart | Each relaunch reopened the last conversation with its history. The `orchard-notes` chat reopened from project history with its answer. |
| No secret exposed | The UI tree, the database, and 737 profile, browser-profile, and evidence files contain neither the real key nor the invalid one. |
| Usage | Six requests reported 392,731 input tokens (277,607 cached) and 3,638 output tokens. |

## Defects fixed on this branch

1. The packaged app read every AI SDK provider as not installed. Agent-Native bakes the names in
   `packages/workbench/package.json` into the built server, and the provider packages were not
   declared. `ai` and seven provider packages are now dependencies at their locked versions.
2. The Native picker ignored a custom model saved in Settings and defaulted to another, possibly
   paid, model. The maintained Core patch now defaults to a chosen, configured provider and model.
3. Every follow-up after a turn with several tool calls failed. Core replayed earlier tool calls with
   ids such as `history_tc_1`. A logged request and direct replays showed that OpenRouter's upstream
   for this model keeps only nine characters of an id, so the ids collided and the stream ended with
   `provider_unavailable`. Replayed ids are now nine alphanumeric characters.

## Remaining limits and findings

- Core maps a stream that ends with an error to "Engine stream error" and drops the provider's
  message. That error offers Dismiss and Copy, not Retry. Tracked in [#101](https://github.com/vivary-dev/Vivary-New/issues/101).
- The Send button has no accessible name. Its tooltip reads "Queue message". Tracked in [#102](https://github.com/vivary-dev/Vivary-New/issues/102).
- Vivary's usage table estimated 48.31 cents for this $0 model. OpenRouter's own activity is the
  source for spend. Tracked in [#103](https://github.com/vivary-dev/Vivary-New/issues/103).
- The missing-access card advertises Builder.io credits inside the local app. Tracked in [#104](https://github.com/vivary-dev/Vivary-New/issues/104).
- Archived chats have no visible restore in the sidebar. Tracked in [#105](https://github.com/vivary-dev/Vivary-New/issues/105).
- Stop took effect after the running tool step, and the stopped reply carries no stopped label. Tracked in [#106](https://github.com/vivary-dev/Vivary-New/issues/106).
- Background-run fallback ids of the form `<runId>:tc_<n>` can collide the same way. They reach a
  provider only on hosted runtimes. Tracked in [#107](https://github.com/vivary-dev/Vivary-New/issues/107).
- OpenRouter does not state this anonymous model's data policy. The run used fixture projects only.
