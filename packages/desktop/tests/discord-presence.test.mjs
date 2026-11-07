import assert from "node:assert/strict";
import { test } from "node:test";

import { createDiscordPresenceController, buildDiscordActivity, presenceStateLine, sanitizePresenceText } from "../discord-presence.mjs";

test("presence text strips control characters and paths", () => {
  assert.equal(sanitizePresenceText("  Alpha\r\n"), "Alpha");
  assert.equal(sanitizePresenceText("C:\\secret\\project"), "");
});

test("activity uses project details and phase state", () => {
  const activity = buildDiscordActivity({
    phase: "agent",
    projectLabel: "Launch checklist",
    startedAt: 1_700_000_000,
  });
  assert.deepEqual(activity, {
    details: "Launch checklist",
    state: "Agent running",
    startTimestamp: 1_700_000_000_000,
    instance: true,
  });
});

test("personal workspace hides activity", () => {
  assert.equal(buildDiscordActivity({ phase: "hidden", projectLabel: null, startedAt: 1 }), null);
  assert.equal(presenceStateLine("idle"), "Managing memory");
  assert.equal(presenceStateLine("review"), "Reviewing");
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

function controllerFixture({ readSettings } = {}) {
  const clients = [];
  let settings = { discord: { enabled: false, applicationId: "123456789012345678" } };
  class FakeClient {
    constructor(options) {
      this.applicationId = options.clientId;
      this.events = [];
      this.handlers = {};
      this.user = null;
      this.loginResult = Promise.withResolvers();
      clients.push(this);
    }
    on(name, handler) { this.handlers[name] = handler; }
    async login() {
      await this.loginResult.promise;
      this.user = {
        setActivity: async (activity) => this.events.push({ activity }),
        clearActivity: async () => this.events.push("clear"),
      };
    }
    async destroy() { this.events.push("destroy"); this.user = null; }
    finishLogin() { this.loginResult.resolve(); }
  }
  const controller = createDiscordPresenceController({
    ClientImpl: FakeClient,
    readSettings: readSettings ?? (async () => settings),
  });
  return {
    controller,
    clients,
    enable(applicationId = settings.discord.applicationId) {
      settings = { discord: { enabled: true, applicationId } };
      return controller.reloadSettings();
    },
    disable() {
      settings = { discord: { ...settings.discord, enabled: false } };
      return controller.reloadSettings();
    },
    select() {
      controller.updateSnapshot({ phase: "agent", projectLabel: "Private launch", startedAt: 100 });
    },
  };
}

test("controller enables normally and clears a connected activity", async (t) => {
  const f = controllerFixture();
  t.after(() => f.controller.dispose());
  f.select();
  const enabled = f.enable();
  await flush();
  assert.equal(f.clients.length, 1);
  f.clients[0].finishLogin();
  await enabled;
  assert.equal(f.clients[0].events[0].activity.details, "Private launch");
  await f.controller.clear();
  assert.deepEqual(f.clients[0].events.slice(1), ["clear", "destroy"]);
});

for (const action of ["disable", "clear", "dispose"]) {
  test(`controller cancels ${action} during login without publishing later`, async (t) => {
    const f = controllerFixture();
    t.after(() => f.controller.dispose());
    f.select();
    const enabled = f.enable();
    await flush();
    const pending = f.clients[0];
    if (action === "disable") await f.disable();
    else await f.controller[action]();
    await flush();
    const destroyedBeforeLogin = pending.events.includes("destroy");
    pending.finishLogin();
    await enabled;
    await flush();
    assert.equal(pending.events.some((event) => event.activity), false, "cancelled login published a project");
    assert.ok(destroyedBeforeLogin, "pending login must be destroyed before it finishes");
  });
}

test("controller changes application ID during login without publishing on the old client", async (t) => {
  const f = controllerFixture();
  t.after(() => f.controller.dispose());
  f.select();
  const first = f.enable();
  await flush();
  const oldClient = f.clients[0];
  const second = f.enable("223456789012345678");
  await flush();
  const destroyedBeforeLogin = oldClient.events.includes("destroy");
  assert.equal(f.clients.length, 2);
  const newClient = f.clients[1];
  oldClient.finishLogin();
  await first;
  assert.equal(oldClient.events.some((event) => event.activity), false);
  assert.ok(destroyedBeforeLogin);
  newClient.finishLogin();
  await second;
  assert.equal(newClient.applicationId, "223456789012345678");
  assert.equal(newClient.events[0].activity.details, "Private launch");
});

test("controller keeps a newer connection when a cancelled login rejects", async (t) => {
  const f = controllerFixture();
  t.after(() => f.controller.dispose());
  f.select();
  const first = f.enable();
  await flush();
  const oldClient = f.clients[0];
  const second = f.enable("223456789012345678");
  await flush();
  const newClient = f.clients[1];
  newClient.finishLogin();
  await second;
  oldClient.loginResult.reject(new Error("cancelled login"));
  await first;
  f.controller.updateSnapshot({ phase: "review", projectLabel: "New project", startedAt: 100 });
  await flush();
  assert.equal(f.clients.length, 2);
  assert.equal(newClient.events.at(-1).activity.details, "New project");
  assert.equal(newClient.events.includes("destroy"), false);
});

test("controller clears and destroys an active client on dispose", async () => {
  const f = controllerFixture();
  f.select();
  const enabled = f.enable();
  await flush();
  f.clients[0].finishLogin();
  await enabled;
  f.controller.dispose();
  await flush();
  assert.deepEqual(f.clients[0].events.slice(1), ["clear", "destroy"]);
  f.select();
  await flush();
  assert.equal(f.clients.length, 1);
});

// PR #323 review B3. Startup and each settings message start their own reload. These reads finish in the order the
// test chooses, as a slow disk read can. A stale reload that wrongly connects waits on a login the test never
// finishes, so the tests flush instead of awaiting the older reload.
const ON = { discord: { enabled: true, applicationId: "123456789012345678" } };
const OFF = { discord: { enabled: false, applicationId: "123456789012345678" } };
const ON_OTHER_ID = { discord: { enabled: true, applicationId: "223456789012345678" } };

function heldReads() {
  const reads = [];
  return { reads, readSettings: () => {
    const read = Promise.withResolvers();
    reads.push(read);
    return read.promise;
  } };
}

test("an older On read that finishes after a newer Off read does not start sharing", async (t) => {
  const held = heldReads();
  const f = controllerFixture({ readSettings: held.readSettings });
  t.after(() => f.controller.dispose());
  f.select();
  void f.controller.reloadSettings();
  const newer = f.controller.reloadSettings();
  held.reads[1].resolve(OFF);
  await newer;
  held.reads[0].resolve(ON);
  await flush();
  assert.equal(f.clients.length, 0, "the superseded On read must not connect to Discord");
});

test("an older On read that finishes before a newer Off read leaves sharing off", async (t) => {
  const held = heldReads();
  const f = controllerFixture({ readSettings: held.readSettings });
  t.after(() => f.controller.dispose());
  f.select();
  void f.controller.reloadSettings();
  const newer = f.controller.reloadSettings();
  held.reads[0].resolve(ON);
  await flush();
  held.reads[1].resolve(OFF);
  await newer;
  for (const client of f.clients) client.finishLogin();
  await flush();
  assert.equal(f.clients.some((client) => client.events.some((event) => event.activity)), false,
    "no project is published once the newer Off read applies");
  assert.ok(f.clients.every((client) => client.events.includes("destroy")), "any started client is destroyed");
});

test("an older read of another application id does not replace the newer one", async (t) => {
  const held = heldReads();
  const f = controllerFixture({ readSettings: held.readSettings });
  t.after(() => f.controller.dispose());
  f.select();
  void f.controller.reloadSettings();
  const newer = f.controller.reloadSettings();
  held.reads[1].resolve(ON_OTHER_ID);
  await flush();
  assert.equal(f.clients.length, 1);
  f.clients[0].finishLogin();
  await newer;
  held.reads[0].resolve(ON);
  await flush();
  assert.equal(f.clients.length, 1, "the superseded read must not open a second client");
  assert.equal(f.clients[0].applicationId, "223456789012345678");
  assert.equal(f.clients[0].events.includes("destroy"), false);
  assert.equal(f.clients[0].events.at(-1).activity.details, "Private launch");
});

test("controller does not revive an old login after enabling the same application again", async (t) => {
  const f = controllerFixture();
  t.after(() => f.controller.dispose());
  f.select();
  const first = f.enable();
  await flush();
  const oldClient = f.clients[0];
  await f.disable();
  const second = f.enable();
  await flush();
  const newClient = f.clients[1];
  oldClient.finishLogin();
  await first;
  assert.equal(oldClient.events.some((event) => event.activity), false);
  f.controller.updateSnapshot({ phase: "review", projectLabel: "Current project", startedAt: 100 });
  await flush();
  assert.equal(f.clients.length, 2, "old completion must not discard the new pending connection");
  newClient.finishLogin();
  await second;
  await flush();
  assert.equal(newClient.events.at(-1).activity.details, "Current project");
});
