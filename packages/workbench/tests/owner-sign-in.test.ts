import { VIVARY_OWNER_SESSION_STORAGE_KEY } from "../shared/owner-session.ts";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

import {
  createVivaryOwnerSignIn,
  VIVARY_OWNER_SIGN_IN_FILE,
  VIVARY_OWNER_SIGN_IN_HEADER,
  VIVARY_OWNER_SIGN_IN_HTML,
} from "../server/owner-sign-in.ts";

const ORIGIN = "http://127.0.0.1:4317";
const SECRET = "s".repeat(43);
const KEY = VIVARY_OWNER_SESSION_STORAGE_KEY;
const STORAGE_CHECK = [`set ${KEY}:check 1`, `remove ${KEY}:check`];
const OWNER = { email: "owner@local.vivary.test", name: "Local owner" };
const SIGNED_OUT = { error: "Not authenticated" };

type PageStorage = Map<string, string> | "blocked" | "failing";
type SessionAnswer = object | Error | number;
type Listener = () => unknown;

const sessionStep = (headers: Record<string, string>) => `session ${JSON.stringify(headers)}`;

// Answers like the session resolver, which checks a known stored token before the one-time secret.
const server = (known: string[] = [], issued = "fresh-session-token") =>
  (headers: Record<string, string>): SessionAnswer => {
    const stored = headers["x-vivary-session"];
    if (stored !== undefined && known.includes(stored)) return { ...OWNER, token: stored };
    if (headers[VIVARY_OWNER_SIGN_IN_HEADER] === SECRET) return { ...OWNER, token: issued };
    return SIGNED_OUT;
  };

// Runs a sign-in page in a fake browser. Like a real one, it runs the head
// script before it parses the body. A number answer is a non-OK status and an
// Error answer is a failed request.
async function openSignInPage(
  html: string,
  { hash = "", storage = new Map(), answer = server() }: {
    hash?: string;
    storage?: PageStorage;
    answer?: (headers: Record<string, string>) => SessionAnswer;
  } = {},
) {
  const script = /^<!doctype html>\s*<html lang="en">\s*<head>\s*(?:<meta [^>]*>\s*)*<script>([\s\S]*?)<\/script>/
    .exec(html)?.[1];
  assert.ok(script, "the sign-in script is the first script in the head, after only meta tags");
  const messages = new Map([...html.matchAll(/<div id="([\w-]+)" hidden>/g)]
    .map(([, id]): [string, { hidden: boolean }] => [id, { hidden: true }]));
  const steps: string[] = [];
  const requests: Array<{ target: string; init: RequestInit; hash: string }> = [];
  const windowListeners = new Map<string, Listener[]>();
  const documentListeners = new Map<string, Listener[]>();
  const listen = (listeners: Map<string, Listener[]>) => (type: string, listener: Listener) => {
    listeners.set(type, [...(listeners.get(type) ?? []), listener]);
  };
  let storageReads = 0;
  const document = {
    readyState: "loading",
    addEventListener: listen(documentListeners),
    getElementById: (id: string) => (document.readyState === "loading" ? null : messages.get(id) ?? null),
  };
  const location = {
    hash,
    pathname: "/sign-in",
    replace: (target: string) => { steps.push(`replace ${target}`); },
  };
  const failing = () => { throw new Error("storage is full"); };
  const browserStorage = () => {
    storageReads++;
    const current = storage;
    if (current === "blocked") throw new Error("storage is blocked");
    if (current === "failing") return { getItem: failing, setItem: failing, removeItem: failing };
    return {
      getItem: (key: string) => current.get(key) ?? null,
      setItem: (key: string, value: string) => {
        steps.push(`set ${key} ${value}`);
        current.set(key, value);
      },
      removeItem: (key: string) => {
        steps.push(`remove ${key}`);
        current.delete(key);
      },
    };
  };
  const context = {
    addEventListener: listen(windowListeners),
    document,
    fetch: async (target: string, init: RequestInit & { headers: Record<string, string> }) => {
      requests.push({ target, init, hash: location.hash });
      steps.push(sessionStep(init.headers));
      const body = answer(init.headers);
      if (body instanceof Error) throw body;
      if (typeof body === "number") return { ok: false, status: body, json: async () => ({}) };
      return { ok: true, json: async () => body };
    },
    history: {
      replaceState: (_state: unknown, _title: string, target: string) => {
        location.hash = "";
        steps.push(`replaceState ${target}`);
      },
    },
    location,
  };
  Object.defineProperty(context, "localStorage", { get: browserStorage });
  Object.defineProperty(context, "sessionStorage", { get: browserStorage });

  const running = runInNewContext(script, context);
  const afterScript = { hash: location.hash, steps: [...steps] };
  document.readyState = "interactive";
  for (const listener of [...(documentListeners.get("DOMContentLoaded") ?? []),
    ...(windowListeners.get("DOMContentLoaded") ?? [])]) listener();
  await running;
  return {
    afterScript,
    requests,
    shown: () => [...messages].filter(([, message]) => !message.hidden).map(([id]) => id),
    steps,
    storageReads: () => storageReads,
    setStorage: (next: PageStorage) => { storage = next; },
    openAddress: async (next: string) => {
      const onHashChange = windowListeners.get("hashchange")?.[0];
      assert.ok(onHashChange, "the page listens for an address opened in the same tab");
      location.hash = next;
      await onHashChange();
    },
  };
}

describe("Vivary owner sign-in store", () => {
  it("saves each address in an owner-only file and replaces it after use", async (t) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "vivary-owner-sign-in-"));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const file = path.join(dataDir, VIVARY_OWNER_SIGN_IN_FILE);
    const readSecret = async () => {
      const address = await readFile(file, "utf8");
      assert.match(address, /^http:\/\/127\.0\.0\.1:4317\/sign-in#[\w-]{43}\n$/);
      if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
      return address.trim().split("#")[1];
    };

    const signIn = createVivaryOwnerSignIn({ origin: ORIGIN, dataDir });
    const first = await readSecret();
    assert.equal(signIn.redeem(first), true);
    assert.notEqual(await readSecret(), first);
    assert.equal(signIn.redeem(first), false);
    assert.deepEqual(await readdir(dataDir), [VIVARY_OWNER_SIGN_IN_FILE]);
  });

  it("still signs in once when the next address cannot be saved, and logs no secret", (t) => {
    const output: string[] = [];
    t.mock.method(process.stderr, "write", (chunk: string) => {
      output.push(chunk);
      return true;
    });
    const saved: string[] = [];
    const signIn = createVivaryOwnerSignIn({
      origin: ORIGIN,
      dataDir: "/unused",
      saveFile: (_file, contents) => {
        if (saved.length > 0) throw new Error(`could not save ${contents}`);
        saved.push(contents);
      },
    });
    const secret = saved[0].trim().split("#")[1];

    assert.equal(signIn.redeem(secret), true);
    assert.equal(signIn.redeem(secret), false);
    assert.equal(output.length, 1);
    assert.match(output[0], /^\[vivary-local-access\] [^\n]+\n$/);
    assert.doesNotMatch(output[0], /sign-in#|127\.0\.0\.1/);
    assert.ok(!output[0].includes(secret));
  });
});

describe("Vivary owner sign-in page", () => {
  it("runs as the first script, after the referrer policy, and holds no secret, form, or outside address", () => {
    for (const html of Object.values(VIVARY_OWNER_SIGN_IN_HTML)) {
      assert.match(html, /^<!doctype html>\n<html lang="en">\n<head>\n {2}<meta charset="utf-8">\n(?: {2}<meta [^>]*>\n)* {2}<script>/);
      assert.match(html.slice(0, html.indexOf("<script>")), /<meta name="referrer" content="no-referrer">/);
      assert.match(html, /<noscript>/);
      assert.match(html, /owner-sign-in\.txt/);
      assert.doesNotMatch(html, /http-equiv|src=|href=|https?:\/\//i);
      assert.doesNotMatch(html, /email|password|signup|<form/i);
    }
    const pageCopy = (html: string) => html.slice(0, html.indexOf("<script>")) + html.slice(html.lastIndexOf("</script>") + "</script>".length);
    const storageMessage = /\n {2}<div id="storage-blocked" hidden>[\s\S]*?<\/div>/;
    assert.match(VIVARY_OWNER_SIGN_IN_HTML["private-proxy"], storageMessage);
    assert.doesNotMatch(VIVARY_OWNER_SIGN_IN_HTML.local, storageMessage);
    assert.equal(
      pageCopy(VIVARY_OWNER_SIGN_IN_HTML["private-proxy"]).replace(storageMessage, ""),
      pageCopy(VIVARY_OWNER_SIGN_IN_HTML.local),
    );
  });

  it("removes the secret from the address before anything else runs", async () => {
    for (const html of Object.values(VIVARY_OWNER_SIGN_IN_HTML)) {
      for (const hash of [`#${SECRET}`, `#${SECRET.slice(1)}`]) {
        const page = await openSignInPage(html, { hash, answer: server() });
        assert.equal(page.afterScript.hash, "");
        assert.deepEqual(page.afterScript.steps.slice(0, 1), ["replaceState /sign-in"]);
        for (const request of page.requests) {
          assert.equal(request.target, "/_agent-native/auth/session");
          assert.equal(request.hash, "", "the session request leaves after the address is cleaned");
          assert.equal(request.init.credentials, "same-origin");
          assert.equal(request.init.cache, "no-store");
        }
      }
    }
  });

  it("waits for the body before it shows a message", async () => {
    const page = await openSignInPage(VIVARY_OWNER_SIGN_IN_HTML.local, { hash: `#${SECRET.slice(1)}` });
    assert.deepEqual(page.afterScript.steps, ["replaceState /sign-in"]);
    assert.deepEqual(page.steps, ["replaceState /sign-in"]);
    assert.deepEqual(page.shown(), ["help"]);

    const blocked = await openSignInPage(VIVARY_OWNER_SIGN_IN_HTML["private-proxy"], {
      hash: `#${SECRET}`,
      storage: "blocked",
    });
    assert.deepEqual(blocked.shown(), ["storage-blocked"]);
  });

  it("signs in with a valid address and shows help for anything else on the local page", async () => {
    const html = VIVARY_OWNER_SIGN_IN_HTML.local;
    const signedIn = () => ({ ...OWNER, token: "cookie-session-token" });
    const signedOut = () => SIGNED_OUT;
    const withSecret = sessionStep({ [VIVARY_OWNER_SIGN_IN_HEADER]: SECRET });

    for (const [hash, answer, steps, shown] of [
      [`#${SECRET}`, signedIn, ["replaceState /sign-in", withSecret, "replace /"], []],
      [`#${SECRET}`, signedOut, ["replaceState /sign-in", withSecret], ["help"]],
      [`#${SECRET.slice(1)}`, signedIn, ["replaceState /sign-in"], ["help"]],
      ["", signedIn, [sessionStep({}), "replace /"], []],
      ["", signedOut, [sessionStep({})], ["help"]],
    ] as const) {
      const page = await openSignInPage(html, { hash, answer });
      assert.deepEqual(page.steps, steps, hash);
      assert.deepEqual(page.shown(), shown, hash);
    }
  });

  it("signs in from an address opened on the open page", async () => {
    const local = await openSignInPage(VIVARY_OWNER_SIGN_IN_HTML.local);
    assert.deepEqual(local.shown(), ["help"]);
    await local.openAddress(`#${SECRET}`);
    assert.deepEqual(local.steps, [
      sessionStep({}),
      "replaceState /sign-in",
      sessionStep({ [VIVARY_OWNER_SIGN_IN_HEADER]: SECRET }),
      "replace /",
    ]);

    const storage = new Map<string, string>();
    const proxy = await openSignInPage(VIVARY_OWNER_SIGN_IN_HTML["private-proxy"], { storage });
    assert.deepEqual(proxy.shown(), ["help"]);
    await proxy.openAddress(`#${SECRET}`);
    assert.deepEqual(proxy.steps, [
      ...STORAGE_CHECK,
      sessionStep({}),
      `remove ${KEY}`,
      "replaceState /sign-in",
      ...STORAGE_CHECK,
      sessionStep({ [VIVARY_OWNER_SIGN_IN_HEADER]: SECRET }),
      `set ${KEY} fresh-session-token`,
      "replace /",
    ]);
  });

  describe("private proxy storage", () => {
    const html = VIVARY_OWNER_SIGN_IN_HTML["private-proxy"];

    it("stores the session token after a successful exchange", async () => {
      const storage = new Map<string, string>();
      const page = await openSignInPage(html, { hash: `#${SECRET}`, storage });
      assert.deepEqual(page.steps, [
        "replaceState /sign-in",
        ...STORAGE_CHECK,
        sessionStep({ [VIVARY_OWNER_SIGN_IN_HEADER]: SECRET }),
        `set ${KEY} fresh-session-token`,
        "replace /",
      ]);
      assert.deepEqual(page.shown(), []);
      assert.deepEqual([...storage], [[KEY, "fresh-session-token"]]);

      for (const issued of ["bad token", "bad\ntoken", "x".repeat(4097)]) {
        const unstored = new Map<string, string>();
        const malformed = await openSignInPage(html, { hash: `#${SECRET}`, storage: unstored, answer: server([], issued) });
        assert.equal(malformed.steps.at(-1), "replace /");
        assert.deepEqual([...unstored], [], "a malformed token is never stored");
      }
    });

    it("signs in with a stored token on a plain visit and sends it beside a secret", async () => {
      const storage = new Map([[KEY, "owner-session-token"]]);
      const known = server(["owner-session-token"]);
      const plain = await openSignInPage(html, { storage, answer: known });
      assert.deepEqual(plain.steps, [
        ...STORAGE_CHECK,
        sessionStep({ "x-vivary-session": "owner-session-token" }),
        `set ${KEY} owner-session-token`,
        "replace /",
      ]);

      const withSecret = await openSignInPage(html, { hash: `#${SECRET}`, storage, answer: known });
      assert.deepEqual(withSecret.steps, [
        "replaceState /sign-in",
        ...STORAGE_CHECK,
        sessionStep({ "x-vivary-session": "owner-session-token", [VIVARY_OWNER_SIGN_IN_HEADER]: SECRET }),
        `set ${KEY} owner-session-token`,
        "replace /",
      ]);
      assert.deepEqual([...storage], [[KEY, "owner-session-token"]]);
    });

    it("forgets a stored token the server no longer knows", async () => {
      const storage = new Map([[KEY, "stale-session-token"]]);
      const page = await openSignInPage(html, { storage });
      assert.deepEqual(page.steps, [
        ...STORAGE_CHECK,
        sessionStep({ "x-vivary-session": "stale-session-token" }),
        `remove ${KEY}`,
      ]);
      assert.deepEqual(page.shown(), ["help"]);
      assert.deepEqual([...storage], []);

      for (const malformed of ["bad token", "x".repeat(4097)]) {
        const unsent = await openSignInPage(html, { storage: new Map([[KEY, malformed]]) });
        assert.deepEqual(unsent.steps, [...STORAGE_CHECK, sessionStep({}), `remove ${KEY}`]);
      }

      for (const failure of [new Error("offline"), 502]) {
        const kept = new Map([[KEY, "owner-session-token"]]);
        const failed = await openSignInPage(html, { storage: kept, answer: () => failure });
        assert.deepEqual(failed.shown(), ["help"]);
        assert.deepEqual([...kept], [[KEY, "owner-session-token"]], "a failed check keeps the stored token");
      }
    });

    it("keeps the secret and asks for site storage when storage is blocked or failing", async () => {
      for (const storage of ["blocked", "failing"] as const) {
        const page = await openSignInPage(html, { hash: `#${SECRET}`, storage });
        assert.deepEqual(page.requests, [], "no request carries the secret");
        assert.deepEqual(page.steps, ["replaceState /sign-in"]);
        assert.deepEqual(page.shown(), ["storage-blocked"]);

        const plain = await openSignInPage(html, { storage });
        await plain.openAddress(`#${SECRET}`);
        assert.deepEqual(plain.requests, []);
        assert.deepEqual(plain.shown(), ["storage-blocked"]);
      }
    });

    it("shows only one message when storage changes between addresses in the same tab", async () => {
      const page = await openSignInPage(html, { hash: `#${SECRET}`, storage: "blocked" });
      assert.deepEqual(page.shown(), ["storage-blocked"]);
      page.setStorage(new Map());
      await page.openAddress(`#${"o".repeat(43)}`);
      assert.deepEqual(page.shown(), ["help"], "an old address after storage is allowed shows only help");
      page.setStorage("blocked");
      await page.openAddress(`#${SECRET}`);
      assert.deepEqual(page.shown(), ["storage-blocked"]);
    });

    it("keeps the local page away from browser storage", async () => {
      for (const [hash, answer] of [
        ["", () => SIGNED_OUT],
        ["", server(["owner-session-token"])],
        [`#${SECRET}`, server(["owner-session-token"])],
      ] as const) {
        const storage = new Map([[KEY, "owner-session-token"]]);
        const page = await openSignInPage(VIVARY_OWNER_SIGN_IN_HTML.local, { hash, storage, answer });
        await page.openAddress(`#${SECRET}`);
        assert.equal(page.storageReads(), 0);
        assert.ok(page.steps.every(step => !step.includes("x-vivary-session")));
        assert.deepEqual([...storage], [[KEY, "owner-session-token"]]);
      }
    });
  });
});
