import assert from "node:assert/strict";
import { test } from "node:test";
import { H3 } from "h3";
import previewIsolation from "../server/plugins/03-preview-isolation.ts";

test("Workbench responses deny framing without replacing existing CSP", async () => {
  const callbacks = new Map<string, ((...args: any[]) => unknown)[]>();
  await previewIsolation({ hooks: { hook(name: string, callback: (...args: any[]) => unknown) {
    callbacks.set(name, [...(callbacks.get(name) ?? []), callback]);
  } } });
  const fire = async (name: string, ...args: unknown[]) => {
    for (const callback of callbacks.get(name) ?? []) await callback(...args);
  };
  const app = new H3({
    silent: true,
    onRequest: event => fire("request", event),
    onResponse: (response, event) => fire("response", response, event),
  });
  app.get("/", () => new Response("Vivary", { headers: {
    "content-security-policy": "default-src 'self'; script-src 'self'",
    "x-frame-options": "SAMEORIGIN",
  } }));
  app.get("/legacy", () => Response.redirect("http://localhost/"));
  const home = await app.request("http://localhost/");
  assert.equal(home.status, 200);
  assert.equal(home.headers.get("x-frame-options"), "DENY");
  assert.match(home.headers.get("content-security-policy") ?? "", /default-src 'self'; script-src 'self'/);
  assert.match(home.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  const redirect = await app.request("http://localhost/legacy");
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "http://localhost/");
  assert.equal(redirect.headers.get("x-frame-options"), "DENY");
  assert.match(redirect.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  const missing = await app.request("http://localhost/not-found");
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("x-frame-options"), "DENY");
  assert.match(missing.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
});
