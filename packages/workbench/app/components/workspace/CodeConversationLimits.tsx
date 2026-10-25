import type { VivaryCodeEngine } from "../../../server/local-runtime-setup";
import { runtimePermissionLabel } from "../../lib/code-permission-labels";

// The line under a Code conversation: its runtime and model, what that runtime may do without asking, and how to stop it.
export function CodeConversationLimits({ engine, engineLabel, model }: { engine: VivaryCodeEngine; engineLabel: string; model: string }) {
  return <p className="local-agent-limits"><span>{engineLabel} · {model}</span>. {runtimePermissionLabel(engine)} Work continues if you leave this page. Use Stop to end the active turn.</p>;
}
