import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

// PR #323 review B1, end to end. desktop-presence.test.mjs replaces each reader. Here the installed timer reads real
// Core app state, the owner's org and the registry scope with no request and no AGENT_USER_EMAIL, as the desktop
// launcher leaves it. On c5ea21e every timer read threw, nothing was sent, and Discord kept the last project shown.
const WORKBENCH = fileURLToPath(new URL("..", import.meta.url));
const MESSAGE_WAIT_MS = 10_000;

type Snapshot = { phase: string; projectLabel: string | null; startedAt: number };
type Message = { type: string; snapshot?: Snapshot; projects?: { a: string; b: string; emoji: string } };

const fixture = await mkdtemp(path.join(tmpdir(), "vivary-desktop-presence-"));
const database = `file:${path.join(fixture, "native.sqlite")}`;
const env = { ...process.env, APP_NAME: "Vivary", VIVARY_ACCESS_MODE: "local", VIVARY_DESKTOP_HOST: "1",
  DATABASE_URL: database, DATABASE_URL_UNPOOLED: database, VIVARY_DATABASE_URL: database,
  VIVARY_DATABASE_URL_UNPOOLED: database, AGENT_NATIVE_CODE_AGENTS_HOME: path.join(fixture, "code-runs"),
  VIVARY_DATA_DIR: path.join(fixture, "data") };
delete env.AGENT_USER_EMAIL;
const child = fork(path.join(WORKBENCH, "tests", "fixtures", "desktop-presence-host.mjs"), [fixture], {
  cwd: WORKBENCH,
  env,
  execArgv: ["--import", "tsx", "--experimental-test-module-mocks", "--no-warnings"],
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});
const messages: Message[] = [];
child.on("message", message => { messages.push(message as Message); });
let projects = { a: "", b: "", emoji: "" };

async function next(type: string): Promise<Message> {
  const signal = AbortSignal.timeout(MESSAGE_WAIT_MS);
  for (;;) {
    const index = messages.findIndex(message => message?.type === type);
    if (index >= 0) return messages.splice(index, 1)[0];
    try {
      await once(child, "message", { signal });
    } catch {
      assert.fail(`the desktop server sent no ${type} message within ${MESSAGE_WAIT_MS} ms`);
    }
  }
}

async function step(message: Record<string, unknown>) {
  child.send(message);
  await next("test:done");
}

async function presenceAfterTick() {
  await step({ type: "test:tick" });
  const { snapshot } = await next("vivary:desktop:presence");
  assert.ok(snapshot);
  return { phase: snapshot.phase, projectLabel: snapshot.projectLabel };
}

before(async () => {
  const ready = await next("test:ready");
  assert.ok(ready.projects);
  projects = ready.projects;
});

after(async () => {
  const exited = once(child, "exit");
  child.kill();
  await exited;
  await rm(fixture, { recursive: true, force: true });
});

test("the startup read shows the owner's selected project", async () => {
  const { snapshot } = await next("vivary:desktop:presence");
  assert.deepEqual({ phase: snapshot?.phase, projectLabel: snapshot?.projectLabel }, { phase: "idle", projectLabel: "Project A" });
});

test("a timer tick after a switch to the personal workspace hides presence", async () => {
  await step({ type: "test:select", projectId: null });
  assert.deepEqual(await presenceAfterTick(), { phase: "hidden", projectLabel: null });
});

test("a timer tick after a switch from project A to project B shows project B", async () => {
  await step({ type: "test:select", projectId: projects.a });
  assert.deepEqual(await presenceAfterTick(), { phase: "idle", projectLabel: "Project A" });
  await step({ type: "test:select", projectId: projects.b });
  assert.deepEqual(await presenceAfterTick(), { phase: "idle", projectLabel: "Project B" });
});

test("a timer tick follows the code host from idle to agent to review and back", async () => {
  const run = { id: "run-b", title: "Probe run", projectId: projects.b };
  await step({ type: "test:host", host: { activeRuns: [{ ...run, pendingApprovals: [] }] } });
  assert.deepEqual(await presenceAfterTick(), { phase: "agent", projectLabel: "Project B" });
  await step({ type: "test:host", host: { activeRuns: [{ ...run, pendingApprovals: [{ runId: run.id, projectId: projects.b }] }] } });
  assert.deepEqual(await presenceAfterTick(), { phase: "review", projectLabel: "Project B" });
  await step({ type: "test:host", host: { activeRuns: [] } });
  assert.deepEqual(await presenceAfterTick(), { phase: "idle", projectLabel: "Project B" });
});

// PR #323 review r4450011913 feared that a long emoji label fails the snapshot schema. Zod 4 counts a string's
// maximum in code points, as the label cut does, so the label is cut and still sent.
test("a long emoji project name is cut to a well-formed label and still sent", async () => {
  await step({ type: "test:select", projectId: projects.emoji });
  const { phase, projectLabel } = await presenceAfterTick();
  assert.equal(phase, "idle");
  assert.equal(projectLabel, `${"🚀".repeat(127)}…`, "127 whole emoji and the ellipsis make 128 code points");
  assert.equal(projectLabel?.isWellFormed(), true, "no surrogate pair is split");
});

test("a timer tick after sharing is turned off hides presence", async () => {
  await step({ type: "test:share", enabled: false });
  assert.deepEqual(await presenceAfterTick(), { phase: "hidden", projectLabel: null });
});
