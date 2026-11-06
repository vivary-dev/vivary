import { defineNitroPlugin, setBuilderOffersEnabled } from "@agent-native/core/server";

// Issue #104. The local desktop app points owners to their own provider keys only, so Core hides
// every Builder.io offer there: the chat's missing-access card, Settings, onboarding, the model
// picker, voice, uploads, web search, and the model's guidance. Hosted and private-proxy modes keep
// Core's offers for now. bin/start.mjs sets the mode before the server loads. The switch is set when
// this module loads, because Core builds its tool list and prompts when the agent-chat plugin starts.
setBuilderOffersEnabled(process.env.VIVARY_ACCESS_MODE !== "local"); // guard:allow-env-credential - Deployment access mode, not a user credential.

export default defineNitroPlugin(() => undefined);
