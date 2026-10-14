import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { codingRuntimeEnvironment } from "../../server/local-runtime-setup.ts";

const fixtureEvent = z.object({ args: z.array(z.string()).optional(), pid: z.number().int().optional(),
  type: z.string().optional(), request: z.object({ subtype: z.string(), skip_behaviors: z.boolean().optional() }).optional(),
}).passthrough();
type FixtureEvent = z.infer<typeof fixtureEvent>;

export const claudeAccount = { email: "fixture@example.test", organization: "fixture-org", subscriptionType: "Claude Max", apiProvider: "firstParty" };
// Observed CLI 2.1.289 / SDK 0.3.288 account OFF fields. Allowance values below are synthetic.
export function includedClaudeUsage() {
  return { subscription_type: "max", rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 0, resets_at: null },
    seven_day: { utilization: 20, resets_at: "2099-01-01T00:00:00Z" },
    seven_day_oauth_apps: null, seven_day_opus: null, seven_day_sonnet: null,
    model_scoped: [{ display_name: "Fable", utilization: 5, resets_at: "2099-01-01T00:00:00Z" }],
    extra_usage: { is_enabled: false, user_disabled: true, disabled_reason: null,
      spend_limit_reached: false, monthly_limit: null, used_credits: null, currency: null },
  } };
}
export async function createClaudeSubscriptionFixture(root: string) {
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  const usageFile = path.join(root, "usage.json");
  const accountFile = path.join(root, "account.json");
  const calls = path.join(root, "calls.jsonl");
  const executable = path.join(bin, "claude");
  await writeFile(usageFile, JSON.stringify(includedClaudeUsage()));
  await writeFile(accountFile, JSON.stringify(claudeAccount));
  await writeFile(path.join(bin, "codex"), "#!/usr/bin/env node\nprocess.exit(1);\n", { mode: 0o755 });
  await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("2.1.289 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" })); process.exit(0); }
const session = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : "11111111-1111-4111-8111-111111111111";
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, pid: process.pid }) + "\\n");
const input = require("node:readline").createInterface({ input: process.stdin });
input.on("line", line => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(message) + "\\n");
  if (message.type === "control_request") {
    const response = message.request.subtype === "initialize" ? { account: JSON.parse(fs.readFileSync(${JSON.stringify(accountFile)})), commands: [], models: [], agents: [] }
      : message.request.subtype === "get_usage" ? JSON.parse(fs.readFileSync(${JSON.stringify(usageFile)})) : {};
    console.log(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id,
      response: response.malformed_control ? "malformed" : response } }));
  } else if (message.type === "user") {
    console.log(JSON.stringify({ type: "system", subtype: "init", session_id: session }));
    console.log(JSON.stringify({ type: "result", subtype: "success", session_id: session, result: "Subscription fixture completed" }));
  } else process.exit(3);
});
input.on("close", () => process.exit(0));
`, { mode: 0o755 });
  return { bin, executable, usageFile, accountFile, calls,
    launch: { executable, prefix: [], env: codingRuntimeEnvironment(process.env) },
    events: async (): Promise<FixtureEvent[]> => (await readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => fixtureEvent.parse(JSON.parse(line))),
  };
}
