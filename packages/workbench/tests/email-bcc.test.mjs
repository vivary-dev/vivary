import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as esbuild from "esbuild";

// Exercise the installed action, markdown renderer, and transport together.
// Only credentials, logging, app metadata, and HTTP delivery are test boundaries.
const workbench = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = realpathSync(path.join(workbench, "node_modules/@agent-native/core"));
const stateModule = "email-fixture-state";
const boundaries = new Map([
  [stateModule, "export const state = { secrets: {}, records: [] };"],
  [path.join(core, "dist/server/credential-provider.js"),
    'import { state } from "email-fixture-state"; export const resolveSecret = async name => state.secrets[name] ?? null; export const readDeployCredentialEnv = name => state.secrets[name] ?? null;'],
  [path.join(core, "dist/email-catalog/log.js"),
    'import { state } from "email-fixture-state"; export const recordEmailSend = async entry => { state.records.push(entry); }; export const getScopedEmailProviderCategory = () => "email-fixture";'],
  [path.join(core, "dist/app-config/index.js"),
    'export const getAppConfig = () => ({ app: { slug: "email-fixture" } });'],
  [path.join(core, "dist/server/request-context.js"),
    "export const getRequestOrgId = () => undefined;"],
]);
const bundle = await esbuild.build({
  stdin: {
    contents: 'export { createCoreEmailActionEntries } from ' + JSON.stringify(path.join(core, "dist/server/email-actions.js")) +
      '; export { sendEmail } from ' + JSON.stringify(path.join(core, "dist/server/email.js")) +
      '; export { state } from "email-fixture-state";',
    resolveDir: workbench,
    sourcefile: "email-bcc-fixture.mjs",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [{
    name: "email-test-boundaries",
    setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        const resolved = args.path === stateModule ? stateModule : path.resolve(args.resolveDir, args.path);
        return boundaries.has(resolved) ? { path: resolved, namespace: "email-test" } : undefined;
      });
      build.onLoad({ filter: /.*/, namespace: "email-test" }, args => ({
        contents: boundaries.get(args.path), loader: "js",
      }));
    },
  }],
});
const { createCoreEmailActionEntries, sendEmail, state } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
test.after(() => esbuild.stop());

const message = {
  to: "recipient@example.test",
  cc: "copy@example.test",
  replyTo: "reply@example.test",
  subject: "Fixture delivery",
  body: "Only the intended message.",
};
const blind = "blind@example.test";

async function deliver(provider, operation, { status = 202, mode = "production" } = {}) {
  const fetchBefore = globalThis.fetch;
  const modeBefore = process.env.NODE_ENV;
  const logBefore = console.log;
  const requests = [];
  const logs = [];
  state.secrets = {
    RESEND_API_KEY: provider === "resend" ? "synthetic-resend-key" : null,
    SENDGRID_API_KEY: provider === "sendgrid" ? "synthetic-sendgrid-key" : null,
    EMAIL_FROM: "Fixture <sender@example.test>",
  };
  state.records = [];
  // guard:allow-env-mutation - Test-only mode for the existing development fallback, restored in finally.
  process.env.NODE_ENV = mode;
  console.log = (...args) => { logs.push(args); };
  globalThis.fetch = async (url, options) => {
    const expected = provider === "resend" ? "https://api.resend.com/emails"
      : provider === "sendgrid" ? "https://api.sendgrid.com/v3/mail/send" : null;
    assert.equal(url, expected, "no request may reach an unexpected endpoint");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, "Bearer synthetic-" + provider + "-key");
    requests.push(JSON.parse(options.body));
    return new Response(status >= 400 ? "Synthetic provider refusal" : "", { status });
  };
  try {
    return { result: await operation(), requests, logs };
  } finally {
    globalThis.fetch = fetchBefore;
    console.log = logBefore;
    // guard:allow-env-mutation - Restore the test process's original unset mode.
    if (modeBefore === undefined) delete process.env.NODE_ENV;
    // guard:allow-env-mutation - Restore the test process's original mode.
    else process.env.NODE_ENV = modeBefore;
    state.secrets = {};
    state.records = [];
  }
}

function recipients(payload, provider) {
  return provider === "resend" ? payload : payload.personalizations[0];
}
function bccValue(provider, values) {
  return provider === "resend" ? values : values.map(email => ({ email }));
}
function assertBlindOnly(payload, provider, values) {
  const visible = structuredClone(payload);
  delete recipients(visible, provider).bcc;
  for (const address of values) {
    assert.equal(JSON.stringify(visible).includes(address), false,
      "a blind recipient must not appear in visible recipients, headers, or content");
  }
}

for (const provider of ["resend", "sendgrid"]) {
  test(provider + ": the action delivers its normalized BCC without exposing it", async () => {
    const observed = await deliver(provider, () => createCoreEmailActionEntries()["core-send-email"].run({
      ...message, bcc: "  " + blind + "  ",
    }));
    assert.equal(observed.requests.length, 1);
    const envelope = recipients(observed.requests[0], provider);
    assert.deepEqual(envelope.bcc, bccValue(provider, [blind]));
    assert.deepEqual(envelope.to, provider === "resend" ? message.to : [{ email: message.to }]);
    assert.deepEqual(envelope.cc, bccValue(provider, [message.cc]));
    assertBlindOnly(observed.requests[0], provider, [blind]);
    assert.equal(observed.result, 'Email sent to recipient@example.test (bcc: blind@example.test): "Fixture delivery"');
  });

  test(provider + ": absent or blank BCC is omitted", async () => {
    for (const bcc of [undefined, "", " \t "]) {
      const observed = await deliver(provider, () => createCoreEmailActionEntries()["core-send-email"].run({
        ...message, bcc,
      }));
      assert.equal(observed.requests.length, 1);
      assert.equal(Object.hasOwn(recipients(observed.requests[0], provider), "bcc"), false);
      assert.equal(observed.result, 'Email sent to recipient@example.test: "Fixture delivery"');
    }
  });

  test(provider + ": the transport preserves a BCC list", async () => {
    const values = ["first-blind@example.test", "second-blind@example.test"];
    const observed = await deliver(provider, () => sendEmail({
      to: message.to, subject: message.subject, html: "<p>Private fixture</p>", bcc: values,
    }));
    assert.equal(observed.requests.length, 1);
    assert.deepEqual(recipients(observed.requests[0], provider).bcc, bccValue(provider, values));
    assertBlindOnly(observed.requests[0], provider, values);
  });

  test(provider + ": a rejected BCC request is not reported as sent", async () => {
    const observed = await deliver(provider, () => createCoreEmailActionEntries()["core-send-email"].run({
      ...message, bcc: blind,
    }), { status: 400 });
    assert.equal(observed.requests.length, 1);
    assert.deepEqual(recipients(observed.requests[0], provider).bcc, bccValue(provider, [blind]));
    assert.match(observed.result, /^Error sending email: .*error 400: Synthetic provider refusal$/);
    assert.equal(observed.result.includes("Email sent"), false);
  });
}

for (const mode of ["production", "development"]) {
  test(mode + ": without a provider BCC is refused instead of claiming delivery", async () => {
    const observed = await deliver("none", () => createCoreEmailActionEntries()["core-send-email"].run({
      ...message, bcc: blind,
    }), { mode });
    assert.match(observed.result, /^Error sending email: No email provider configured/);
    assert.equal(observed.requests.length, 0);
    assert.equal(observed.logs.length, 0, "refusal must not print the message");
  });
}
