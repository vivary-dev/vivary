import assert from "node:assert/strict";
import test from "node:test";
import { assessClaudeSubscription, assessCodexSubscription, claudeFundingLimitEvent } from "../server/code-subscription-funding.ts";
import { claudeAccount, includedClaudeUsage } from "./fixtures/claude-subscription.ts";

const check = (usage: unknown = includedClaudeUsage(), model = "claude-fable-5-1", account: unknown = claudeAccount, version = "2.1.289") =>
  assessClaudeSubscription({ account, usage }, model, version);

test("the observed account OFF shape admits synthetic remaining Max allowance", () => {
  assert.equal(check().status, "ready");
  assert.equal(check(includedClaudeUsage(), "claude-opus-5-5").status, "ready");
  assert.equal(check(includedClaudeUsage(), "sonnet").status, "ready");
});

test("temporary credit exhaustion and missing or changed controls never admit", () => {
  const original = includedClaudeUsage();
  const usage = { ...original, rate_limits: { ...original.rate_limits, extra_usage: {
    ...original.rate_limits.extra_usage, user_disabled: false, disabled_reason: "out_of_credits",
  } } };
  assert.equal(check(usage).status, "paid-funding-enabled");
  usage.rate_limits.extra_usage.user_disabled = true;
  assert.equal(check(usage).status, "unavailable");
  assert.equal(check(includedClaudeUsage(), undefined, { ...claudeAccount, apiProvider: "bedrock" }).status, "unavailable");
  assert.equal(check(includedClaudeUsage(), undefined, claudeAccount, "2.1.290").status, "unavailable");
  const complete = includedClaudeUsage();
  const { model_scoped, ...withoutModels } = complete.rate_limits;
  const { extra_usage, ...withoutCredits } = complete.rate_limits;
  const { five_hour, ...withoutFiveHour } = complete.rate_limits;
  const { seven_day, ...withoutWeekly } = complete.rate_limits;
  for (const rate_limits of [withoutModels, withoutCredits, withoutFiveHour, withoutWeekly]) {
    assert.equal(check({ ...complete, rate_limits }).status, "unavailable");
  }
});

test("global, selected model, legacy, unknown, and plan-specific windows fail closed", () => {
  for (const key of ["five_hour", "seven_day"] as const) {
    const usage = includedClaudeUsage();
    usage.rate_limits[key].utilization = 100;
    assert.equal(check(usage).status, "exhausted");
  }
  const usage = includedClaudeUsage();
  usage.rate_limits.model_scoped[0].utilization = 100;
  assert.equal(check(usage).status, "exhausted");
  assert.equal(check(usage, "claude-opus-5-5").status, "ready");
  assert.equal(check({ ...usage, rate_limits: { ...usage.rate_limits,
    seven_day_opus: { utilization: 100, resets_at: null },
  } }, "claude-opus-5-5").status, "exhausted");
  usage.rate_limits.model_scoped[0].display_name = "Unknown";
  assert.equal(check(usage).status, "unavailable");
  const ordinary = includedClaudeUsage();
  assert.equal(check({ ...ordinary, rate_limits: { ...ordinary.rate_limits,
    unrelated_cloud_promotion: { utilization: 0 },
  } }).status, "ready");
  const pro = includedClaudeUsage();
  pro.subscription_type = "pro";
  assert.equal(check(pro).status, "paid-funding-enabled");
  assert.equal(check(includedClaudeUsage(), "foreign-opus-model").status, "unavailable");
  assert.equal(check(includedClaudeUsage(), "claude-haiku-5-5").status, "unavailable");
});

test("Codex's backend permission and credit snapshots never invent an overflow cap", () => {
  const value = { ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 82 }, secondary: null,
    credits: { hasCredits: true, unlimited: false }, individualLimit: null, spendControlReached: false } };
  assert.equal(assessCodexSubscription(value).status, "paid-funding-enabled");
  assert.equal(assessCodexSubscription({ ...value, ordinaryUsageAllowed: false }).status, "exhausted");
  assert.equal(assessCodexSubscription({ ...value, ordinaryUsageAllowed: null }).status, "unavailable");
  assert.equal(assessCodexSubscription({ ...value, rateLimits: { primary: { usedPercent: 100 } } }).status, "exhausted");
  assert.equal(assessCodexSubscription({ ...value, rateLimits: { credits: { hasCredits: false, unlimited: false } } }).status, "unavailable");
});

test("provider limit rejections stop clearly without treating estimated cost as paid use", () => {
  assert.doesNotThrow(() => claudeFundingLimitEvent({ type: "result", total_cost_usd: 1 }));
  assert.doesNotThrow(() => claudeFundingLimitEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } }));
  assert.throws(() => claudeFundingLimitEvent({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }), /included subscription allowance is exhausted/);
  assert.throws(() => claudeFundingLimitEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: true } }), /usage-credit spending/);
});
