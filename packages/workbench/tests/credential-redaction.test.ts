import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

// Issue #97. Every value below is random, generated for this run, and never a real credential.
// A failed comparison masks the generated values before it reports text.
const caseRoot = await mkdtemp(path.join(tmpdir(), "vivary-credential-redaction-"));
const database = `file:${path.join(caseRoot, "secrets.sqlite")}`;
const generated: string[] = [];
// Letters and digits ending in a digit and a letter, or lower-case hex.
const synthetic = (length = 40, alphabet: "alnum" | "hex" = "alnum") => {
  const value = alphabet === "hex" ? randomBytes(length).toString("hex").slice(0, length)
    : randomBytes(length * 2).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, length - 2) + "7q";
  generated.push(value);
  return value;
};
Object.assign(process.env, { DATABASE_URL: database, DATABASE_URL_UNPOOLED: database, BETTER_AUTH_SECRET: synthetic(48) });
after(() => rm(caseRoot, { recursive: true, force: true }));

const {
  createCredentialRedactor, heldCredentialCount, heldCredentialHoldback, redactCredentialPatterns, redactCredentials,
  refreshHeldCredentials, defaultCredentialSources, watchHeldCredentialSources,
} = await import("../server/credential-redaction.ts");

const masked = (text: string) => generated.reduce((out, value) => out.split(value).join("<generated>"), text);
function assertText(actual: string, expected: string, label = "") {
  if (actual !== expected) assert.fail(`${label} ${masked(actual)} !== ${masked(expected)}`);
}
function assertMatch(text: string, pattern: RegExp, label = "") {
  if (!pattern.test(text)) assert.fail(`${label} ${masked(text).slice(0, 2_000)} does not match ${pattern}`);
}
function assertHidden(text: string, values: string[], label = "") {
  const shown = values.filter(value => text.includes(value)).length;
  assert.equal(shown, 0, `${label} showed ${shown} generated value(s)`);
}
const noSources = { environment: () => ({}), mcpConfig: () => null, storedSecrets: async () => [] };

test("a held value and its URL, JSON, and base64 forms become the labeled placeholder", () => {
  const value = `${synthetic(36)}/+"?`;
  const redactor = createCredentialRedactor([{ name: "OPENROUTER_API_KEY", value }]);
  const label = "[redacted OPENROUTER_API_KEY]";
  for (const form of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]) {
    assertText(redactor.redact(`before ${form} after`), `before ${label} after`, "plain form");
  }
  // Inside a longer base64 string, at each of the three byte alignments, in standard and URL-safe alphabets.
  for (const prefix of ["", "a", "ab"]) {
    for (const encoding of ["base64", "base64url"] as const) {
      const encoded = Buffer.from(`${prefix}${value}tail`).toString(encoding);
      const output = redactor.redact(`before ${encoded} after`);
      assertMatch(output, /^before .{0,3}\[redacted OPENROUTER_API_KEY\].{0,10} after$/, `${encoding} at offset ${prefix.length}`);
    }
  }
});

test("common key formats that Vivary does not hold are redacted", () => {
  const alnum = (length: number) => synthetic(length);
  const upper = (length: number) => randomBytes(length).toString("hex").toUpperCase().slice(0, length);
  const tokens: Record<string, string> = {
    openai: `sk-proj-${alnum(48)}`, openrouter: `sk-or-v1-${synthetic(64, "hex")}`, github: `ghp_${alnum(36)}`,
    githubOAuth: `gho_${alnum(36)}`, githubPat: `github_pat_${alnum(22)}_${alnum(59)}`, aws: `AKIA${upper(16)}`,
    google: `AIza${alnum(35)}`, slack: `xoxb-${upper(12)}-${alnum(24)}`,
  };
  for (const [kind, token] of Object.entries(tokens)) {
    generated.push(token);
    assertText(redactCredentialPatterns(`value ${token} end`), "value [redacted credential] end", kind);
  }
  const bearer = synthetic(32);
  assertText(redactCredentialPatterns(`Authorization: Bearer ${bearer}`), "Authorization: Bearer [redacted credential]");
  const password = synthetic(20);
  assertText(redactCredentialPatterns(`postgres://app:${password}@db.example.test:5432/app`),
    "postgres://app:[redacted credential]@db.example.test:5432/app");
  // Credential-named assignments, including a prefixed environment name, a .env dump, and JSON.
  const [one, two, three, hex] = [synthetic(40), synthetic(44), synthetic(30), synthetic(40, "hex")];
  assertText(redactCredentialPatterns(`OPENROUTER_API_KEY=${one}\nexport GITHUB_TOKEN="${two}"\nX_API_KEY=${hex}\n`),
    "OPENROUTER_API_KEY=[redacted credential]\nexport GITHUB_TOKEN=\"[redacted credential]\"\nX_API_KEY=[redacted credential]\n");
  assertText(redactCredentialPatterns(`{"apiKey": "${three}", "client_secret":"${one}"}`),
    '{"apiKey": "[redacted credential]", "client_secret":"[redacted credential]"}');
});

test("code, paths, settings, and short values are not redacted", () => {
  for (const text of [
    // guard:allow-env-credential - A sample line of code text for the redactor, never an environment read.
    "const apiKey = process.env.OPENROUTER_API_KEY;", "apiKey: config.providers.openrouter.apiKey",
    "token = getToken(request)", "DATABASE_URL=file:/tmp/vivary/auth.sqlite", "OPENAI_BASE_URL=https://api.example.test/v1",
    "key: 2026-09-27T00:00:00Z", "password: short1", "the task-force report was risk-assessment-framework-document",
    "GOOGLE_APPLICATION_CREDENTIALS=/home/owner/service-account.json", "Bearer tokens are described in RFC 6750.",
    "AUTH_URL=https://auth.example.test/login", "postgres://app@db.example.test:5432/app",
  ]) assertText(redactCredentialPatterns(text), text);
});

test("held values come from credential settings, MCP configuration, and stored secrets, and settings that are not secret are skipped", async () => {
  const [provider, dbPassword, webhook, headerToken, githubToken, stored, access, refresh, mcpHeader] =
    [synthetic(48), synthetic(20), synthetic(30), synthetic(32), synthetic(40), synthetic(51), synthetic(40), synthetic(40), synthetic(36)];
  const environment = {
    OPENROUTER_API_KEY: provider, PATH: `/usr/bin:/opt/${synthetic(20)}`, DATABASE_URL: "file:/tmp/vivary/auth.sqlite",
    POSTGRES_URL: `postgres://app:${dbPassword}@db.example.test/app`, SERVICE_TOKEN_PORT: "5173", SHORT_TOKEN: "abc123",
    FEATURE_TOKEN_ENABLED: "true", SLACK_WEBHOOK_URL: `https://hooks.example.test/services/${webhook}`,
  };
  const mcpConfig = { source: "test", servers: {
    docs: { type: "http" as const, url: "https://mcp.example.test", headers: { Authorization: `Bearer ${headerToken}`, Accept: "application/json-seq-with-extras" } },
    local: { type: "stdio" as const, command: "node", env: { GITHUB_TOKEN: githubToken, LOG_LEVEL: "debug-verbose-mode-on" } },
  } };
  const bundle = JSON.stringify({ access_token: access, refresh_token: refresh, expires_at: "2026-09-27T12:00:00.000Z" });
  await refreshHeldCredentials({ environment: () => environment, mcpConfig: () => mcpConfig, storedSecrets: async () => [
    { name: "OPENAI_API_KEY", value: stored }, { name: "google_tokens", value: bundle },
    { name: "mcp_headers:docs", value: JSON.stringify({ Authorization: `Bearer ${mcpHeader}` }) },
  ] });
  for (const [name, value] of [["OPENROUTER_API_KEY", provider], ["POSTGRES_URL", dbPassword], ["Authorization", headerToken],
    ["GITHUB_TOKEN", githubToken], ["OPENAI_API_KEY", stored], ["google_tokens", access], ["google_tokens", refresh],
    ["mcp_headers:docs", mcpHeader]]) {
    assertText(redactCredentials(`x ${value} y`), `x [redacted ${name}] y`, name);
  }
  assertText(redactCredentials(`hook https://hooks.example.test/services/${webhook} end`), "hook [redacted SLACK_WEBHOOK_URL] end");
  for (const text of [environment.PATH, "file:/tmp/vivary/auth.sqlite", "2026-09-27T12:00:00.000Z", "debug-verbose-mode-on",
    "application/json-seq-with-extras", "5173", "abc123"]) assertText(redactCredentials(text), text);
  await refreshHeldCredentials(noSources);
});

test("the secret store and legacy credential settings are read from the database", async () => {
  const { writeAppSecret, encryptSecretValue } = await import("@agent-native/core/secrets");
  const { putSetting } = await import("@agent-native/core/settings");
  const [storedKey, legacyEncrypted, legacyPlain] = [synthetic(44), synthetic(40), synthetic(36)];
  await writeAppSecret({ key: "OPENROUTER_API_KEY", value: storedKey, scope: "user", scopeId: "owner@example.test" });
  await putSetting("u:owner@example.test:credential:LEGACY_API_KEY", { value: encryptSecretValue(legacyEncrypted) });
  await putSetting("o:org-a:credential:LEGACY_TOKEN", { value: legacyPlain });
  await refreshHeldCredentials({ ...defaultCredentialSources, environment: () => ({}), mcpConfig: () => null });
  assertText(redactCredentials(`${storedKey} ${legacyEncrypted} ${legacyPlain}`),
    "[redacted OPENROUTER_API_KEY] [redacted LEGACY_API_KEY] [redacted LEGACY_TOKEN]");
  // A failed read keeps the values from the last read.
  await refreshHeldCredentials({ environment: () => ({}), mcpConfig: () => null, storedSecrets: async () => { throw new Error("database closed"); } });
  assertText(redactCredentials(storedKey), "[redacted OPENROUTER_API_KEY]");
  await refreshHeldCredentials(noSources);
});

test("an automation webhook token is a stored secret, so a webhook URL is redacted", async () => {
  const { realpath } = await import("node:fs/promises");
  const coreRoot = await realpath(new URL("../node_modules/@agent-native/core", import.meta.url));
  const { defineAutomation } = await import(pathToFileURL(path.join(coreRoot, "dist", "automations", "service.js")).href);
  const defined = await defineAutomation({ userEmail: "owner@example.test", appId: "workbench" },
    { scope: "personal", name: "webhook-probe", body: "Say hi.", triggerType: "webhook" });
  const token = String(defined.webhookPath).split("/").pop() ?? "";
  generated.push(token);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  await refreshHeldCredentials({ ...defaultCredentialSources, environment: () => ({}), mcpConfig: () => null });
  const shown = redactCredentials(`Webhook URL: http://127.0.0.1:4777${defined.webhookPath}`);
  assertHidden(shown, [token], "webhook URL");
  // The placeholder names the secret by its key, which holds the automation id.
  assertMatch(shown, /\/_agent-native\/automations\/webhook\/\[redacted automation-webhook:/);
  await refreshHeldCredentials(noSources);
});

test("a redactor exposes redact and a count, never its values", async () => {
  const [first, second] = [synthetic(40), synthetic(40)];
  const redactor = createCredentialRedactor([{ name: "A_TOKEN", value: first }, { name: "B_TOKEN", value: second },
    { name: "C_TOKEN", value: first }, { name: "SHORT_TOKEN", value: "short" }]);
  assert.equal(redactor.count, 2);
  assert.deepEqual(Object.keys(redactor).sort(), ["count", "redact"]);
  assertHidden(JSON.stringify(redactor), [first, second], "serialized redactor");
  await refreshHeldCredentials({ ...noSources, environment: () => ({ A_TOKEN: first, B_TOKEN: second }) });
  assert.equal(heldCredentialCount(), 2);
  await refreshHeldCredentials(noSources);
  assert.equal(heldCredentialCount(), 0);
});

test("redacting a megabyte against forty held values stays fast", () => {
  const held = Array.from({ length: 40 }, (_, index) => ({ name: `SYNTH_${index}_API_KEY`, value: synthetic(24 + index) }));
  const redactor = createCredentialRedactor(held);
  const filler = "lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(10_000);
  const text = `${filler}${held[3].value}${filler}${Buffer.from(`x${held[7].value}`).toString("base64")}`;
  const started = performance.now();
  const output = redactor.redact(text);
  const elapsed = performance.now() - started;
  assertHidden(output, held.map(entry => entry.value), "large text");
  assert.ok(elapsed < 1_000, `took ${Math.round(elapsed)} ms`);
});

test("original command output and component receipts keep placeholders only", async () => {
  const { originalChildEnvironment, runOriginalProcess, createOriginalCommandRunner } = await import("../server/original-runtime.ts");
  const { bundle, context, projectWorkspace } = await import("./original-runtime-harness.ts");
  const [held, pattern] = [synthetic(40), `ghp_${synthetic(36)}`];
  await refreshHeldCredentials({ ...noSources, environment: () => ({ VIVARY_PROBE_TOKEN: held }) });
  try {
    const env = originalChildEnvironment(process.env, path.join(caseRoot, "unused-receipts.jsonl"));
    const printed = await runOriginalProcess(process.execPath,
      ["-e", "process.stdout.write(process.argv[1]); process.stderr.write(process.argv[2])", held, pattern], "", caseRoot, env);
    assertText(printed.stdout, "[redacted VIVARY_PROBE_TOKEN]");
    assertText(printed.stderr, "[redacted credential]");

    const { directory, runtime, data } = await bundle("vivary-redaction-receipts-");
    const root = path.join(directory, "project");
    await mkdir(root);
    const runner = createOriginalCommandRunner({ parallelism: 1,
      environment: () => ({ VIVARY_ORIGINAL_RUNTIME: runtime, VIVARY_DATA_DIR: data }),
      resolveWorkspace: async () => projectWorkspace("project-a", root),
      execute: async (_python, args, _stdin, _cwd, environment) => {
        await writeFile(environment.VIVARY_RECEIPT_LOG!, JSON.stringify({ command: args[6], note: `used ${held} and ${pattern}` }) + "\n");
        return { exitCode: 0, stdout: "{}", stderr: "", signal: null };
      } });
    await runner({ projectId: "project-a", command: { verb: "pattern-state" } }, context);
    const receipts = await readFile(path.join(data, "original-runtime", "receipts.jsonl"), "utf8");
    assertHidden(receipts, [held, pattern], "receipts");
    assertMatch(receipts, /used \[redacted VIVARY_PROBE_TOKEN\] and \[redacted credential\]/);
    await rm(directory, { recursive: true, force: true });
  } finally {
    await refreshHeldCredentials(noSources);
  }
});

test("server output is redacted, including console output and direct writes", async () => {
  const [held, pattern] = [synthetic(40), `sk-${synthetic(40)}`];
  const plugin = pathToFileURL(path.join(import.meta.dirname, "..", "server", "plugins", "00-credential-redaction.ts")).href;
  // The child receives the values as arguments and through its environment, never in this file's text.
  const script = `const { default: plugin } = await import(${JSON.stringify(plugin)});
plugin({});
const [held, pattern] = process.argv.slice(-2);
console.error("console", held, pattern);
process.stderr.write("direct " + held + " " + pattern + "\\n");
console.log("stdout", held);
process.stdout.write(Buffer.from("buffer " + held + "\\n"));
// A pending database read must not keep the child alive.
setTimeout(() => process.exit(0), 200).unref();`;
  // A failure message would quote the command line, so it reports the masked output instead.
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, "--", held, pattern], {
    cwd: path.join(import.meta.dirname, ".."), timeout: 60_000,
    env: { ...process.env, VIVARY_PROBE_TOKEN: held, DATABASE_URL: `file:${path.join(caseRoot, "plugin.sqlite")}` },
  }).catch((error: { code?: unknown; stderr?: string }) =>
    assert.fail(`the server child failed (${String(error.code)}): ${masked(String(error.stderr ?? "")).slice(0, 2_000)}`));
  assertHidden(stdout + stderr, [held, pattern], "server output");
  assertMatch(stderr, /console \[redacted VIVARY_PROBE_TOKEN\] \[redacted credential\]/);
  assertMatch(stderr, /direct \[redacted VIVARY_PROBE_TOKEN\] \[redacted credential\]/);
  assertMatch(stdout, /stdout \[redacted VIVARY_PROBE_TOKEN\]\nbuffer \[redacted VIVARY_PROBE_TOKEN\]/);
});

test("adversarial single-line text is redacted in linear time", () => {
  const held = Array.from({ length: 40 }, (_, index) => ({ name: `SYNTH_${index}_API_KEY`, value: synthetic(24 + index) }));
  const redactor = createCredentialRedactor(held);
  const inputs: Record<string, string> = {
    "dash-joined words": "ab-".repeat(87_382), "base64url": randomBytes(786_432).toString("base64url"),
    "dotted pairs": "a.".repeat(131_072), "name separators": "token:".repeat(43_690), "scheme-like runs": "a:/".repeat(87_382),
    "bearer runs": "Bearer ".repeat(37_449), "prefix runs": "sk-".repeat(87_382), "jwt-like runs": "eyJ.".repeat(65_536),
  };
  for (const [label, text] of Object.entries(inputs)) {
    const started = performance.now();
    redactor.redact(text);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1_000, `${label} took ${Math.round(elapsed)} ms`);
  }
});

test("ordinary names, CSS classes, and prose are not redacted", () => {
  const value = synthetic(40);
  for (const name of ["nextPageToken", "pageToken", "NextToken", "continuation_token", "page_token", "s3Key", "cacheKey",
    "object_key", "primaryKey", "publicKey", "KEY_ID", "kms_key_id", "api_key_id", "secret_arn", "secretName",
    "idempotencyKey", "access_token_expires_at", "SSH_KEY_PATH", "TOKEN_FILE", "SECRETS_DIR", "AUTH_ENDPOINT"]) {
    assertText(redactCredentialPatterns(`${name}=${value}`), `${name}=${value}`, name);
    assertText(redactCredentialPatterns(`"${name}": "${value}"`), `"${name}": "${value}"`, name);
  }
  for (const text of [".sk-circle-bounce-delay-animation { }", "div.sk-fading-circle-container-large", "Bearer token-based-authentication-v2",
    "Bearer tokens-for-machine-to-machine-calls"]) assertText(redactCredentialPatterns(text), text);
  // The credential names beside them still redact.
  for (const name of ["access_token", "refresh_token", "api_key", "clientSecret", "privateKey", "password"]) {
    assertText(redactCredentialPatterns(`${name}=${value}`), `${name}=[redacted credential]`, name);
  }
});

test("Stripe, GitLab, and JSON Web Token formats are redacted, and look-alikes are not", () => {
  const jwt = `eyJ${synthetic(20)}.eyJ${synthetic(40)}.${synthetic(43)}`;
  for (const token of [`sk_live_${synthetic(24)}`, `rk_live_${synthetic(24)}`, `glpat-${synthetic(20)}`, jwt]) {
    generated.push(token);
    assertText(redactCredentialPatterns(`value ${token} end`), "value [redacted credential] end");
  }
  for (const text of ["sk_live_ is the live prefix", "rk_live_short", "glpat- is the GitLab prefix", "eyJhbGciOiJIUzI1NiJ9 alone",
    "version 1.2.3 and eyJ.a.b", "sk_test_placeholder_value", "a.eyJ.b"]) assertText(redactCredentialPatterns(text), text);
});

test("a value that starts with a slash is held unless its setting names a path", async () => {
  const [awsSecret, keyPath, credentials, folder] = [`/${synthetic(39)}`, `/home/owner/${synthetic(20)}/key.pem`,
    `/home/owner/${synthetic(20)}.json`, `/var/lib/${synthetic(20)}`];
  await refreshHeldCredentials({ ...noSources, environment: () => ({ AWS_SECRET_ACCESS_KEY: awsSecret, SSH_KEY_PATH: keyPath,
    GOOGLE_APPLICATION_CREDENTIALS: credentials, SECRETS_DIR: folder }) });
  try {
    assertText(redactCredentials(`secret ${awsSecret} end`), "secret [redacted AWS_SECRET_ACCESS_KEY] end");
    for (const text of [keyPath, credentials, folder]) assertText(redactCredentials(text), text);
    assertText(redactCredentialPatterns(`AWS_SECRET_ACCESS_KEY=${awsSecret}`), "AWS_SECRET_ACCESS_KEY=[redacted credential]");
    assertText(redactCredentialPatterns(`GOOGLE_APPLICATION_CREDENTIALS=${credentials}`), `GOOGLE_APPLICATION_CREDENTIALS=${credentials}`);
  } finally {
    await refreshHeldCredentials(noSources);
  }
});

test("a credential-named query value in a database URL is held", async () => {
  const authToken = synthetic(48);
  await refreshHeldCredentials({ ...noSources, environment: () => ({
    DATABASE_URL: `libsql://db-probe.example.test?authToken=${authToken}&tls=1` }) });
  try {
    assertText(redactCredentials(`token ${authToken} end`), "token [redacted DATABASE_URL] end");
    assertText(redactCredentials("libsql://db-probe.example.test"), "libsql://db-probe.example.test");
  } finally {
    await refreshHeldCredentials(noSources);
  }
});

test("saving or deleting a stored secret reloads the held set without a send", async () => {
  const { writeAppSecret, deleteAppSecret } = await import("@agent-native/core/secrets");
  const { putSetting } = await import("@agent-native/core/settings");
  assert.equal(typeof watchHeldCredentialSources, "function", "the redaction module does not watch secret writes");
  const until = async (done: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !done(); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  };
  const stop = watchHeldCredentialSources({ ...defaultCredentialSources, environment: () => ({}), mcpConfig: () => null });
  const [saved, legacy] = [synthetic(44), synthetic(40)];
  try {
    await writeAppSecret({ key: "ANTHROPIC_API_KEY", value: saved, scope: "user", scopeId: "watch@example.test" });
    await until(() => redactCredentials(saved) !== saved);
    assertText(redactCredentials(saved), "[redacted ANTHROPIC_API_KEY]");
    await putSetting("u:watch@example.test:credential:WATCH_TOKEN", { value: legacy });
    await until(() => redactCredentials(legacy) !== legacy);
    assertText(redactCredentials(legacy), "[redacted WATCH_TOKEN]");
    await deleteAppSecret({ key: "ANTHROPIC_API_KEY", scope: "user", scopeId: "watch@example.test" });
    await until(() => redactCredentials(saved) === saved);
    assertText(redactCredentials(saved), saved);
  } finally {
    stop();
    await refreshHeldCredentials(noSources);
  }
});

test("the streamed delta holdback covers the longest held form", async () => {
  assert.equal(typeof heldCredentialHoldback, "function", "the redaction module has no holdback");
  const long = synthetic(403);
  await refreshHeldCredentials({ ...noSources, environment: () => ({ REFRESH_TOKEN: long }) });
  try {
    assert.ok(heldCredentialHoldback() >= Buffer.from(long).toString("base64").length);
  } finally {
    await refreshHeldCredentials(noSources);
  }
  assert.equal(heldCredentialHoldback(), 256);
});

test("credential names that contain a pagination word, and webhook URLs, are redacted", () => {
  const value = synthetic(40);
  for (const name of ["NEXTAUTH_SECRET", "PAGERDUTY_API_KEY", "CURSOR_API_KEY", "NEXTCLOUD_PASSWORD", "PAGE_ADMIN_PASSWORD"]) {
    assertText(redactCredentialPatterns(`${name}=${value}`), `${name}=[redacted credential]`, name);
  }
  const slack = `https://hooks.slack.com/services/T0000/B0000/${synthetic(24)}`;
  const discord = `https://discord.com/api/webhooks/1234567890/${synthetic(40)}`;
  generated.push(slack, discord);
  assertText(redactCredentialPatterns(`SLACK_WEBHOOK_URL=${slack}`), "SLACK_WEBHOOK_URL=[redacted credential]");
  assertText(redactCredentialPatterns(`DISCORD_WEBHOOK=${discord}`), "DISCORD_WEBHOOK=[redacted credential]");
  assertText(redactCredentialPatterns(`"slackWebhookUrl": "${slack}"`), '"slackWebhookUrl": "[redacted credential]"');
  assertText(redactCredentialPatterns("OPENAI_BASE_URL=https://api.example.test/v1"), "OPENAI_BASE_URL=https://api.example.test/v1");
});

test("a dotted held value that looks like a token is held, and a host name is not", async () => {
  const label = () => `${randomBytes(8).toString("hex").slice(0, 10)}7a`;
  const dotted = `${label()}.${label()}`;
  generated.push(dotted);
  await refreshHeldCredentials({ ...noSources, environment: () => ({ SERVICE_TOKEN: dotted, CACHE_TOKEN_HOST: "cache.internal.example.com" }) });
  try {
    assertText(redactCredentials(`token ${dotted} end`), "token [redacted SERVICE_TOKEN] end");
    assertText(redactCredentials("cache.internal.example.com"), "cache.internal.example.com");
  } finally {
    await refreshHeldCredentials(noSources);
  }
});
