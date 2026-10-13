import { fail } from "@agent-native/core/action";
import type { VivaryCodeEngine } from "./local-runtime-setup";

export type CodeSubscriptionFunding = { policy: "included-only"; status: "unverified"; message: string };

// First-party sign-in and model access do not enforce an included-only funding boundary.
// No supported per-process control has been verified for either CLI. There is no opt-in bypass.
export function codeSubscriptionFunding(engine: VivaryCodeEngine): CodeSubscriptionFunding {
  const label = engine === "claude-cli" ? "Claude Code" : "Codex";
  return { policy: "included-only", status: "unverified",
    message: `${label} subscription-only funding is unverified. Vivary blocks new and resumed turns because the CLI can use paid credits. Sign-in and model availability do not prove included-only execution.` };
}

export function assertCodeSubscriptionFunding(engine: VivaryCodeEngine): void {
  fail(codeSubscriptionFunding(engine).message, {
    errorCode: "vivary_code_subscription_funding_unverified", statusCode: 409,
  });
}
