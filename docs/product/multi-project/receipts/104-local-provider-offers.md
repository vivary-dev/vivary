# No Builder.io offers in the local app

Issue [#104](https://github.com/vivary-dev/Vivary-New/issues/104) asked whether the local app should
offer Builder.io. The owner decided on 2026-09-27 to remove every Builder.io offer when Vivary runs in
local mode, and to keep Core's behavior in self-hosted mode for now. This receipt records the change on
`feat/webhooks-and-local-providers`.

Delivery status: PR #122 merged into `dev` as `15fed03` after all eight checks passed, including
Entire Gates, and the owner closed issue #104 on 2026-09-27.

## Source and artifacts

- Commits `5dc2f44` (remove Builder.io offers from the local app) and `2449e77` (keep the custom storage
  path and gate the remaining text). They change the maintained Core and Toolkit patches and add
  `packages/workbench/server/plugins/00-builder-offers.ts`, which sets the switch from the access mode
  when the server starts, before Core builds its prompts and tools.
- Package: `ec82a872`, the same package as the #113 check.

## What changed

With the switch off, the local app shows no Builder.io offer on the missing-access card, Settings
provider setup, first-run onboarding, the model picker, voice and transcription, image upload, web
search, the code-access panel, the file storage card, the code-required dialog, or in model-facing
prompts and error messages. The missing-access card reads "Connect AI. Add your own provider keys."
with the provider-key form, and the file storage card keeps its custom storage keys path.

## Verification

- Zo: the local-mode pages `/`, `/settings`, and `/settings/agent` carry `builderOffers: false`, with
  0 Builder mentions in the page text.
- Packaged Windows check on `ec82a872`:
  - With no key, a Personal Native chat showed "Connect AI" and "Add your own provider keys." with a
    provider chooser, an API key field, and a save button. 0 Builder mentions, also with the model
    picker open, on Settings > Agent > AI provider ("Add your own provider keys." and "Custom keys"),
    and on every Settings tab.
  - With a random invalid key, the chat showed "The provider rejected the credential used for this
    request" with the key form and Retry, and no Builder mention. After a relaunch with the owner's key,
    Retry replied normally.

## Review rounds

Opus and Fable reviewed `5dc2f44`. Fable found that the switch also hid the file storage card's custom
storage path, and both found some remaining Builder text. `2449e77` fixes both.

## Remaining limits

- The MCP catalog still lists Builder CMS as an integration, and voice errors that only appear after
  a Builder connection keep their text.
- Self-hosted mode keeps Core's Builder.io offers until the owner decides otherwise.
- New strings exist in English only.
