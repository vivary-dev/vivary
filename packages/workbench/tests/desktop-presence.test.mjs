import assert from "node:assert/strict";
import test from "node:test";
import { getRequestContext } from "@agent-native/core/server";
import {
  buildDesktopPresenceSnapshot,
  createDesktopPresencePublisher,
} from "../server/desktop-presence.ts";

const OWNER = "owner@local.vivary.test";
const SCOPE = "a".repeat(64);

const selectionOf = (projectId) => ({ scopeKey: SCOPE, projectId });
const hostOf = (activeProjectId = null) => ({
  activeRun: activeProjectId === null ? null : { projectId: activeProjectId },
  pendingApproval: null,
});

test("the poller reads the owner selection inside a request context", async () => {
  let observed = null;
  const snapshot = await buildDesktopPresenceSnapshot(OWNER, {
    readSelection: async () => {
      observed = getRequestContext()?.userEmail ?? null;
      return selectionOf("project_launch");
    },
    readScopeKey: async () => SCOPE,
    readHost: async () => hostOf("project_launch"),
    readLabel: async () => "Launch checklist",
  });
  assert.equal(observed, OWNER);
  assert.equal(snapshot.phase, "agent");
  assert.equal(snapshot.projectLabel, "Launch checklist");
});

test("a selection saved for another scope hides presence", async () => {
  let labelsRead = 0;
  const snapshot = await buildDesktopPresenceSnapshot(OWNER, {
    readSelection: async () => ({ scopeKey: "b".repeat(64), projectId: "project_launch" }),
    readScopeKey: async () => SCOPE,
    readHost: async () => hostOf("project_launch"),
    readLabel: async () => {
      labelsRead += 1;
      return "Launch checklist";
    },
  });
  assert.equal(snapshot.phase, "hidden");
  assert.equal(snapshot.projectLabel, null);
  assert.equal(labelsRead, 0);
});

test("the personal workspace clears presence without reading a scope", async () => {
  let scopeReads = 0;
  const snapshot = await buildDesktopPresenceSnapshot(OWNER, {
    readSelection: async () => selectionOf(null),
    readScopeKey: async () => {
      scopeReads += 1;
      return SCOPE;
    },
    readHost: async () => hostOf("project_launch"),
    readLabel: async () => {
      throw new Error("a personal workspace has no project label");
    },
  });
  assert.equal(snapshot.phase, "hidden");
  assert.equal(snapshot.projectLabel, null);
  assert.equal(scopeReads, 0);
});

test("a run in another project leaves the selected project idle", async () => {
  const snapshot = await buildDesktopPresenceSnapshot(OWNER, {
    readSelection: async () => selectionOf("project_launch"),
    readScopeKey: async () => SCOPE,
    readHost: async () => hostOf("project_other"),
    readLabel: async () => "Launch checklist",
  });
  assert.equal(snapshot.phase, "idle");
  assert.equal(snapshot.projectLabel, "Launch checklist");
});

test("the publisher publishes changed snapshots once and hides presence when a snapshot fails", async () => {
  const published = [];
  let failing = false;
  const publisher = createDesktopPresencePublisher({
    readEnabled: async () => true,
    buildSnapshot: async () => {
      if (failing) throw new Error("project services are unavailable");
      return { phase: "idle", projectLabel: "Launch checklist", startedAt: 1 };
    },
    notify: (snapshot) => published.push(snapshot),
    pollMs: 1_000,
  });
  await publisher.tick();
  await publisher.tick();
  assert.equal(published.length, 1);
  failing = true;
  assert.equal((await publisher.tick())?.phase, "hidden", "a failed snapshot build hides presence");
  assert.deepEqual(published.map((snapshot) => [snapshot.phase, snapshot.projectLabel]),
    [["idle", "Launch checklist"], ["hidden", null]]);
  assert.equal(await publisher.tick(), null, "a second failure sends nothing new");
  failing = false;
  assert.equal((await publisher.tick())?.phase, "idle", "presence returns once a snapshot builds again");
  assert.equal(published.length, 3);
});

// PR #323 regression review. With sharing Off a tick must not touch the selection, org, scope or code host.
test("with sharing Off the publisher reads the setting and no other reader", async () => {
  const calls = [];
  const reader = (name, value) => async () => {
    calls.push(name);
    return value;
  };
  const published = [];
  const publisher = createDesktopPresencePublisher({
    readEnabled: reader("settings", false),
    buildSnapshot: () => buildDesktopPresenceSnapshot(OWNER, {
      readSelection: reader("selection", selectionOf("project_launch")),
      readScopeKey: reader("scope", SCOPE),
      readHost: reader("host", hostOf("project_launch")),
      readLabel: reader("label", "Launch checklist"),
    }),
    notify: (snapshot) => published.push(snapshot),
  });
  await publisher.tick();
  await publisher.tick();
  assert.deepEqual(calls, ["settings", "settings"]);
  assert.deepEqual(published.map((snapshot) => snapshot.phase), ["hidden"]);
});
