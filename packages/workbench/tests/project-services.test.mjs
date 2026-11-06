import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  loadProjectInstallation,
  loadProductionRuntime,
  parseProjectInstallation,
  PROJECT_ACTION_PATHS,
  startProjectServices,
} from "../server/project-services.mjs";
import { createProjectServicesPlugin } from "../server/plugins/01-project-services.mjs";

const validInstallation = () => ({
  python: "/usr/bin/python3",
  entryFile: "/srv/vivary/root_provider.py",
  provider: {
    deviceId: "zo",
    scope: "/srv/projects",
    statePath: "/srv/vivary/project-roots.json",
    locations: {
      alpha: "/srv/projects/alpha",
      beta: "/srv/projects/beta",
    },
  },
  grant: {
    orgId: "org-test",
    collectionId: "projects",
    policyRevision: 1,
    locationRefs: ["alpha", "beta"],
  },
  locationLabels: { alpha: "Alpha", beta: "Beta" },
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function fakeNitro() {
  const handlers = new Map();
  const hooks = new Map();
  const nitro = {
    hooks: {
      hook(name, callback) {
        const entries = hooks.get(name) ?? [];
        entries.push(callback);
        hooks.set(name, entries);
      },
    },
  };
  const getH3App = () => ({
    use(path, handler) {
      const entries = handlers.get(path) ?? [];
      entries.push(handler);
      handlers.set(path, entries);
    },
  });
  const callHook = async (name, ...args) => {
    for (const callback of hooks.get(name) ?? []) await callback(...args);
  };
  const request = async (pathname) => {
    const event = { url: new URL("http://example.test" + pathname), req: new Request("http://example.test" + pathname) };
    await callHook("request", event);
    let response;
    for (const handler of handlers.get(pathname) ?? []) {
      const value = await handler(event);
      if (value !== undefined) {
        response = value instanceof Response ? value : Response.json(value);
        break;
      }
    }
    response ??= pathname.startsWith("/_agent-native/") ? new Response("Not found", { status: 404 }) : new Response("shell");
    await callHook("response", response, event);
    return response;
  };
  return {
    nitro,
    signals: new EventEmitter(),
    getH3App,
    request,
    close: () => callHook("close"),
    mountCount: path => (handlers.get(path) ?? []).length,
  };
}

function fakeRuntime(options = {}) {
  const calls = [];
  const provider = {
    deviceId: "zo",
    locationRefs: ["alpha", "beta"],
    inspect: async () => ({ code: "unavailable" }),
    observe: async () => ({ code: "identity-unverified" }),
    close: async () => { calls.push(["provider.close"]); },
  };
  const readScope = async () => null;
  const action = name => ({ schema: {}, run: async () => ({ code: name }) });
  // Paths this runtime serves itself. The other project action paths are
  // served by discovered app actions and only receive the cold-start gate.
  const servicePaths = new Set();
  const mount = (name, path) => (nitro, value) => {
    calls.push([name, value]);
    servicePaths.add(path);
    options.getH3App(nitro).use(path, async () => {
      if (options.actionStarted) options.actionStarted.resolve();
      if (options.actionWait) await options.actionWait.promise;
      return Response.json({ code: name });
    });
  };
  return {
    calls,
    provider,
    readScope,
    servicePaths,
    migrateRegistry: async () => {
      calls.push(["migrateRegistry"]);
      if (options.failAt === "migration") throw new Error("private migration detail");
    },
    startRootProvider: async value => {
      calls.push(["startRootProvider", value]);
      if (options.providerStarted) options.providerStarted.resolve();
      if (options.providerWait) await options.providerWait.promise;
      if (options.failAt === "provider") throw new Error("private provider detail");
      return provider;
    },
    createNativeRegistry: value => {
      calls.push(["createNativeRegistry", value]);
      return { registration: action("registered"), readScope };
    },
    createNativeRegistryAuth: () => {
      const auth = { getOwnerFromEvent: async () => "owner@example.test", resolveOrgId: async () => "org-test" };
      calls.push(["createNativeRegistryAuth", auth]);
      return auth;
    },
    createProjectCatalog: value => {
      calls.push(["createProjectCatalog", value]);
      if (options.failAt === "catalog") throw new Error("private catalog detail");
      return action("catalog");
    },
    mountRegistryHttp: mount("mountRegistryHttp", PROJECT_ACTION_PATHS[0]),
    mountProjectCatalog: mount("mountProjectCatalog", PROJECT_ACTION_PATHS[1]),
    createProjectRuntimeReadiness: value => {
      calls.push(["createProjectRuntimeReadiness", value]);
      return action("readiness");
    },
    mountProjectRuntimeReadiness: mount("mountProjectRuntimeReadiness", PROJECT_ACTION_PATHS[2]),
    createProjectRuntimeActivity: value => {
      calls.push(["createProjectRuntimeActivity", value]);
      return action("activity");
    },
    mountProjectRuntimeActivity: mount("mountProjectRuntimeActivity", PROJECT_ACTION_PATHS[3]),
  };
}

function pluginDependencies(fixture, runtime, patch = {}) {
  return {
    getH3App: fixture.getH3App,
    shutdownSignals: fixture.signals,
    awaitBootstrap: async () => { runtime.calls.push(["awaitBootstrap"]); },
    loadInstallation: async () => validInstallation(),
    loadRuntime: async () => runtime,
    diagnostic: code => runtime.calls.push(["diagnostic", code]),
    ...patch,
  };
}

test("installation config is strict, immutable and optional", async () => {
  const parsed = parseProjectInstallation(validInstallation());
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.provider.locations));
  assert.ok(Object.isFrozen(parsed.grant.locationRefs));
  assert.throws(() => parseProjectInstallation({ ...validInstallation(), extra: true }), /invalid-configuration/);
  assert.throws(() => parseProjectInstallation({
    ...validInstallation(),
    locationLabels: { alpha: "Alpha" },
  }), /invalid-configuration/);
  assert.equal(await loadProjectInstallation(undefined, {
    readFile: async () => { throw new Error("must not read"); },
  }), null);
  await assert.rejects(loadProjectInstallation("/srv/vivary/install.json", {
    readFile: async () => '{"python":"/usr/bin/python3","python":"/tmp/other"}',
    realpath: async value => value,
    stat: async () => ({ isFile: () => true }),
  }), /invalid-configuration/);
});

test("production runtime loader resolves the actual service exports", async () => {
  const runtime = await loadProductionRuntime();
  for (const name of [
    "migrateRegistry",
    "createNativeRegistry",
    "createNativeRegistryAuth",
    "startRootProvider",
    "createProjectCatalog",
    "mountProjectCatalog",
    "mountRegistryHttp",
    "createProjectRuntimeReadiness",
    "mountProjectRuntimeReadiness",
    "createProjectRuntimeActivity",
    "mountProjectRuntimeActivity",
  ]) {
    assert.equal(typeof runtime[name], "function", name);
  }
});

test("actual plugin gates cold requests, mounts one shared registry once and leaves runtime unconfigured", async () => {
  const fixture = fakeNitro();
  const runtime = fakeRuntime({ getH3App: fixture.getH3App });
  const bootstrap = deferred();
  const dependencies = pluginDependencies(fixture, runtime, {
    awaitBootstrap: async () => {
      runtime.calls.push(["awaitBootstrap"]);
      await bootstrap.promise;
    },
  });
  const plugin = createProjectServicesPlugin(dependencies);
  const first = plugin(fixture.nitro);
  const second = plugin(fixture.nitro);
  // Paths project-services must serve itself. The remaining project action
  // paths belong to discovered app actions and receive the cold-start gate only.
  const expectedServicePaths = new Set([
    "/_agent-native/actions/vivary-register-project",
    "/_agent-native/actions/vivary-project-catalog",
    "/_agent-native/actions/vivary-project-runtime-readiness",
    "/_agent-native/actions/vivary-project-runtime-activity",
  ]);

  for (const path of PROJECT_ACTION_PATHS) {
    assert.equal((await fixture.request(path)).status, 503, `cold gate for ${path}`);
  }
  assert.equal((await fixture.request("/")).status, 200);
  bootstrap.resolve();
  assert.deepEqual(await first, { status: "open", failure: null });
  assert.deepEqual(await second, { status: "open", failure: null });
  assert.equal(runtime.calls.filter(([name]) => name === "startRootProvider").length, 1);

  assert.deepEqual([...runtime.servicePaths].sort(), [...expectedServicePaths].sort(),
    "every service-owned path was mounted, and nothing else");
  for (const path of PROJECT_ACTION_PATHS) {
    const served = expectedServicePaths.has(path);
    assert.equal(fixture.mountCount(path), served ? 2 : 1,
      served ? `one gate and one service route for ${path}` : `gate only for ${path}`);
    // Once open, the gate yields: served paths answer; app-action paths fall
    // through to the fake's 404 instead of the 503 gate.
    assert.equal((await fixture.request(path)).status, served ? 200 : 404);
  }
  assert.equal(runtime.calls.filter(([name]) => name === "createNativeRegistry").length, 1);
  const catalog = runtime.calls.find(([name]) => name === "createProjectCatalog")[1];
  const readiness = runtime.calls.find(([name]) => name === "createProjectRuntimeReadiness")[1];
  const activity = runtime.calls.find(([name]) => name === "createProjectRuntimeActivity")[1];
  assert.equal(catalog.readScope, runtime.readScope);
  assert.equal(catalog.readScope, readiness.readScope);
  assert.equal(catalog.readScope, activity.readScope);
  assert.equal(catalog.provider, runtime.provider);
  assert.equal(Object.hasOwn(readiness, "runtime"), false);
  assert.equal(Object.hasOwn(activity, "runtime"), false);
});

test("missing or failed configuration leaves only the narrow gate and a bounded diagnostic", async () => {
  for (const scenario of ["missing", "failure"]) {
    const fixture = fakeNitro();
    const runtime = fakeRuntime({ getH3App: fixture.getH3App, failAt: "catalog" });
    const dependencies = pluginDependencies(fixture, runtime, {
      loadInstallation: async () => scenario === "missing" ? null : validInstallation(),
      loadRuntime: async () => {
        if (scenario === "missing") throw new Error("must not load runtime");
        return runtime;
      },
    });
    const controller = startProjectServices(fixture.nitro, dependencies);
    const result = await controller.ready;
    assert.equal(result.status, scenario === "missing" ? "unconfigured" : "failed");
    assert.equal((await fixture.request(PROJECT_ACTION_PATHS[0])).status, 503);
    assert.equal((await fixture.request("/")).status, 200);
    assert.ok(PROJECT_ACTION_PATHS.every(path => fixture.mountCount(path) === 1));
    if (scenario === "missing") {
      assert.equal(runtime.calls.length, 0);
    } else {
      assert.deepEqual(runtime.calls.filter(([name]) => name === "diagnostic"), [
        ["diagnostic", "initialization-failed"],
      ]);
      assert.equal(runtime.calls.filter(([name]) => name === "provider.close").length, 1);
    }
  }
});

test("shutdown during startup prevents mounts and closes the eventual provider exactly once", async () => {
  const fixture = fakeNitro();
  const providerWait = deferred();
  const providerStarted = deferred();
  const runtime = fakeRuntime({ getH3App: fixture.getH3App, providerWait, providerStarted });
  const controller = startProjectServices(fixture.nitro, pluginDependencies(fixture, runtime));
  await providerStarted.promise;
  const closing = fixture.close();
  providerWait.resolve();
  await closing;
  await controller.ready;
  assert.deepEqual(controller.snapshot(), { status: "closed", failure: null });
  assert.ok(PROJECT_ACTION_PATHS.every(path => fixture.mountCount(path) === 1));
  assert.equal(runtime.calls.filter(([name]) => name === "provider.close").length, 1);
  await controller.close();
  assert.equal(runtime.calls.filter(([name]) => name === "provider.close").length, 1);
});

test("shutdown closes the gate immediately and waits for an active project request", async () => {
  const fixture = fakeNitro();
  const actionWait = deferred();
  const actionStarted = deferred();
  const runtime = fakeRuntime({ getH3App: fixture.getH3App, actionWait, actionStarted });
  const controller = startProjectServices(fixture.nitro, pluginDependencies(fixture, runtime));
  assert.deepEqual(await controller.ready, { status: "open", failure: null });

  const active = fixture.request(PROJECT_ACTION_PATHS[1]);
  await actionStarted.promise;
  const closing = fixture.close();
  await Promise.resolve();
  assert.equal(runtime.calls.filter(([name]) => name === "provider.close").length, 0);
  assert.equal((await fixture.request(PROJECT_ACTION_PATHS[2])).status, 503);
  actionWait.resolve();
  assert.equal((await active).status, 200);
  await closing;
  assert.equal(runtime.calls.filter(([name]) => name === "provider.close").length, 1);
});


test("shutdown closes the owned provider when an active request cannot drain", { timeout: 2000 }, async () => {
  const fixture = fakeNitro();
  const actionWait = deferred();
  const actionStarted = deferred();
  const runtime = fakeRuntime({ getH3App: fixture.getH3App, actionWait, actionStarted });
  const controller = startProjectServices(fixture.nitro, pluginDependencies(fixture, runtime, {
    requestDrainMs: 10,
  }));
  await controller.ready;
  const active = fixture.request(PROJECT_ACTION_PATHS[1]);
  await actionStarted.promise;
  try {
    await controller.close();
    assert.equal(controller.snapshot().status, "closed");
    assert.equal(runtime.calls.filter(([name]) => name === "provider.close").length, 1);
    assert.equal((await fixture.request(PROJECT_ACTION_PATHS[0])).status, 503);
  } finally {
    actionWait.resolve();
    await active;
  }
});

test("process termination uses the same owned cleanup and removes its signal listeners", async () => {
  const fixture = fakeNitro();
  const runtime = fakeRuntime({ getH3App: fixture.getH3App });
  const dependencies = pluginDependencies(fixture, runtime);
  const plugin = createProjectServicesPlugin(dependencies);
  await plugin(fixture.nitro);
  await plugin(fixture.nitro);
  assert.equal(fixture.signals.listenerCount("SIGTERM"), 1);
  fixture.signals.emit("SIGTERM");
  assert.equal((await fixture.request(PROJECT_ACTION_PATHS[1])).status, 503);
  await startProjectServices(fixture.nitro, dependencies).close();
  assert.equal(runtime.calls.filter(([name]) => name === "provider.close").length, 1);
  assert.equal(fixture.signals.listenerCount("SIGTERM"), 0);
  assert.equal(fixture.signals.listenerCount("SIGINT"), 0);
});


test("default local startup installs the Node provider without Python configuration", async () => {
  const fixture = fakeNitro();
  const runtime = fakeRuntime({ getH3App: fixture.getH3App });
  runtime.createLocalRootProvider = async options => {
    runtime.calls.push(["createLocalRootProvider", options]);
    return Object.assign(runtime.provider, { verificationKind: "local-stat-revalidated-v1",
      resolveGrant: async () => validInstallation().grant,
      locationLabels: () => ({ alpha: "Alpha", beta: "Beta" }) });
  };
  const controller = startProjectServices(fixture.nitro, pluginDependencies(fixture, runtime, {
    loadInstallation: async () => null,
    environment: { VIVARY_ACCESS_MODE: "local", VIVARY_LOCAL_AGENT_WORKSPACE: "/srv/projects/alpha" },
  }));
  assert.deepEqual(await controller.ready, { status: "open", failure: null });
  assert.equal(runtime.calls.some(([name]) => name === "startRootProvider"), false);
  const setup = runtime.calls.find(([name]) => name === "createLocalRootProvider")[1];
  assert.deepEqual(setup, { ownerEmail: "owner@local.vivary.test", defaultFolder: "/srv/projects/alpha" });
  await controller.close();
});
