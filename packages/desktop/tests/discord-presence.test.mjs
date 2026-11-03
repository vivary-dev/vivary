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

function controllerFixture() {
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
    readSettings: async () => settings,
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
