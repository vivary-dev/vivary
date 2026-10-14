import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fail } from "@agent-native/core/action";
import { z } from "zod";
import { CLAUDE_CODE_MODELS, CLAUDE_CODE_LEGACY_ALIASES, claudeCodeModelChoices } from "../shared/claude-models";
import type { CommandLaunch } from "./local-runtime-setup";
import { CLAUDE_FUNDING_CLI_VERSIONS, readClaudeSubscriptionUsage, type ClaudeFundingCliVersion } from "./claude-subscription-usage";

export type CodeSubscriptionFunding = {
  policy: "included-only";
  status: "ready" | "exhausted" | "paid-funding-enabled" | "unavailable";
  message: string;
  models?: Record<string, { status: CodeSubscriptionFunding["status"]; message: string }>;
};
const funding = (status: CodeSubscriptionFunding["status"], message: string): CodeSubscriptionFunding => ({ policy: "included-only", status, message });
const unavailable = () => funding("unavailable", "Claude Code could not verify its included allowance and Usage credits setting. Refresh Runtime settings. No message was sent.");
const accountSchema = z.object({ email: z.string().email(), organization: z.string().optional(),
  apiProvider: z.literal("firstParty"), subscriptionType: z.string().min(1) });
const windowSchema = z.object({ utilization: z.number().finite().min(0), resets_at: z.string().nullable() });
const usageSchema = z.object({ subscription_type: z.enum(["pro", "max"]), rate_limits_available: z.literal(true),
  rate_limits: z.object({ five_hour: windowSchema, seven_day: windowSchema,
    seven_day_oauth_apps: windowSchema.nullable().optional(),
    seven_day_opus: windowSchema.nullable().optional(),
    seven_day_sonnet: windowSchema.nullable().optional(),
    model_scoped: z.array(windowSchema.extend({ display_name: z.string().min(1) })).max(100),
    extra_usage: z.object({ is_enabled: z.boolean(), user_disabled: z.boolean(), disabled_reason: z.string().nullable(),
      spend_limit_reached: z.boolean(), monthly_limit: z.number().nullable(), used_credits: z.number().nullable(), currency: z.string().nullable() }),
  }) });

/** The experimental CLI contract is pinned and unknown fields never establish admission. */
export function assessClaudeSubscription(snapshot: { account: unknown; usage: unknown }, model: string,
  version: string): CodeSubscriptionFunding {
  const account = accountSchema.safeParse(snapshot.account);
  const usage = usageSchema.safeParse(snapshot.usage);
  if (!CLAUDE_FUNDING_CLI_VERSIONS.some(verified => verified === version) || !account.success || !usage.success) return unavailable();
  const limits = usage.data.rate_limits;
  // A zero balance is temporary. Only the account's explicit off control can prevent later overflow.
  if (limits.extra_usage.is_enabled || !limits.extra_usage.user_disabled) return funding("paid-funding-enabled",
    "Claude Usage credits are not explicitly off. Turn Usage credits off in Claude Settings > Usage, then refresh. A zero balance or auto-reload off does not prevent paid overflow. No message was sent.");
  if (limits.extra_usage.disabled_reason !== null || limits.extra_usage.spend_limit_reached
      || limits.extra_usage.monthly_limit !== null || limits.extra_usage.used_credits !== null
      || limits.extra_usage.currency !== null) return unavailable();
  const known = CLAUDE_CODE_MODELS.find(choice => choice.id === model);
  if (!known && !CLAUDE_CODE_LEGACY_ALIASES.includes(model)) return unavailable();
  if (known && claudeCodeModelChoices(version).find(choice => choice.id === model)?.support !== "supported") return unavailable();
  const family = known ? model.split("-")[1] : model;
  if (usage.data.subscription_type === "pro" && family === "fable") return funding("paid-funding-enabled",
    "Fable on Claude Pro requires Usage credits. Choose a model included in your plan. No message was sent.");
  if (limits.model_scoped.some(bucket => !["sonnet", "haiku", "opus", "fable"].includes(bucket.display_name.toLowerCase()))) return unavailable();
  const relevant = [limits.five_hour, limits.seven_day,
    ...(limits.seven_day_oauth_apps ? [limits.seven_day_oauth_apps] : []),
    ...(family === "opus" && limits.seven_day_opus ? [limits.seven_day_opus] : []),
    ...(family === "sonnet" && limits.seven_day_sonnet ? [limits.seven_day_sonnet] : []),
    ...limits.model_scoped.filter(bucket => bucket.display_name.toLowerCase() === family)];
  const exhausted = relevant.find(bucket => bucket.utilization >= 100);
  if (exhausted) return funding("exhausted", "Claude's included subscription allowance is exhausted"
    + (exhausted.resets_at ? ` until ${exhausted.resets_at}` : "")
    + ". No message was sent. Usage credits and paid API fallback remain disabled.");
  return funding("ready", "Claude included allowance is available and account Usage credits are explicitly off.");
}

export function claudeSubscriptionAccount(snapshot: { account: unknown }): string | null {
  const account = accountSchema.safeParse(snapshot.account);
  return account.success ? createHash("sha256").update(JSON.stringify({
    email: account.data.email.toLowerCase(), organization: account.data.organization ?? null,
    apiProvider: account.data.apiProvider,
  })).digest("hex") : null;
}

export async function claudeSubscriptionRuntime(cwd: string, launch: CommandLaunch): Promise<string> {
  const files = await Promise.all([launch.executable, ...launch.prefix].map(async file => {
    if (!path.isAbsolute(file)) throw new Error("Claude runtime is not resolved.");
    const resolved = await realpath(file);
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("Claude runtime is not a file.");
    return { resolved, size: info.size, modified: info.mtimeMs, changed: info.ctimeMs };
  }));
  return createHash("sha256").update(JSON.stringify({ cwd: await realpath(cwd), files,
    home: launch.env.HOME ?? null, config: launch.env.CLAUDE_CONFIG_DIR ?? null,
  })).digest("hex");
}

export type ClaudeFundingBinding = { version: ClaudeFundingCliVersion; account: string; runtime: string };
const bindingSchema = z.object({ version: z.enum(CLAUDE_FUNDING_CLI_VERSIONS),
  account: z.string().regex(/^[a-f0-9]{64}$/), runtime: z.string().regex(/^[a-f0-9]{64}$/) });

export function assertClaudeWorkerFunding(snapshot: { account: unknown; usage: unknown }, model: string,
  retained: unknown, runtime: string): void {
  const binding = bindingSchema.safeParse(retained);
  if (!binding.success || binding.data.runtime !== runtime || binding.data.account !== claudeSubscriptionAccount(snapshot)) {
    throw new CodeSubscriptionFundingError(funding("unavailable", "Claude's account, runtime, or workspace changed after admission. Refresh and send again. No message was sent."));
  }
  assertCodeSubscriptionFunding(assessClaudeSubscription(snapshot, model, binding.data.version));
}

export function claudeFundingLimitEvent(event: Record<string, unknown>): void {
  if (event.type !== "rate_limit_event") return;
  const info = event.rate_limit_info;
  if (!info || typeof info !== "object") return;
  if ("isUsingOverage" in info && info.isUsingOverage === true || "overageInUse" in info && info.overageInUse === true) {
    throw new CodeSubscriptionFundingError(funding("unavailable", "Claude reported usage-credit spending. Vivary stopped this turn. Verify Usage credits are off before retrying."));
  }
  if ("status" in info && info.status === "rejected") throw new CodeSubscriptionFundingError(funding("exhausted",
    "Claude's included subscription allowance is exhausted. This turn stopped. No paid API fallback was started."));
}

const cache = new Map<string, { expires: number; value: { funding: CodeSubscriptionFunding; binding?: ClaudeFundingBinding } }>();
const pending = new Map<string, Promise<{ funding: CodeSubscriptionFunding; binding?: ClaudeFundingBinding }>>();
export async function getClaudeSubscriptionFunding(cwd: string, model: string, launch: CommandLaunch | null,
  { refresh = false }: { refresh?: boolean } = {}): Promise<{ funding: CodeSubscriptionFunding; binding?: ClaudeFundingBinding }> {
  if (!launch) return { funding: unavailable() };
  let runtime: string;
  try { runtime = await claudeSubscriptionRuntime(cwd, launch); } catch { return { funding: unavailable() }; }
  const key = runtime + ":" + model;
  if (!refresh) {
    const previous = cache.get(key);
    if (previous && previous.expires > Date.now()) return previous.value;
    const active = pending.get(key);
    if (active) return active;
  }
  // A send never reuses an in-flight background snapshot as its admission check.
  if (refresh) await pending.get(key);
  const request = (async () => {
    const observed = await readClaudeSubscriptionUsage(cwd, { launch });
    const status = observed.status === "observed" ? assessClaudeSubscription(observed, model, observed.version)
      : funding("unavailable", observed.message);
    const account = observed.status === "observed" ? claudeSubscriptionAccount(observed) : null;
    const modelStates = observed.status === "observed" ? Object.fromEntries([
      ...CLAUDE_CODE_MODELS.map(choice => choice.id), ...CLAUDE_CODE_LEGACY_ALIASES,
    ].map(id => { const state = assessClaudeSubscription(observed, id, observed.version);
      return [id, { status: state.status, message: state.message }]; })) : undefined;
    const value: { funding: CodeSubscriptionFunding; binding?: ClaudeFundingBinding } = { funding: { ...status, ...(modelStates ? { models: modelStates } : {}) }, ...(status.status === "ready" && account && observed.status === "observed" ? {
      binding: { version: observed.version, account, runtime },
    } : {}) };
    if (cache.size >= 32) cache.delete(cache.keys().next().value ?? "");
    cache.set(key, { expires: Date.now() + 30_000, value });
    return value;
  })().finally(() => { if (pending.get(key) === request) pending.delete(key); });
  pending.set(key, request);
  return request;
}

export function codexIncludedOnlyUnavailable(): CodeSubscriptionFunding {
  return funding("unavailable", "Codex's current CLI has no verified control to disable usage-credit overflow for this account. Vivary cannot enforce an included-only turn. No message was sent.");
}

export function assessCodexSubscription(value: unknown): CodeSubscriptionFunding {
  const parsed = z.object({ ordinaryUsageAllowed: z.boolean().nullable().optional(),
    rateLimits: z.object({ primary: z.object({ usedPercent: z.number().finite() }).nullable().optional(),
      secondary: z.object({ usedPercent: z.number().finite() }).nullable().optional(), credits: z.object({ hasCredits: z.boolean(), unlimited: z.boolean() }).nullable().optional(),
      spendControlReached: z.boolean().nullable().optional() }).passthrough(),
  }).safeParse(value);
  if (!parsed.success || parsed.data.ordinaryUsageAllowed == null) return funding("unavailable",
    "Codex could not verify its included allowance. Refresh Runtime settings. No message was sent.");
  if (!parsed.data.ordinaryUsageAllowed || [parsed.data.rateLimits.primary, parsed.data.rateLimits.secondary].some(window => window && window.usedPercent >= 100)) return funding("exhausted",
    "Codex's included subscription allowance is exhausted. No message was sent. Paid credits and API fallback were not selected.");
  const credits = parsed.data.rateLimits.credits;
  return funding(credits?.hasCredits || credits?.unlimited ? "paid-funding-enabled" : "unavailable",
    "Codex reports ordinary usage is allowed, but its current CLI cannot enforce an included-only turn. ChatGPT credits may fund overflow automatically. Vivary needs a provider control that disables that overflow before it can send. No message was sent.");
}

export class CodeSubscriptionFundingError extends Error {
  constructor(readonly funding: CodeSubscriptionFunding) { super(funding.message); this.name = "CodeSubscriptionFundingError"; }
}
export function assertCodeSubscriptionFunding(state: CodeSubscriptionFunding): void {
  if (state.status !== "ready") throw new CodeSubscriptionFundingError(state);
}
export function refuseCodeSubscriptionFunding(state: CodeSubscriptionFunding): void {
  if (state.status !== "ready") fail(state.message, { errorCode: `vivary_code_subscription_funding_${state.status.replaceAll("-", "_")}`, statusCode: 409 });
}
