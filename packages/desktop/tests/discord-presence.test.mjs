import assert from "node:assert/strict";
import { test } from "node:test";

import { buildDiscordActivity, presenceStateLine, sanitizePresenceText } from "../discord-presence.mjs";

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
