import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

// Issue #115. Settings > Agent > Automations is Core's page, so these cases load the installed, patched Core files
// by path. The list actions run against a disposable SQLite database, and the Details dialog is bundled and rendered.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKBENCH = path.resolve(HERE, "..");
const CORE = path.dirname(realpathSync(path.join(WORKBENCH, "node_modules", "@agent-native", "core", "package.json")));
const CLIENT = path.join(CORE, "dist", "client");

const caseRoot = await mkdtemp(path.join(os.tmpdir(), "vivary-automation-status-"));
const database = `file:${path.join(caseRoot, "automations.sqlite")}`;
for (const name of ["DEPLOY_PRIME_URL", "DEPLOY_URL", "URL", "APP_URL", "BETTER_AUTH_URL", "A2A_SECRET",
  "AGENT_BACKGROUND_RUN_HARD_TIMEOUT_MS"]) {
  delete process.env[name]; // guard:allow-env-credential - Removes fixed app URL, signing, and timeout names. No value is read.
}
Object.assign(process.env, {
  APP_NAME: "Vivary",
  NODE_ENV: "production",
  DATABASE_URL: database,
  DATABASE_URL_UNPOOLED: database,
});

const load = relative => import(pathToFileURL(path.join(CORE, "dist", relative)).href);
const [{ defineAutomation, updateAutomation },
  { acquireAutomationRunLease, recordAutomationSchedulerHealth, releaseAutomationRunLease },
  { resourceGetByPath, resourcePut }, { buildJobResourceContent, patchJobFrontmatterFields },
  { INTERRUPTED_RUN_MESSAGE }, listAutomations, listRecurringJobs, { getDbExec }, { listedNextRun },
  { nextOccurrence }] = await Promise.all([
  load("automations/service.js"),
  load("jobs/scheduler-health.js"),
  load("resources/store.js"),
  load("jobs/frontmatter.js"),
  load("jobs/run-history.js"),
  load("triggers/actions/list-automations.js"),
  load("jobs/actions/list-recurring-jobs.js"),
  load("db/client.js"),
  load("jobs/next-run.js"),
  load("jobs/cron.js"),
]);

const owner = "owner@example.test";
const appId = "status-app";
const actor = { userEmail: owner, appId };
const ctx = { userEmail: owner, appId };
// Heartbeat times are whole milliseconds, as the scheduler writes them.
const checkedAt = Date.now() - 42_000;
const iso = ms => new Date(ms).toISOString();

async function patchStored(name, fields) {
  const resource = await resourceGetByPath(owner, `jobs/${name}.md`);
  await resourcePut(owner, resource.path, patchJobFrontmatterFields(resource.content, fields));
}

await defineAutomation(actor, { scope: "personal", name: "hourly", body: "Summarize the project.",
  triggerType: "schedule", schedule: "0 * * * *", timezone: "UTC" });
// A skip the scheduler recorded after its last heartbeat is newer, so it is the last check.
await defineAutomation(actor, { scope: "personal", name: "skipped-later", body: "Summarize the project.",
  triggerType: "schedule", schedule: "0 * * * *", timezone: "UTC" });
await patchStored("skipped-later", { lastCheck: iso(checkedAt + 60_000) });
// The scheduler never checks an event automation. Its last check is the dispatcher's own skip time.
await defineAutomation(actor, { scope: "personal", name: "on-event", body: "Summarize the event.",
  triggerType: "event", event: "test.event.fired" });
await patchStored("on-event", { lastCheck: iso(checkedAt - 60_000) });
await defineAutomation(actor, { scope: "personal", name: "paused", body: "Summarize the project.",
  triggerType: "schedule", schedule: "0 * * * *", timezone: "UTC" });
await updateAutomation(actor, { scope: "personal", name: "paused", enabled: false });
// Pause keeps the stored next run, which then falls into the past.
await patchStored("paused", { nextRun: iso(Date.now() - 3 * 60 * 60_000) });

// Legacy recurring jobs have no trigger type. Settings lists them through list-recurring-jobs.
await resourcePut(owner, "jobs/legacy.md", buildJobResourceContent(
  { schedule: "*/5 * * * *", enabled: true, appId }, "Check the build."));
await resourcePut(owner, "jobs/legacy-paused.md", buildJobResourceContent(
  { schedule: "*/5 * * * *", enabled: false, appId }, "Check the build."));
// Paused before the heartbeat and resumed after it, in the case on created times.
await defineAutomation(actor, { scope: "personal", name: "resumed", body: "Summarize the project.",
  triggerType: "schedule", schedule: "0 * * * *", timezone: "UTC" });
await updateAutomation(actor, { scope: "personal", name: "resumed", enabled: false });
// Every definition above predates the heartbeats, as one the scheduler has checked does.
await getDbExec().execute({ sql: "UPDATE resources SET created_at = ? WHERE owner = ?",
  args: [checkedAt - 60 * 60_000, owner] });

// The first case lists on a fresh database, before any heartbeat. The others record the heartbeats first.
let recorded;
const heartbeats = () => {
  recorded ??= (async () => {
    await recordAutomationSchedulerHealth({ appId, checkedAt, runtime: "recurring-jobs" });
    // Another app's scheduler on the same database is not this app's last check.
    await recordAutomationSchedulerHealth({ appId: "other-app", checkedAt: checkedAt + 120_000, runtime: "recurring-jobs" });
  })();
  return recorded;
};

after(async () => {
  await esbuild.stop();
  await rm(caseRoot, { recursive: true, force: true });
});

const byName = rows => Object.fromEntries(rows.map(row => [row.name, row]));
const listBoth = async () => ({
  automations: byName(await listAutomations.default.run({ scope: "personal" }, ctx)),
  jobs: byName(await listRecurringJobs.default.run({ scope: "personal" }, ctx)),
});

test("on a fresh database, a list before any heartbeat keeps each stored value", async () => {
  const { automations, jobs } = await listBoth();
  assert.equal(automations.hourly.lastCheck, null, "no check is recorded yet");
  assert.equal(automations["skipped-later"].lastCheck, iso(checkedAt + 60_000), "a recorded skip is kept");
  assert.equal(jobs.legacy.lastCheck, null);
});

test("LAST CHECKED shows the scheduler's last check for an enabled scheduled automation", async () => {
  await heartbeats();
  const rows = byName(await listAutomations.default.run({ scope: "personal" }, ctx));
  assert.equal(rows.hourly.lastCheck, iso(checkedAt), "the heartbeat of this app's scheduler");
  assert.equal(rows["skipped-later"].lastCheck, iso(checkedAt + 60_000), "a later recorded skip wins");
  assert.equal(rows["on-event"].lastCheck, iso(checkedAt - 60_000), "an event automation keeps its own check");
  assert.equal(rows.paused.lastCheck, null, "the scheduler does not check a paused automation");
});

test("LAST CHECKED shows the scheduler's last check for an enabled legacy recurring job", async () => {
  await heartbeats();
  const rows = byName(await listRecurringJobs.default.run({ scope: "personal" }, ctx));
  assert.equal(rows.legacy.lastCheck, iso(checkedAt));
  assert.equal(rows["legacy-paused"].lastCheck, null);
});

test("a failed scheduler health read is logged, and each list falls back to the stored value", async () => {
  await heartbeats();
  const markedAt = Date.now() - 60_000;
  await defineAutomation(actor, { scope: "personal", name: "running-during-failure", body: "Summarize the project.",
    triggerType: "schedule", schedule: "* * * * *", timezone: "UTC" });
  await patchStored("running-during-failure", { lastStatus: "running", lastRun: iso(markedAt) });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
  // The health table was created by the heartbeats, so moving it away makes the read itself fail.
  await getDbExec().execute({ sql: "ALTER TABLE automation_scheduler_health RENAME TO automation_scheduler_health_moved", args: [] });
  let lists;
  try {
    lists = await listBoth();
  } finally {
    await getDbExec().execute({ sql: "ALTER TABLE automation_scheduler_health_moved RENAME TO automation_scheduler_health", args: [] });
    console.warn = originalWarn;
  }
  assert.equal(lists.automations.hourly.lastCheck, null, "the stored value, not an error");
  assert.equal(lists.automations["skipped-later"].lastCheck, iso(checkedAt + 60_000));
  assert.equal(lists.jobs.legacy.lastCheck, null);
  assert.equal(warnings.filter(line => /scheduler's last check/.test(line)).length, 2, "each list logged the failure");
  assert.equal(warnings.filter(line => /scheduler leases/.test(line)).length, 2, "each list logged the failed lease read");
  assert.deepEqual([Date.parse(lists.automations.hourly.nextRun) > Date.now(), lists.automations.hourly.schedulerWait],
    [true, null], "a row with no running mark lists its next run as before #140");
  const running = lists.automations["running-during-failure"];
  assert.deepEqual([running.nextRun, running.schedulerWait],
    [null, { reason: "stalled-run", resumesAfter: iso(markedAt + 10 * 60_000) }],
    "a running mark still waits on its run's time window, as if no lease were held");
});

test("LAST CHECKED ignores a heartbeat whose check failed", async () => {
  await heartbeats();
  await recordAutomationSchedulerHealth({ appId, checkedAt: checkedAt + 30_000, runtime: "recurring-jobs",
    error: "The scheduler could not reach the database." });
  let lists;
  try {
    lists = await listBoth();
  } finally {
    await recordAutomationSchedulerHealth({ appId, checkedAt, runtime: "recurring-jobs" });
  }
  assert.equal(lists.automations.hourly.lastCheck, null, "a failed check is not a check");
  assert.equal(lists.jobs.legacy.lastCheck, null);
  assert.equal((await listBoth()).automations.hourly.lastCheck, iso(checkedAt), "the next good check counts again");
});

test("LAST CHECKED ignores a heartbeat from before the entry was created", async () => {
  await heartbeats();
  await defineAutomation(actor, { scope: "personal", name: "created-later", body: "Summarize the project.",
    triggerType: "schedule", schedule: "0 * * * *", timezone: "UTC" });
  await resourcePut(owner, "jobs/legacy-later.md", buildJobResourceContent(
    { schedule: "*/5 * * * *", enabled: true, appId }, "Check the build."));
  await updateAutomation(actor, { scope: "personal", name: "resumed", enabled: true });
  const { automations, jobs } = await listBoth();
  assert.equal(automations["created-later"].lastCheck, null, "a check from before the automation existed did not check it");
  assert.equal(jobs["legacy-later"].lastCheck, null, "a check from before the job existed did not check it");
  assert.equal(automations.hourly.lastCheck, iso(checkedAt), "an older automation still shows the check");
  // Resuming keeps the created time, so a resumed automation shows the last check, which read it while it was paused.
  assert.equal(automations.resumed.lastCheck, iso(checkedAt));
});

test("a paused automation lists no next run, although its stored next run is in the past", async () => {
  const stored = await resourceGetByPath(owner, "jobs/paused.md");
  assert.match(stored.content, /nextRun: /, "the stale value is still stored");
  const rows = byName(await listAutomations.default.run({ scope: "personal" }, ctx));
  assert.equal(rows.paused.enabled, false);
  assert.equal(rows.paused.nextRun, null);
  assert.ok(Date.parse(rows.hourly.nextRun) > Date.now(), "an enabled automation lists a future run");
});

// Issue #140. While a lease or a running mark keeps the scheduler from acting on an entry, the list names a next run
// only when the scheduler can meet it, at a fixed time so every schedule is deterministic.
const waitNow = Date.UTC(2026, 9, 3, 14, 38, 13);
const minute = 60_000;
const at = (hour, minutes, seconds = 0) => iso(Date.UTC(2026, 9, 3, hour, minutes, seconds));
const waitingKey = `${owner}:jobs/waiting.md`;
const heldLease = (writtenAgo, expiresIn) => ({ writtenAt: waitNow - writtenAgo, expiresAt: waitNow + expiresIn });
const scheduleView = ({ run, scheduler = null, hardTimeoutMs = 10 * minute } = {}) => ({ now: waitNow, hardTimeoutMs,
  scheduler, runs: new Map(run ? [[waitingKey, run]] : []) });
const everyMinute = { enabled: true, schedule: "* * * * *", timezone: "UTC", nextRun: iso(waitNow - minute) };
const runningMark = { ...everyMinute, lastStatus: "running", lastRun: iso(waitNow - minute) };
const shown = nextRun => ({ nextRun, schedulerWait: null });
const waits = (reason, resumesAfter = null) => ({ nextRun: null, schedulerWait: { reason, resumesAfter } });

test("the list names a next run only when the scheduler can meet it", () => {
  const unscheduled = { enabled: true, timezone: "UTC", nextRun: everyMinute.nextRun };
  for (const [what, meta, view, expected, scheduled = true] of [
    ["an entry nothing blocks", everyMinute, {}, shown(at(14, 39))],
    ["a paused entry", { ...everyMinute, enabled: false }, {}, shown(null)],
    ["a live run", runningMark, { run: heldLease(30_000, 9.5 * minute) }, waits("run")],
    ["an hourly entry under a live run", { ...runningMark, schedule: "0 * * * *" },
      { run: heldLease(30_000, 9.5 * minute) }, shown(at(15, 0))],
    ["a run lease not written for 3 minutes", runningMark, { run: heldLease(3 * minute, 9.5 * minute) },
      waits("stalled-run", at(14, 47, 43))],
    ["a stale run lease that expires inside the run's time limit", runningMark,
      { run: heldLease(4 * minute, 6 * minute) }, waits("stalled-run", at(14, 47, 13))],
    ["a running mark no lease covers", runningMark, {}, waits("stalled-run", at(14, 47, 13))],
    ["a running mark under a longer run time limit", runningMark, { hardTimeoutMs: 30 * minute },
      waits("stalled-run", at(15, 7, 13))],
    ["a running mark with no start time", { ...everyMinute, lastStatus: "running" }, {},
      waits("stalled-run", iso(waitNow))],
    ["a paired host's mark, a year out", { ...runningMark, schedule: "0 0 1 1 *", executionHostId: "host-1" }, {},
      waits("run")],
    ["a due time 30 s after a stale lease's expiry", everyMinute, { run: heldLease(10 * minute - 17_000, 17_000) },
      waits("stalled-run", at(14, 38, 30))],
    ["a five-minute due time 70 s after a stale lease's expiry", { ...everyMinute, schedule: "*/5 * * * *" },
      { run: heldLease(10 * minute - 37_000, 37_000) }, waits("stalled-run", at(14, 38, 50))],
    ["a stored next run an edit wrote during the wait", { ...runningMark, nextRun: at(14, 41) },
      { run: heldLease(3 * minute, 9.5 * minute) }, waits("stalled-run", at(14, 47, 43))],
    ["a lease written exactly 90 s ago", everyMinute, { run: heldLease(90_000, 8.5 * minute) }, waits("run")],
    ["a lease written just over 90 s ago", everyMinute, { run: heldLease(90_001, 8.5 * minute) },
      waits("stalled-run", at(14, 46, 43))],
    ["a live scan's scheduler lease", everyMinute, { scheduler: heldLease(30_000, 9.5 * minute) }, shown(at(14, 39))],
    ["a dead scanner's lease", everyMinute, { scheduler: heldLease(2 * minute, 8 * minute) },
      waits("scheduler", at(14, 46, 13))],
    ["an hourly entry under a dead scanner's lease", { ...everyMinute, schedule: "0 * * * *" },
      { scheduler: heldLease(2 * minute, 8 * minute) }, shown(at(15, 0))],
    ["a running mark under a dead scanner's lease that clears later", runningMark,
      { scheduler: heldLease(105_000, 9.5 * minute) }, waits("scheduler", at(14, 47, 43))],
    ["an event entry under a dead scanner's lease", unscheduled, { scheduler: heldLease(2 * minute, 8 * minute) },
      shown(at(14, 37, 13)), false],
  ]) {
    assert.deepEqual(listedNextRun(meta, scheduled, waitingKey, scheduleView(view)), expected, what);
  }
});

// The tick that resets a killed run's mark lands up to 70 s after the wait ends for a launch during the wait, and
// 70 s after a launch that comes later, so the list cannot know which tick it gets. The steps do not divide a minute,
// so the wait ends and the phases fall at every offset from a minute boundary.
test("a next run listed during a run's wait is the one the reset tick stores, at every tick phase", () => {
  const occurrence = Date.UTC(2026, 9, 4, 9, 0, 0);
  let checked = 0;
  for (const schedule of ["* * * * *", "*/5 * * * *", "0 * * * *", "0 9 * * *"]) {
    for (let offset = -84_000; offset <= 84_000; offset += 7_000) {
      const killedAt = occurrence - 10 * minute + offset;
      const lastRun = killedAt - 20_000;
      const writtenAt = killedAt - 10_000;
      const expiresAt = writtenAt + 10 * minute;
      const meta = { enabled: true, schedule, timezone: "UTC", nextRun: iso(lastRun - 1_000), lastStatus: "running",
        lastRun: iso(lastRun) };
      for (const leased of [true, false]) {
        const waitEnd = Math.max(leased ? expiresAt : -Infinity, lastRun + 10 * minute);
        const listings = [];
        for (let phase = 0; phase < 70_000; phase += 4_600) {
          for (let now = killedAt; now < waitEnd + phase; now += 37_000) listings.push([now, waitEnd + phase]);
        }
        for (let launch = waitEnd; launch < waitEnd + 3 * minute; launch += 13_000) {
          listings.push([launch, launch + 70_000]);
        }
        for (const [now, reset] of listings) {
          const stores = nextOccurrence(schedule, new Date(reset), "UTC").toISOString();
          const runs = leased && now < expiresAt ? new Map([[waitingKey, { writtenAt, expiresAt }]]) : new Map();
          const { nextRun } = listedNextRun(meta, true, waitingKey,
            { now, hardTimeoutMs: 10 * minute, scheduler: null, runs });
          assert.ok(nextRun === null || nextRun === stores, `${schedule}, killed at ${iso(killedAt)}, ${leased
            ? "leased" : "unleased"}, reset at ${iso(reset)}, listed at ${iso(now)}: ${nextRun}, the reset stores ${
            stores}`);
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked > 10_000, `the simulation checked ${checked} listings`);
});

test("the legacy job list shows the wait of a run lease that stopped renewing", async () => {
  const lastRun = Date.now() - 2 * minute;
  await resourcePut(owner, "jobs/legacy-waiting.md", buildJobResourceContent(
    { schedule: "* * * * *", enabled: true, appId, lastStatus: "running", lastRun: iso(lastRun) }, "Check the build."));
  const key = `${owner}:jobs/legacy-waiting.md`;
  const leaseOwner = await acquireAutomationRunLease({ key });
  assert.ok(leaseOwner, "this process holds the job's run lease");
  try {
    await getDbExec().execute({ sql: "UPDATE automation_scheduler_health SET updated_at = ? WHERE id = ?",
      args: [Date.now() - 3 * minute, `run:${key}`] });
    const { rows: [lease] } = await getDbExec().execute({
      sql: "SELECT lease_expires_at FROM automation_scheduler_health WHERE id = ?", args: [`run:${key}`] });
    const job = byName(await listRecurringJobs.default.run({ scope: "personal" }, ctx))["legacy-waiting"];
    assert.deepEqual([job.nextRun, job.schedulerWait], [null, { reason: "stalled-run",
      resumesAfter: iso(Math.max(Number(lease.lease_expires_at), lastRun + 10 * minute)) }]);
  } finally {
    await releaseAutomationRunLease({ key, owner: leaseOwner });
  }
});

test("a running mark no lease covers lists the end of the run time limit the app sets", async () => {
  const lastRun = Date.now() - minute;
  await defineAutomation(actor, { scope: "personal", name: "long-limit", body: "Summarize the project.",
    triggerType: "schedule", schedule: "* * * * *", timezone: "UTC" });
  await patchStored("long-limit", { lastStatus: "running", lastRun: iso(lastRun) });
  process.env.AGENT_BACKGROUND_RUN_HARD_TIMEOUT_MS = String(30 * minute); // guard:allow-env-mutation - A test-only run time limit, removed below.
  let rows;
  try {
    rows = byName(await listAutomations.default.run({ scope: "personal" }, ctx));
  } finally {
    delete process.env.AGENT_BACKGROUND_RUN_HARD_TIMEOUT_MS; // guard:allow-env-mutation - Removes the test-only run time limit set above.
  }
  assert.deepEqual([rows["long-limit"].nextRun, rows["long-limit"].schedulerWait],
    [null, { reason: "stalled-run", resumesAfter: iso(lastRun + 30 * minute) }]);
});

// The history and approval transport hooks, translation hook, chat event helper and dialog frame are stubbed.
// They are matched by the file they resolve to. The dialog frame is Radix, which renders into a portal.
const i18nStub = `
  export function useT() {
    return (key, options) => Object.entries(options ?? {}).reduce(
      (text, [name, value]) => text.split("{{" + name + "}}").join(String(value)), options?.defaultValue ?? key);
  }
  export function useFormatters() { return { formatDate: value => new Date(value).toISOString() }; }`;
const dialogStub = `
  export const Dialog = ({ open, onOpenChange, children }) => (open ? <div role="dialog">
    <button type="button" onClick={() => onOpenChange(false)}>Close</button>{children}</div> : null);
  export const DialogContent = ({ children }) => <div>{children}</div>;
  export const DialogHeader = ({ children }) => <div>{children}</div>;
  export const DialogFooter = ({ children }) => <div>{children}</div>;
  export const DialogTitle = ({ children }) => <h2>{children}</h2>;
  export const DialogDescription = ({ children }) => <p>{children}</p>;`;
const stubs = new Map([
  [path.join(CLIENT, "agent-page", "use-jobs.js"), `
    export function useAutomationRuns() { return { data: globalThis.__automationRuns, isLoading: false, error: null }; }
    export function useAutomationRunInspection(historyId) {
      globalThis.__inspectedId = historyId;
      return { data: globalThis.__runInspection, isLoading: false, isError: globalThis.__inspectionFailed ?? false };
    }
    export function useAutomationApprovalDecision() {
      return { mutate: input => globalThis.__decisions.push(input), isPending: false,
        isError: false, error: null };
    }
    export const firstLoading = () => false;
    export const loadFailed = () => false;`],
  [path.join(CLIENT, "i18n.js"), i18nStub],
  [path.join(CLIENT, "agent-chat.js"), `
    export function requestAgentChatThreadOpen(detail) { globalThis.__openRequests.push(detail); }`],
  [path.join(CLIENT, "components", "ui", "dialog.js"), dialogStub],
]);

const proofSource = String.raw`
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AutomationDetailsDialog } from "@proof/entry";

export async function renderDetails(runs) {
  globalThis.__automationRuns = runs;
  globalThis.__openRequests = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<AutomationDetailsDialog open name="digest" triggerSummary="Every hour"
      fields={[{ label: "Last checked", value: "now" }]} condition={null} instructions="Summarize the project."
      mcpTools={[]} lastError={null} scope="personal" formatTimestamp={ms => new Date(ms).toISOString()}
      onClose={() => {}} />);
  });
  const snapshot = {
    text: host.textContent,
    buttons: [...host.querySelectorAll("button")].map(button => button.textContent),
    rows: host.querySelectorAll("li").length,
  };
  await act(async () => { root.unmount(); });
  host.remove();
  return snapshot;
}

export async function inspectDetails(data, failed = false) {
  globalThis.__automationRuns = [data.run];
  globalThis.__runInspection = data;
  globalThis.__inspectionFailed = failed;
  globalThis.__decisions = [];
  globalThis.__openRequests = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<AutomationDetailsDialog open name="digest" triggerSummary="Every hour"
    fields={[]} condition={null} instructions="Summarize the project." mcpTools={[]} lastError={null}
    scope="personal" formatTimestamp={ms => new Date(ms).toISOString()} onClose={() => {}} />));
  const inspect = [...host.querySelectorAll("button")].find(button => button.textContent === "Inspect run");
  await act(async () => inspect.click());
  const control = label => [...host.querySelectorAll("button")].find(button => button.textContent === label);
  const approve = control("Approve once");
  const decline = control("Decline");
  const snapshot = { text: host.textContent, inspectedId: globalThis.__inspectedId,
    approveDisabled: approve.disabled, declineDisabled: decline.disabled,
    interactiveInputs: host.querySelectorAll("textarea,input,[contenteditable=true]").length };
  await act(async () => { if (!approve.disabled) approve.click(); });
  await act(async () => { if (!decline.disabled) decline.click(); });
  snapshot.decisions = [...globalThis.__decisions];
  snapshot.openRequests = [...globalThis.__openRequests];
  await act(async () => root.unmount());
  host.remove();
  return snapshot;
}
`;

async function buildProof({ source, sourcefile, entry, stubs }) {
  const result = await esbuild.build({
    stdin: { contents: source, resolveDir: HERE, sourcefile, loader: "tsx" },
    absWorkingDir: WORKBENCH,
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    target: "node22",
    jsx: "automatic",
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{
      name: "core-client-proof",
      setup(build) {
        build.onResolve({ filter: /.*/ }, args => {
          if (args.path === "@proof/entry") return { path: entry };
          if (args.path.startsWith(".") && args.importer.startsWith(CORE)) {
            const target = path.resolve(path.dirname(args.importer), args.path);
            if (stubs.has(target)) return { path: target, namespace: "stub" };
          }
          return undefined;
        });
        build.onLoad({ filter: /.*/, namespace: "stub" }, args => (
          { contents: stubs.get(args.path), loader: "tsx", resolveDir: WORKBENCH }));
      },
    }],
  });
  return { code: result.outputFiles[0].text,
    inputs: Object.keys(result.metafile.inputs).map(input => path.resolve(WORKBENCH, input)) };
}

const importProof = code => import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

function installDom(origin = "http://127.0.0.1:3000") {
  const linkedom = createRequire(path.join(CORE, "package.json"))("linkedom");
  const view = linkedom.parseHTML("<!doctype html><html><body></body></html>");
  // React schedules through MessageChannel. Open ports keep Node alive, so the proof closes them.
  const channels = [];
  class TrackedMessageChannel extends MessageChannel {
    constructor() { super(); channels.push(this); }
  }
  const values = { window: view, self: view, document: view.document, navigator: view.navigator,
    HTMLElement: view.HTMLElement, Element: view.Element, Node: view.Node, Event: view.Event,
    CustomEvent: view.CustomEvent, EventTarget: view.EventTarget, MessageChannel: TrackedMessageChannel,
    location: new URL(origin), IS_REACT_ACT_ENVIRONMENT: true };
  const replaced = Object.keys(values).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return () => {
    for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
    for (const [name, descriptor] of replaced) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

test("past runs remain in Settings without an interactive Open thread control", async t => {
  const { code } = await buildProof({ source: proofSource, sourcefile: "automation-details-proof.tsx",
    entry: path.join(CLIENT, "agent-page", "AutomationDetailsDialog.js"), stubs });
  const proof = await importProof(code);
  const restoreDom = installDom();
  t.after(restoreDom);
  const startedAt = Date.now() - 10 * 60_000;
  const run = (id, status, error) => ({ id, status, error, threadId: `thread-${id}`, runId: `run-${id}`,
    startedAt, finishedAt: startedAt + 3_000, errorCode: null, automation: "digest" });
  const details = await proof.renderDetails([
    run("done", "success", null),
    run("cut", "interrupted", INTERRUPTED_RUN_MESSAGE),
    run("failed", "error", "The tool failed. No delivery was confirmed."),
  ]);
  assert.equal(details.rows, 3, "every past run is listed");
  for (const status of ["success", "interrupted", "error"]) assert.match(details.text, new RegExp(status));
  assert.match(details.text, /The run stopped before it recorded a result/, "an interrupted run shows its message");
  assert.deepEqual(details.buttons.filter(label => /open thread/i.test(label)), [], "no run offers Open thread");
});

test("Settings labels listed legacy NULL-app threads as unavailable instead of offering Inspect", async t => {
  const { code } = await buildProof({ source: proofSource, sourcefile: "automation-legacy-inspection-proof.tsx",
    entry: path.join(CLIENT, "agent-page", "AutomationDetailsDialog.js"), stubs });
  const proof = await importProof(code), restoreDom = installDom(); t.after(restoreDom);
  const row = { id: "legacy-threaded", appId: null, threadId: "retained-thread", status: "success",
    startedAt: Date.now() - 1000, finishedAt: Date.now(), error: null };
  const legacy = await proof.renderDetails([row]);
  assert.equal(legacy.rows, 1); assert.match(legacy.text, /Inspection unavailable for this older run/);
  assert.equal(legacy.buttons.includes("Inspect run"), false);
  const current = await proof.renderDetails([{ ...row, appId: "status-test" }]);
  assert.equal(current.buttons.filter(label => label === "Inspect run").length, 1);
  assert.doesNotMatch(current.text, /Inspection unavailable/);
});

test("Settings inspects retained tools and sends only the exact pending approval decision", async t => {
  const { code } = await buildProof({ source: proofSource, sourcefile: "automation-approval-ui-proof.tsx",
    entry: path.join(CLIENT, "agent-page", "AutomationDetailsDialog.js"), stubs });
  const proof = await importProof(code);
  const restoreDom = installDom();
  t.after(restoreDom);
  const data = { run: { id: "history-approval", appId: "status-test", threadId: "thread-approval", status: "waiting_approval",
    startedAt: Date.now(), finishedAt: null, approvalReady: true },
    threadData: JSON.stringify({ messages: [{ message: { role: "assistant", content: [
      { type: "tool-call", toolName: "resources", argsText: '{"path":"notes/prior.md"}', result: "Retained local result" },
      { type: "text", text: "Review the next action." },
    ] } }] }),
    pending: { askId: "exact-ask", toolName: "mcp__fixture__write", input: { value: "Exact pending content" }, expiresAt: Date.now() + 60_000 } };
  const view = await proof.inspectDetails(data);
  assert.equal(view.inspectedId, data.run.id);
  for (const retained of ["Retained local result", "notes/prior.md", "Exact pending content", "waiting approval"])
    assert.ok(view.text.includes(retained), retained);
  assert.equal(view.interactiveInputs, 0);
  assert.deepEqual(view.openRequests, []);
  assert.deepEqual(view.decisions, ["approve", "decline"].map(decision => ({ historyId: data.run.id, askId: "exact-ask", decision })));
  const stale = await proof.inspectDetails(data, true);
  assert.equal(stale.approveDisabled, true);
  assert.equal(stale.declineDisabled, true);
  assert.deepEqual(stale.decisions, []);
  const expired = await proof.inspectDetails({ ...data, pending: { ...data.pending, expiresAt: Date.now() - 1 } });
  assert.equal(expired.approveDisabled, true);
  assert.equal(expired.declineDisabled, false);
  assert.match(expired.text, /approval expired/i);
});

// Issue #141. Details must show what the automation list holds now, and the list must refresh while the tab is open.
// use-action.js is replaced so the real use-jobs.js hooks run on real React Query, answered by a fake transport.
const jobsTabStubs = new Map([
  [path.join(CLIENT, "use-action.js"), `
    import { useMutation, useQuery } from "@tanstack/react-query";
    export function useActionQuery(actionName, params, options) {
      return useQuery({ queryKey: ["action", actionName, params], retry: false,
        queryFn: async () => globalThis.__proofTransport(actionName, params), ...options });
    }
    export function useActionMutation(actionName, options) {
      const { method, skipActionQueryInvalidation, timeoutMs, ...rest } = options ?? {};
      return useMutation({ ...rest, mutationFn: async variables => globalThis.__proofTransport(actionName, variables) });
    }`],
  [path.join(CLIENT, "i18n.js"), i18nStub],
  [path.join(CLIENT, "components", "ui", "dialog.js"), dialogStub],
  [path.join(CLIENT, "components", "ui", "popover.js"), `
    export const Popover = ({ children }) => <div>{children}</div>;
    export const PopoverTrigger = ({ children }) => children;
    export const PopoverContent = ({ children }) => <div>{children}</div>;`],
  [path.join(CLIENT, "AgentAskPopover.js"), `export function AgentAskPopover() { return null; }`],
  [path.join(CLIENT, "settings", "AutomationsSection.js"), `export function automationCreationContext() { return ""; }`],
  [path.join(CLIENT, "agent-page", "AutomationScheduleDialog.js"), `export function AutomationScheduleDialog() { return null; }`],
]);

const jobsTabSource = String.raw`
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, environmentManager, focusManager, onlineManager, timeoutManager }
  from "@tanstack/react-query";
import { AgentJobsTab } from "@proof/entry";

const settle = () => act(async () => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
});

export async function mountJobsTab(rows) {
  const calls = new Map();
  globalThis.__proofTransport = async (action, params) => {
    const key = params.scope ? action + " " + params.scope : action;
    calls.set(key, (calls.get(key) ?? 0) + 1);
    if (rows.failing?.includes(key)) {
      if (rows.hold) await new Promise(resume => { rows.release = resume; });
      if (rows.failing?.includes(key)) throw new Error("The server did not answer.");
    }
    if (action === "manage-automation" || action === "manage-recurring-job") {
      const lists = action === "manage-automation" ? rows : rows.jobs;
      lists[params.scope] = lists[params.scope].map(row => (row.name === params.name
        ? { ...row, enabled: params.enabled } : row));
      return {};
    }
    if (action === "list-automations") return rows[params.scope];
    if (action === "list-recurring-jobs") return rows.jobs?.[params.scope] ?? [];
    if (action === "list-automation-runs") return rows.runs ?? [];
    if (action === "get-scheduled-trigger-status") return rows.triggerStatus ?? { available: true };
    return [];
  };
  // Core's house client turns off refetch on window focus, so a hook that wants it must ask for it.
  const client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const showTab = shown => act(async () => {
    root.render(<QueryClientProvider client={client}>{shown && <AgentJobsTab hideHeader />}</QueryClientProvider>);
  });
  await showTab(true);
  await settle();
  return {
    calls: (action, scope) => calls.get(action + " " + scope) ?? 0,
    text: () => host.textContent,
    controls: label => [...host.querySelectorAll("button")].filter(button => button.textContent.trim() === label).length,
    pastRuns: () => host.querySelector('[role="dialog"]')?.querySelectorAll("li").length ?? 0,
    dialogText: () => host.querySelector('[role="dialog"]')?.textContent ?? "",
    detailsAboveFields() {
      const text = host.querySelector('[role="dialog"]')?.textContent ?? "";
      const fields = host.querySelector('[role="dialog"] dl');
      return fields ? text.slice(0, text.indexOf(fields.textContent)) : text;
    },
    belowPastRuns() {
      const text = host.querySelector('[role="dialog"]')?.textContent ?? "";
      return text.slice(text.lastIndexOf("Past runs"));
    },
    switchState(index) {
      const control = host.querySelectorAll('[role="switch"]')[index];
      return { checked: control.getAttribute("aria-checked"), disabled: control.hasAttribute("disabled") };
    },
    async toggle(index) {
      await act(async () => { host.querySelectorAll('[role="switch"]')[index].click(); });
      await settle();
    },
    async click(label, nth) {
      const button = [...host.querySelectorAll("button")].filter(button => button.textContent.trim() === label).at(nth);
      await act(async () => { button.click(); });
      await settle();
    },
    async release() {
      const release = rows.release;
      delete rows.release;
      await act(async () => { release(); });
      await settle();
    },
    async reopenTab() {
      await showTab(false);
      await showTab(true);
      await settle();
    },
    section(index) {
      const section = host.querySelectorAll("section")[index];
      const text = section.textContent;
      const firstRow = section.querySelector("article");
      return { text, rows: section.querySelectorAll("article").length,
        aboveRows: firstRow ? text.slice(0, text.indexOf(firstRow.textContent)) : text };
    },
    async closeDetails() {
      const close = host.querySelector('[role="dialog"] button');
      await act(async () => { close.click(); });
      await settle();
    },
    async age(action, params) {
      await act(async () => {
        client.setQueryData(["action", action, params], data => data, { updatedAt: Date.now() - 60_000 });
      });
    },
    async focus(focused) {
      await act(async () => { focusManager.setFocused(focused); });
      await settle();
    },
    async online(online) {
      await act(async () => { onlineManager.setOnline(online); });
      await settle();
    },
    async openDetails(label = "Details", nth = 0) {
      const details = [...host.querySelectorAll("button")].filter(button => button.textContent.trim() === label)[nth];
      await act(async () => { details.click(); });
      await settle();
    },
    details() {
      const dialog = host.querySelector('[role="dialog"]');
      return dialog && Object.fromEntries([...dialog.querySelectorAll("dt")]
        .map(term => [term.textContent, term.nextElementSibling?.textContent]));
    },
    async setList(scope, list) {
      await act(async () => { client.setQueryData(["action", "list-automations", { scope }], list); });
      await settle();
    },
    async unmount() {
      await act(async () => { root.unmount(); });
      client.clear();
      host.remove();
    },
  };
}

export function resetFocus() {
  focusManager.setFocused(undefined);
}

export function resetOnline() {
  onlineManager.setOnline(true);
}

export function recordTimers() {
  const wasServer = environmentManager.isServer();
  const intervals = new Set();
  // Timeouts never run, so the five minute cache timer cannot keep node --test alive.
  const recording = {
    setTimeout: () => ({}),
    clearTimeout: () => {},
    setInterval: (callback, ms) => {
      const timer = { callback, ms };
      intervals.add(timer);
      return timer;
    },
    clearInterval: timer => { intervals.delete(timer); },
  };
  // The bundle loads before the DOM, so React Query took this process for a server and starts no timers.
  environmentManager.setIsServer(() => false);
  timeoutManager.setTimeoutProvider(recording);
  return {
    intervals: () => [...intervals].map(timer => timer.ms),
    async fire(maxMs) {
      const due = [...intervals].filter(timer => timer.ms <= maxMs);
      await act(async () => { for (const timer of due) timer.callback(); });
      await settle();
    },
    restore() {
      // Setting the same provider first clears React Query's development warning about switching after use.
      timeoutManager.setTimeoutProvider(recording);
      timeoutManager.setTimeoutProvider({ setTimeout, clearTimeout, setInterval, clearInterval });
      environmentManager.setIsServer(() => wasServer);
    },
  };
}
`;

let jobsTab;
const jobsTabProof = () => {
  jobsTab ??= (async () => {
    const { code, inputs } = await buildProof({ source: jobsTabSource, sourcefile: "automation-jobs-tab-proof.tsx",
      entry: path.join(CLIENT, "agent-page", "AgentJobsTab.js"), stubs: jobsTabStubs });
    for (const file of ["AgentJobsTab.js", "AutomationDetailsDialog.js", "use-jobs.js"]) {
      assert.ok(inputs.includes(path.join(CLIENT, "agent-page", file)), `the proof bundles Core's real ${file}`);
    }
    return importProof(code);
  })();
  return jobsTab;
};

const tick = Date.UTC(2026, 8, 29, 14, 16, 40);
const listed = { id: "res-digest", name: "digest", scope: "personal", enabled: true, canUpdate: true,
  triggerType: "schedule", schedule: "* * * * *", scheduleDescription: "Every minute", timezone: "UTC",
  body: "Summarize the project.", mcpTools: [], lastError: null, createdBy: owner, model: null };
const beforeTick = { ...listed, lastCheck: iso(tick), nextRun: iso(tick + 20_000), lastRun: null, lastStatus: null };
const afterTick = { ...listed, lastCheck: iso(tick + 60_000), nextRun: iso(tick + 80_000),
  lastRun: iso(tick + 20_000), lastStatus: "success" };
const pastRun = { id: "run-1", status: "success", error: null, threadId: "thread-1", runId: "run-1",
  startedAt: tick + 20_000, finishedAt: tick + 23_000, errorCode: null, automation: "digest" };
const legacyJob = { ...afterTick, id: "res-legacy", name: "legacy", instructions: "Check the build." };
const everyList = () => ({ personal: [afterTick],
  organization: [{ ...afterTick, id: "res-shared", name: "shared", scope: "organization" }],
  jobs: { personal: [legacyJob],
    organization: [{ ...legacyJob, id: "res-organization-legacy", name: "organization-legacy", scope: "organization" }] } });

const sectionNote = /Could not refresh automations\. The values shown may be out of date\./;
const detailsNote = /Could not refresh\. These values may be out of date\./;
const runsNote = /Could not refresh run history\./;

function assertDetailsShow(shown, row, where) {
  assert.equal(shown?.["Last checked"], row.lastCheck, `${where} shows the LAST CHECKED the list now holds`);
  assert.equal(shown?.["Next run"], row.nextRun, `${where} shows the NEXT RUN the list now holds`);
  assert.equal(shown?.["Last run"], row.lastRun, `${where} shows the LAST RUN the list now holds`);
  assert.equal(shown?.["Last status"], row.lastStatus, `${where} shows the LAST STATUS the list now holds`);
}

test("an open Details dialog follows the automation list when the list changes", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  t.after(restoreDom);
  const rows = { personal: [beforeTick], organization: [] };
  const tab = await proof.mountJobsTab(rows);
  try {
    await tab.openDetails();
    assert.equal(tab.details()?.["Last checked"], beforeTick.lastCheck, "Details opens on the list's LAST CHECKED");
    rows.personal = [afterTick];
    await tab.setList("personal", [afterTick]);
    assertDetailsShow(tab.details(), afterTick, "an open Details dialog");
  } finally {
    await tab.unmount();
  }
});

test("Details shows when scheduling resumes while the scheduler waits", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  t.after(restoreDom);
  const resumesAfter = iso(Date.now() + 5 * 60_000);
  const waiting = schedulerWait => ({ ...afterTick, nextRun: null, schedulerWait });
  const rows = { personal: [afterTick], organization: [] };
  const tab = await proof.mountJobsTab(rows);
  try {
    await tab.openDetails();
    for (const [row, value, what] of [
      [afterTick, afterTick.nextRun, "a row with no wait field"],
      [waiting({ reason: "run", resumesAfter: null }), "After the current run finishes", "a run in progress"],
      [waiting({ reason: "stalled-run", resumesAfter }),
        `Scheduling resumes after ${resumesAfter}, when an unfinished run times out`, "a run lease that stopped"],
      [waiting({ reason: "scheduler", resumesAfter }),
        `Scheduling resumes after ${resumesAfter}, when an interrupted schedule check times out`, "a dead scanner"],
      [waiting({ reason: "scheduler", resumesAfter: iso(Date.now() - 1_000) }), "Waiting for the next schedule check",
        "a wait whose end has passed"],
    ]) {
      rows.personal = [row];
      await tab.setList("personal", [row]);
      assert.equal(tab.details()?.["Next run"], value, what);
    }
  } finally {
    await tab.unmount();
  }
});

test("Details shows the wait while the scheduler status check fails", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  t.after(restoreDom);
  const resumesAfter = iso(Date.now() + 5 * 60_000);
  const row = { ...afterTick, nextRun: null, schedulerWait: { reason: "stalled-run", resumesAfter } };
  const tab = await proof.mountJobsTab({ personal: [row], organization: [], failing: ["get-scheduled-trigger-status"] });
  try {
    assert.match(tab.text(), /check whether schedules run here/, "the scheduler status check failed");
    await tab.openDetails();
    assert.equal(tab.details()?.["Next run"],
      `Scheduling resumes after ${resumesAfter}, when an unfinished run times out`);
  } finally {
    await tab.unmount();
  }
});

test("Details says no scheduler runs in this deploy, whatever the wait", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  t.after(restoreDom);
  const row = { ...afterTick, nextRun: null, schedulerWait: { reason: "run", resumesAfter: null } };
  const tab = await proof.mountJobsTab({ personal: [row], organization: [],
    triggerStatus: { available: false, reason: "no-platform-scheduler" } });
  try {
    await tab.openDetails();
    assert.match(tab.details()?.["Next run"] ?? "", /^Never\b.*no scheduler in this deploy$/);
  } finally {
    await tab.unmount();
  }
});

test("opening Details fetches the automation list again", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  t.after(restoreDom);
  const rows = { personal: [beforeTick], organization: [] };
  const tab = await proof.mountJobsTab(rows);
  try {
    const fetched = tab.calls("list-automations", "personal");
    rows.personal = [afterTick];
    await tab.openDetails();
    assert.ok(tab.calls("list-automations", "personal") > fetched,
      "opening Details fetches the personal automation list again");
    assertDetailsShow(tab.details(), afterTick, "Details opened after the list changed");
  } finally {
    await tab.unmount();
  }
});

test("the automation list refreshes while the Automations tab stays open", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  const timers = proof.recordTimers();
  t.after(() => {
    timers.restore();
    restoreDom();
  });
  const rows = { personal: [beforeTick], organization: [] };
  const tab = await proof.mountJobsTab(rows);
  try {
    await tab.openDetails();
    const fetched = tab.calls("list-automations", "personal");
    const fetchedJobs = tab.calls("list-recurring-jobs", "personal");
    rows.personal = [afterTick];
    // The scheduler heartbeat moves every 60 seconds, so a 30 second refresh keeps LAST CHECKED within half a tick.
    await timers.fire(30_000);
    assert.ok(tab.calls("list-automations", "personal") > fetched,
      "a timer of 30 seconds or less fetches the personal automation list again while the tab stays open");
    assert.ok(tab.calls("list-recurring-jobs", "personal") > fetchedJobs,
      "a timer of 30 seconds or less fetches the personal recurring job list again too");
    assertDetailsShow(tab.details(), afterTick, "an open Details dialog after a timed refresh");
    assert.deepEqual([...new Set(timers.intervals())], [30_000], "every refresh interval is exactly 30 seconds");
  } finally {
    await tab.unmount();
  }
  assert.deepEqual(timers.intervals(), [], "no refresh interval outlives the tab");
});

test("Details stays on the automation it opened when both scopes hold its name", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  t.after(restoreDom);
  const personalDigest = { ...beforeTick, id: "res-personal-digest" };
  const organizationDigest = { ...beforeTick, id: "res-organization-digest", scope: "organization",
    lastCheck: iso(tick + 120_000) };
  const rows = { personal: [personalDigest], organization: [organizationDigest] };
  const tab = await proof.mountJobsTab(rows);
  try {
    await tab.openDetails("Details", 2);
    const other = { ...beforeTick, id: "res-other", name: "other" };
    const organizationAfter = { ...organizationDigest, lastCheck: iso(tick + 180_000) };
    rows.personal = [other, personalDigest];
    rows.organization = [organizationAfter];
    await tab.setList("personal", rows.personal);
    await tab.setList("organization", rows.organization);
    const shown = tab.details();
    assert.equal(shown?.Scope, "Organization", "Details still shows the organization digest");
    assert.equal(shown?.["Last checked"], organizationAfter.lastCheck,
      "Details shows the organization digest's LAST CHECKED");
    assert.ok(tab.calls("list-automation-runs", "organization") > 0, "Past runs asks for the organization scope");
    assert.equal(tab.calls("list-automation-runs", "personal"), 0, "Past runs never asks for the personal digest");
  } finally {
    await tab.unmount();
  }
});

test("a closed Details dialog stays closed and fetches no past runs", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  const timers = proof.recordTimers();
  t.after(() => {
    timers.restore();
    restoreDom();
  });
  const tab = await proof.mountJobsTab({ personal: [beforeTick], organization: [] });
  try {
    await tab.openDetails();
    assert.ok(tab.details(), "Details opens");
    await tab.closeDetails();
    assert.equal(tab.details(), null, "Close closes Details");
    const fetchedRuns = tab.calls("list-automation-runs", "personal");
    await timers.fire(30_000);
    assert.equal(tab.details(), null, "the timed refresh leaves Details closed");
    assert.equal(tab.calls("list-automation-runs", "personal"), fetchedRuns,
      "the timed refresh fetches no past runs after Close");
  } finally {
    await tab.unmount();
  }
});

test("a failed list refresh keeps the rows and the Details values and notes it until a success", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  const timers = proof.recordTimers();
  t.after(() => {
    timers.restore();
    restoreDom();
  });
  const rows = { personal: [afterTick], organization: [] };
  const tab = await proof.mountJobsTab(rows);
  try {
    await tab.openDetails();
    const later = { ...afterTick, lastCheck: iso(tick + 120_000) };
    rows.personal = [later];
    rows.failing = ["list-automations personal"];
    const fetched = tab.calls("list-automations", "personal");
    await timers.fire(30_000);
    assert.ok(tab.calls("list-automations", "personal") > fetched, "the timed refresh asks for the list again");
    assert.doesNotMatch(tab.text(), /Could not load all automations/, "a failed refresh after an answer is no load error");
    assert.match(tab.text(), sectionNote, "the section notes that its values may be out of date");
    assert.equal(tab.controls("Details"), 2, "the automation's row stays listed");
    assertDetailsShow(tab.details(), afterTick, "an open Details dialog after a failed refresh");
    assert.match(tab.dialogText(), detailsNote, "Details notes that its values may be out of date");
    assert.doesNotMatch(tab.dialogText(), runsNote, "a failed list refresh leaves Past runs without a note");
    rows.failing = [];
    await timers.fire(30_000);
    assert.doesNotMatch(tab.text(), sectionNote, "the next successful refresh clears the section note");
    assert.doesNotMatch(tab.dialogText(), detailsNote, "the next successful refresh clears the Details note");
    assert.equal(tab.details()?.["Last checked"], later.lastCheck, "the next successful refresh shows the new values");
  } finally {
    await tab.unmount();
  }
});

test("a failed refresh of each list notes it in its section and in Details only for its own list", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  const timers = proof.recordTimers();
  t.after(() => {
    timers.restore();
    restoreDom();
  });
  const rows = everyList();
  const tab = await proof.mountJobsTab(rows);
  try {
    await tab.openDetails("Details", 6);
    for (const [list, failed, other] of [["list-recurring-jobs personal", 0, 1], ["list-automations personal", 0, 1],
      ["list-recurring-jobs organization", 1, 0], ["list-automations organization", 1, 0]]) {
      rows.failing = [list];
      await timers.fire(30_000);
      assert.match(tab.section(failed).aboveRows, sectionNote, `a failed ${list} refresh notes it above the rows`);
      assert.equal(tab.section(failed).rows, 2, `a failed ${list} refresh keeps its section's rows`);
      assert.doesNotMatch(tab.section(other).text, sectionNote, `a failed ${list} refresh leaves the other section alone`);
      if (list === "list-automations organization") {
        assert.match(tab.dialogText(), detailsNote, "Details on an organization automation notes its own list");
      } else {
        assert.doesNotMatch(tab.dialogText(), detailsNote, `Details on an organization automation ignores ${list}`);
      }
      rows.failing = [];
      await timers.fire(30_000);
      assert.doesNotMatch(tab.text(), sectionNote, `the next successful refresh clears the note for ${list}`);
    }
  } finally {
    await tab.unmount();
  }
});

test("Details on a recurring job notes its own list, and an automation's Details ignores the job lists", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  const timers = proof.recordTimers();
  t.after(() => {
    timers.restore();
    restoreDom();
  });
  const rows = everyList();
  const tab = await proof.mountJobsTab(rows);
  try {
    for (const [entry, nth, list] of [["a personal recurring job", 0, "list-recurring-jobs personal"],
      ["an organization recurring job", 4, "list-recurring-jobs organization"]]) {
      await tab.openDetails("Details", nth);
      rows.failing = [list];
      await timers.fire(30_000);
      assert.match(tab.detailsAboveFields(), detailsNote, `Details on ${entry} notes ${list} above its fields`);
      rows.failing = [];
      await timers.fire(30_000);
      await tab.closeDetails();
    }
    await tab.openDetails("Details", 2);
    rows.failing = ["list-recurring-jobs personal", "list-recurring-jobs organization"];
    await timers.fire(30_000);
    assert.doesNotMatch(tab.dialogText(), detailsNote, "Details on an automation ignores failed recurring job lists");
  } finally {
    await tab.unmount();
  }
});

test("a failed runs refresh keeps the past runs and notes it under Past runs until a success", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  const timers = proof.recordTimers();
  t.after(() => {
    timers.restore();
    restoreDom();
  });
  const rows = { personal: [afterTick], organization: [], runs: [pastRun] };
  const tab = await proof.mountJobsTab(rows);
  try {
    await tab.openDetails();
    assert.equal(tab.pastRuns(), 1, "Past runs lists the run");
    rows.failing = ["list-automation-runs personal"];
    const fetched = tab.calls("list-automation-runs", "personal");
    await timers.fire(30_000);
    assert.ok(tab.calls("list-automation-runs", "personal") > fetched, "the timed refresh asks for the runs again");
    assert.equal(tab.pastRuns(), 1, "a failed refresh keeps the run listed");
    assert.match(tab.belowPastRuns(), runsNote, "the Past runs note sits under the Past runs heading");
    assert.doesNotMatch(tab.detailsAboveFields(), runsNote, "the Past runs note stays out of the space above the fields");
    assert.doesNotMatch(tab.dialogText(), detailsNote, "a failed runs refresh leaves the Details fields without a note");
    assert.doesNotMatch(tab.text(), /Could not load run history/, "a failed refresh after an answer is no load error");
    rows.failing = [];
    await timers.fire(30_000);
    assert.doesNotMatch(tab.dialogText(), runsNote, "the next successful runs refresh clears the Past runs note");
  } finally {
    await tab.unmount();
  }
});

test("each list and Past runs that fail their first load show their load errors and no refresh note", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  t.after(restoreDom);
  for (const [list, section] of [["list-recurring-jobs personal", 0], ["list-automations personal", 0],
    ["list-recurring-jobs organization", 1], ["list-automations organization", 1]]) {
    const tab = await proof.mountJobsTab({ ...everyList(), failing: [list] });
    try {
      assert.match(tab.section(section).text, /Could not load all automations/,
        `a failed first load of ${list} shows the load error`);
      assert.doesNotMatch(tab.text(), sectionNote, `a failed first load of ${list} shows no refresh note`);
    } finally {
      await tab.unmount();
    }
  }
  const tab = await proof.mountJobsTab({ ...everyList(), failing: ["list-automation-runs personal"] });
  try {
    await tab.openDetails("Details", 2);
    assert.match(tab.dialogText(), /Could not load run history/, "a failed first runs load shows the runs load error");
    assert.doesNotMatch(tab.dialogText(), runsNote, "a failed first runs load shows no refresh note");
  } finally {
    await tab.unmount();
  }
});

test("the timed refresh keeps fetching and noting failures while the browser reports no network", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  const timers = proof.recordTimers();
  t.after(() => {
    proof.resetOnline();
    timers.restore();
    restoreDom();
  });
  const rows = { ...everyList(), runs: [pastRun] };
  const tab = await proof.mountJobsTab(rows);
  const watched = [["list-automations", "personal"], ["list-recurring-jobs", "personal"],
    ["list-automations", "organization"], ["list-recurring-jobs", "organization"], ["list-automation-runs", "personal"]];
  try {
    await tab.openDetails("Details", 2);
    await tab.online(false);
    const fetched = watched.map(([action, scope]) => tab.calls(action, scope));
    await timers.fire(30_000);
    watched.forEach(([action, scope], index) => {
      assert.ok(tab.calls(action, scope) > fetched[index], `the timer fetches ${action} ${scope} with no network`);
    });
    rows.failing = ["list-automations personal", "list-automation-runs personal", "list-automations organization",
      "list-recurring-jobs organization"];
    await timers.fire(30_000);
    assert.match(tab.section(0).aboveRows, sectionNote, "a failed list refresh with no network shows the section note");
    assert.match(tab.section(1).aboveRows, sectionNote,
      "failed organization list refreshes with no network show the organization section's note");
    assert.match(tab.dialogText(), detailsNote, "a failed list refresh with no network shows the Details note");
    assert.match(tab.dialogText(), runsNote, "a failed runs refresh with no network shows the Past runs note");
  } finally {
    await tab.unmount();
  }
});

test("a list that never loaded keeps its load error while a timed retry runs", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  const timers = proof.recordTimers();
  t.after(() => {
    timers.restore();
    restoreDom();
  });
  const rows = { personal: [], organization: [], failing: ["list-automations personal"] };
  const tab = await proof.mountJobsTab(rows);
  const loadError = /Could not load all automations/;
  try {
    assert.match(tab.section(0).text, loadError, "a failed first load shows the load error");
    rows.hold = true;
    await timers.fire(30_000);
    assert.match(tab.section(0).text, loadError, "the load error stays while a timed retry is in flight");
    assert.doesNotMatch(tab.section(0).text, /Loading/, "a timed retry of a list that never loaded shows no Loading");
    rows.hold = false;
    await tab.release();
    assert.match(tab.section(0).text, loadError, "the load error stays after the retry fails");
    assert.doesNotMatch(tab.section(0).text, /Loading/, "a failed retry shows no Loading");
    rows.personal = [afterTick];
    rows.failing = [];
    await timers.fire(30_000);
    assert.doesNotMatch(tab.section(0).text, loadError, "a successful retry clears the load error");
    assert.equal(tab.section(0).rows, 1, "a successful retry lists the automation");
  } finally {
    await tab.unmount();
  }
});

test("Past runs that never loaded keep their load error while a timed retry runs", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  const timers = proof.recordTimers();
  t.after(() => {
    timers.restore();
    restoreDom();
  });
  const rows = { personal: [afterTick], organization: [], failing: ["list-automation-runs personal"] };
  const tab = await proof.mountJobsTab(rows);
  const loadError = /Could not load run history/;
  try {
    await tab.openDetails();
    assert.match(tab.belowPastRuns(), loadError, "a failed first runs load shows the load error");
    rows.hold = true;
    await timers.fire(30_000);
    assert.match(tab.belowPastRuns(), loadError, "the runs load error stays while a timed retry is in flight");
    assert.doesNotMatch(tab.belowPastRuns(), /Loading/, "a timed retry of runs that never loaded shows no Loading");
    rows.hold = false;
    await tab.release();
    assert.match(tab.belowPastRuns(), loadError, "the runs load error stays after the retry fails");
    assert.doesNotMatch(tab.belowPastRuns(), /Loading/, "a failed runs retry shows no Loading");
    rows.runs = [pastRun];
    rows.failing = [];
    await timers.fire(30_000);
    assert.doesNotMatch(tab.belowPastRuns(), loadError, "a successful retry clears the runs load error");
    assert.equal(tab.pastRuns(), 1, "a successful retry lists the run");
  } finally {
    await tab.unmount();
  }
});

test("a list reopened with the tab after a failed load shows Loading, not the old load error", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  t.after(restoreDom);
  const rows = { personal: [], organization: [], failing: ["list-automations personal"] };
  const tab = await proof.mountJobsTab(rows);
  const loadError = /Could not load all automations/;
  try {
    assert.match(tab.section(0).text, loadError, "a failed first load shows the load error");
    rows.hold = true;
    await tab.reopenTab();
    assert.match(tab.section(0).text, /Loading/, "a list reopened with the tab shows Loading during its fetch");
    assert.doesNotMatch(tab.section(0).text, loadError, "a reopened list shows no old load error");
    await tab.release();
    assert.match(tab.section(0).text, loadError, "a failed fetch after the reopen shows the load error");
    assert.doesNotMatch(tab.section(0).text, /Loading/, "a failed fetch after the reopen shows no Loading");
    await tab.reopenTab();
    assert.match(tab.section(0).text, /Loading/, "a list reopened again shows Loading during its fetch");
    assert.doesNotMatch(tab.section(0).text, loadError, "a list reopened again shows no old load error");
    rows.personal = [afterTick];
    rows.failing = [];
    await tab.release();
    assert.doesNotMatch(tab.section(0).text, loadError, "a successful fetch after the reopen shows no load error");
    assert.doesNotMatch(tab.section(0).text, /Loading/, "a successful fetch after the reopen shows no Loading");
    assert.equal(tab.section(0).rows, 1, "a successful fetch after the reopen lists the automation");
  } finally {
    await tab.unmount();
  }
});

test("Past runs reopened after a failed load show Loading, not the old load error", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  t.after(restoreDom);
  const rows = { personal: [afterTick], organization: [], failing: ["list-automation-runs personal"] };
  const tab = await proof.mountJobsTab(rows);
  const loadError = /Could not load run history/;
  try {
    await tab.openDetails();
    assert.match(tab.belowPastRuns(), loadError, "a failed runs load shows the load error");
    await tab.closeDetails();
    rows.hold = true;
    await tab.openDetails();
    assert.match(tab.belowPastRuns(), /Loading/, "reopened Details shows Loading under Past runs during its fetch");
    assert.doesNotMatch(tab.belowPastRuns(), loadError, "reopened Details shows no old runs load error");
    await tab.release();
    assert.match(tab.belowPastRuns(), loadError, "a failed runs fetch after the reopen shows the load error");
    assert.doesNotMatch(tab.belowPastRuns(), /Loading/, "a failed runs fetch after the reopen shows no Loading");
    await tab.closeDetails();
    await tab.openDetails();
    assert.match(tab.belowPastRuns(), /Loading/, "Details reopened again shows Loading under Past runs");
    assert.doesNotMatch(tab.belowPastRuns(), loadError, "Details reopened again shows no old runs load error");
    rows.runs = [pastRun];
    rows.failing = [];
    await tab.release();
    assert.doesNotMatch(tab.belowPastRuns(), loadError, "a successful runs fetch shows no load error");
    assert.equal(tab.pastRuns(), 1, "a successful runs fetch lists the run");
  } finally {
    await tab.unmount();
  }
});

test("a change from a page on this computer is sent at once with no network, and a refused one rolls back", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  const timers = proof.recordTimers();
  t.after(() => {
    proof.resetOnline();
    timers.restore();
    restoreDom();
  });
  const rows = everyList();
  const tab = await proof.mountJobsTab(rows);
  try {
    await tab.online(false);
    for (const [entry, index, action] of [["a recurring job", 0, "manage-recurring-job"],
      ["an automation", 1, "manage-automation"]]) {
      const sent = tab.calls(action, "personal");
      await tab.toggle(index);
      assert.equal(tab.calls(action, "personal"), sent + 1, `pausing ${entry} with no network sends the change at once`);
      assert.deepEqual(tab.switchState(index), { checked: "false", disabled: false },
        `the switch shows ${entry} paused and is free again once the change settles`);
      await timers.fire(30_000);
      assert.equal(tab.switchState(index).checked, "false", `a refresh after the change keeps ${entry} paused`);
    }
    rows.failing = ["manage-automation personal"];
    const sent = tab.calls("manage-automation", "personal");
    await tab.toggle(1);
    assert.equal(tab.calls("manage-automation", "personal"), sent + 1, "resuming with no network sends the change at once");
    assert.deepEqual(tab.switchState(1), { checked: "false", disabled: false }, "a refused change rolls the switch back");
    assert.match(tab.text(), /The server did not answer\./, "a refused change shows its error on the page");
    rows.failing = [];
    const ran = tab.calls("run-automation-now", "personal");
    await tab.click("Run now", 2);
    await tab.click("Run now", -1);
    assert.equal(tab.calls("run-automation-now", "personal"), ran + 1, "Run now with no network sends the run at once");
    assert.equal(tab.dialogText(), "", "the Run now dialog closes once the run is sent");
  } finally {
    await tab.unmount();
  }
});

test("a change from a page on another device waits with no network and is sent when the network returns", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom("https://vivary.example.test");
  t.after(() => {
    proof.resetOnline();
    restoreDom();
  });
  const tab = await proof.mountJobsTab(everyList());
  try {
    for (const [entry, index, action] of [["a recurring job", 0, "manage-recurring-job"],
      ["an automation", 1, "manage-automation"]]) {
      await tab.online(false);
      const sent = tab.calls(action, "personal");
      await tab.toggle(index);
      assert.equal(tab.calls(action, "personal"), sent, `pausing ${entry} with no network waits`);
      assert.deepEqual(tab.switchState(index), { checked: "false", disabled: true },
        `the switch shows ${entry} paused while its change waits`);
      await tab.online(true);
      assert.equal(tab.calls(action, "personal"), sent + 1, `pausing ${entry} is sent when the network returns`);
      assert.deepEqual(tab.switchState(index), { checked: "false", disabled: false },
        `the switch shows ${entry} paused and is free again once the change is sent`);
    }
    await tab.online(false);
    const ran = tab.calls("run-automation-now", "personal");
    await tab.click("Run now", 2);
    await tab.click("Run now", -1);
    assert.equal(tab.calls("run-automation-now", "personal"), ran, "Run now with no network waits");
    await tab.online(true);
    assert.equal(tab.calls("run-automation-now", "personal"), ran + 1, "Run now is sent when the network returns");
  } finally {
    await tab.unmount();
  }
});

test("a change from a page served by localhost or [::1] is sent at once with no network", async t => {
  const proof = await jobsTabProof();
  t.after(proof.resetOnline);
  for (const origin of ["http://localhost:8080", "http://[::1]:8080"]) {
    const restoreDom = installDom(origin);
    const tab = await proof.mountJobsTab(everyList());
    try {
      await tab.online(false);
      const sent = tab.calls("manage-automation", "personal");
      await tab.toggle(1);
      assert.equal(tab.calls("manage-automation", "personal"), sent + 1, `a pause on ${origin} is sent at once`);
    } finally {
      await tab.unmount();
      restoreDom();
    }
  }
});

test("a return of the network refetches the automation data that went stale", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  const timers = proof.recordTimers();
  t.after(() => {
    proof.resetOnline();
    timers.restore();
    restoreDom();
  });
  const tab = await proof.mountJobsTab(everyList());
  const watched = [["list-automations", { scope: "personal" }], ["list-recurring-jobs", { scope: "personal" }],
    ["list-automations", { scope: "organization" }], ["list-recurring-jobs", { scope: "organization" }],
    ["list-automation-runs", { scope: "personal", name: "digest", includePendingApprovals: true }]];
  try {
    await tab.openDetails("Details", 2);
    await tab.online(false);
    const fetched = watched.map(([action, { scope }]) => tab.calls(action, scope));
    for (const [action, params] of watched) await tab.age(action, params);
    await tab.online(true);
    watched.forEach(([action, { scope }], index) => {
      assert.ok(tab.calls(action, scope) > fetched[index], `a return of the network fetches ${action} ${scope} again`);
    });
  } finally {
    await tab.unmount();
  }
});

test("a return to a hidden window refetches the automation data that went stale", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  const timers = proof.recordTimers();
  t.after(() => {
    proof.resetFocus();
    timers.restore();
    restoreDom();
  });
  const tab = await proof.mountJobsTab({ personal: [beforeTick], organization: [] });
  const watched = [["list-automations", { scope: "personal" }], ["list-recurring-jobs", { scope: "personal" }],
    ["list-automations", { scope: "organization" }], ["list-recurring-jobs", { scope: "organization" }],
    ["list-automation-runs", { scope: "personal", name: "digest", includePendingApprovals: true }]];
  try {
    await tab.openDetails();
    await tab.focus(false);
    const fetched = watched.map(([action, { scope }]) => tab.calls(action, scope));
    await timers.fire(30_000);
    assert.deepEqual(watched.map(([action, { scope }]) => tab.calls(action, scope)), fetched,
      "the timed refresh skips a hidden window");
    for (const [action, params] of watched) await tab.age(action, params);
    await tab.focus(true);
    watched.forEach(([action, { scope }], index) => {
      assert.ok(tab.calls(action, scope) > fetched[index], `a return to the window fetches ${action} ${scope} again`);
    });
  } finally {
    await tab.unmount();
  }
});

test("every Details control opens Details on its automation", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  t.after(restoreDom);
  const failed = { ...beforeTick, lastError: "The tool failed. No delivery was confirmed." };
  const tab = await proof.mountJobsTab({ personal: [failed], organization: [] });
  try {
    for (const [control, label, nth] of [["the Manage menu item", "Details", 0], ["the hidden row button", "Details", 1],
      ["the View details link", "View details", 0]]) {
      assert.equal(tab.details(), null, `Details is closed before ${control}`);
      const fetched = tab.calls("list-automations", "personal");
      await tab.openDetails(label, nth);
      assert.ok(tab.calls("list-automations", "personal") > fetched, `${control} fetches the automation list again`);
      assert.equal(tab.details()?.["Last checked"], failed.lastCheck, `${control} opens Details on its automation`);
      await tab.closeDetails();
    }
  } finally {
    await tab.unmount();
  }
});

test("opening Details fetches only the list that holds the entry", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  t.after(restoreDom);
  const job = { ...beforeTick, id: "res-legacy", name: "legacy", instructions: "Check the build." };
  const organizationJob = { ...job, id: "res-organization-legacy", name: "organization-legacy",
    scope: "organization", lastCheck: iso(tick + 60_000) };
  const shared = { ...beforeTick, id: "res-shared", name: "shared", scope: "organization",
    lastCheck: iso(tick + 120_000) };
  const tab = await proof.mountJobsTab({ personal: [], organization: [shared],
    jobs: { personal: [job], organization: [organizationJob] } });
  const lists = [["list-recurring-jobs", "personal"], ["list-automations", "personal"],
    ["list-recurring-jobs", "organization"], ["list-automations", "organization"]];
  const fetches = () => lists.map(([action, scope]) => tab.calls(action, scope));
  try {
    for (const [entry, row, action, scope, nth] of [
      ["a personal recurring job", job, "list-recurring-jobs", "personal", 0],
      ["an organization recurring job", organizationJob, "list-recurring-jobs", "organization", 2],
      ["an organization automation", shared, "list-automations", "organization", 4]]) {
      const fetched = fetches();
      await tab.openDetails("Details", nth);
      const now = fetches();
      assert.deepEqual(lists.filter((_, index) => now[index] > fetched[index]).map(list => list.join(" ")),
        [`${action} ${scope}`], `opening Details on ${entry} fetches ${action} ${scope} again and no other list`);
      assert.equal(tab.details()?.["Last checked"], row.lastCheck, `Details shows ${entry}`);
      await tab.closeDetails();
    }
  } finally {
    await tab.unmount();
  }
});

test("past runs refresh while Details stays open", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  const timers = proof.recordTimers();
  t.after(() => {
    timers.restore();
    restoreDom();
  });
  const tab = await proof.mountJobsTab({ personal: [beforeTick], organization: [] });
  try {
    await tab.openDetails();
    const fetched = tab.calls("list-automation-runs", "personal");
    await timers.fire(30_000);
    assert.ok(tab.calls("list-automation-runs", "personal") > fetched,
      "a timer of 30 seconds or less fetches the open automation's past runs again, so they keep up with LAST RUN");
  } finally {
    await tab.unmount();
  }
});

test("Details closes when its automation leaves the list", async t => {
  const proof = await jobsTabProof();
  const restoreDom = installDom();
  t.after(restoreDom);
  const rows = { personal: [beforeTick], organization: [] };
  const tab = await proof.mountJobsTab(rows);
  try {
    await tab.openDetails();
    assert.ok(tab.details(), "Details opens");
    rows.personal = [];
    await tab.setList("personal", []);
    assert.equal(tab.details(), null, "Details closes once the list no longer holds its automation");
    rows.personal = [beforeTick];
    await tab.setList("personal", [beforeTick]);
    assert.equal(tab.details(), null, "Details stays closed when the same automation returns to the list");
  } finally {
    await tab.unmount();
  }
});
