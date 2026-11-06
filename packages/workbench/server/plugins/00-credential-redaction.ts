import { setTextRedactor } from "@agent-native/core/audit";
import { defineNitroPlugin } from "@agent-native/core/server";

import {
  heldCredentialHoldback, redactCredentials, redactStreamWrites, refreshHeldCredentials, watchHeldCredentialSources,
} from "../credential-redaction.ts";

// Issue #97. Core redacts tool results, run events, error text, saved threads, automation
// errors, and Code transcript events with the redactor registered here, and keeps back enough of
// a streamed delta to cover the longest held value. Server output is redacted too, which covers
// console output in command-line mode. Environment and MCP values are held at once, stored
// secrets when the database answers, and the set reloads after each secret write or delete.
export default defineNitroPlugin(() => {
  setTextRedactor(redactCredentials, { holdback: heldCredentialHoldback });
  redactStreamWrites(process.stdout);
  redactStreamWrites(process.stderr);
  watchHeldCredentialSources();
  void refreshHeldCredentials().catch(() => undefined);
});
