import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const WB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE = path.dirname(realpathSync(path.join(WB, "node_modules/@agent-native/core/package.json")));
const CLIENT = path.join(CORE, "dist/client");
const unavailable = { available: false, reason: "OAuth setup and signing in again are unavailable in the desktop app. Existing saved connections can still be tested or retried." };
const integration = { id: "fixture", name: "Fixture", provider: "Fixture", description: "Fixture integration", useCase: "Fixture",
  descriptionKey: "Fixture integration", useCaseKey: "Fixture",
  url: "https://fixture.example.test/mcp", authMode: "oauth", connectionMode: "oauth", availability: "ready", verification: "verified", logoUrl: "", keywords: [] };
let fixture;
const proof = String.raw`
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { McpIntegrationDialog } from "@proof/dialog";
import { McpIntegrationsSection } from "@proof/section";
import { McpServerDetail } from "@proof/detail";
import { FirstRunOnboarding } from "@proof/onboarding";
import { AutomationScheduleDialog } from "@proof/schedule";
import { automationScheduleToCron, automationScheduleDraftFromCron } from "@proof/cron";
const components = { dialog: McpIntegrationDialog, section: McpIntegrationsSection, detail: McpServerDetail, onboarding: FirstRunOnboarding };
export async function mount(kind, props) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); const Component = components[kind];
  await act(async () => { root.render(<Component {...props} />); });
  return { host, async click(button) { await act(async () => { button.click(); await new Promise(r => setTimeout(r, 0)); }); },
    async close() { await act(async () => root.unmount()); host.remove(); } };
}
export function schedule(cron) {
  return renderToStaticMarkup(<AutomationScheduleDialog open name="Fixture" schedule={cron} timezone="UTC" saving={false}
    scheduledTriggerState={{ available: true }} onCancel={() => {}} onSave={() => {}} />);
}
export { automationScheduleToCron, automationScheduleDraftFromCron };
`;
const passthrough = `export const Dialog=({open,children})=>open?<div>{children}</div>:null;
  export const DialogContent=({children})=><div>{children}</div>, DialogDescription=DialogContent, DialogHeader=DialogContent,
    DialogTitle=DialogContent, DialogFooter=DialogContent, Tooltip=DialogContent, TooltipContent=DialogContent, TooltipTrigger=DialogContent;
  export const Button=({children,...props})=><button {...props}>{children}</button>;
  export const Input=props=><input {...props}/>;
  export const Select=DialogContent, SelectContent=DialogContent, SelectItem=DialogContent, SelectTrigger=DialogContent, SelectValue=()=>null;
  export const Skeleton=()=>null;`;
const stubs = new Map([
  ["resources/use-mcp-servers.js", `
    const state=()=>globalThis.__oauthFixture;
    export const useMcpServers=()=>state().query;
    export const useMcpOAuthAvailability=()=>state().query.data.oauth;
    export const useMcpServersApi=()=>({testExisting:async args=>{state().calls.push(['test',args]);return {ok:true,tools:[]};},test:async()=>({ok:true,tools:[]})});
    export const useReconnectMcpServer=()=>({mutateAsync:async args=>{state().calls.push(['retry',args]);},isPending:false});
    export const useCreateMcpServer=()=>({mutateAsync:async args=>{state().calls.push(['create',args]);},isPending:false});
    export const useDeleteMcpServer=()=>({mutateAsync:async()=>{},isPending:false});
    export const getMcpUrlValidationError=()=>null, formatMcpServerError=e=>String(e),formatMcpServersLoadError=e=>String(e);`],
  ["i18n.js", `export const useT=()=>((key,opts={})=>String(opts.defaultValue??key??'').replace(/{{([A-Za-z0-9_]+)}}/g,(_,name)=>String(opts[name]??'')));`],
  ["api-path.js", `export const agentNativePath=p=>p,appPath=p=>p;`],
  ["CommandMenu.js", `export const openAgentSettings=value=>globalThis.__oauthFixture.calls.push(["settings",value]);`],
  ["utils.js", `export const cn=(...args)=>args.filter(Boolean).join(' ');`],
  ["resources/McpIntegrationLogo.js", `export const McpIntegrationLogo=()=>null;`],
  ["integrations/IntegrationConnectionChoice.js", `export const IntegrationConnectionChoice=()=>null;`],
  ["integrations/IntegrationGrid.js", `export const IntegrationGrid=({items})=><div>{items.map(item=><button key={item.id} disabled={item.disabled} onClick={item.onAction}>{item.name} {item.actionLabel}</button>)}</div>;`],
  ["integrations/useIntegrationStatus.js", `export const useIntegrationStatus=()=>({loading:false,statuses:{}});`],
  ["settings/BuilderConnectPopover.js", `export const BuilderConnectPopover=()=>null;`],
  ["settings/useBuilderStatus.js", `export const useBuilderConnectFlow=()=>({status:null,loading:false});`],
  ["onboarding/use-onboarding.js", `export const useOnboarding=()=>({firstRun:true,loading:false,profile:{capabilities:[]},completeFirstRun:async()=>{}});export const trackOnboardingEvent=()=>{};`],
  ["onboarding/use-preview-mode.js", `export const useOnboardingPreviewMode=()=>false;`],
  ["onboarding/first-run-registry.js", `export const listFirstRunOnboardingExtensions=()=>[];`],
  ["onboarding/first-run-status.js", `export const saveFirstRunOnboardingRole=async()=>{};`],
  ["agent-page/TimezoneSelect.js", `export const browserTimezone=()=>"UTC",TimezoneSelect=({value})=><div>{value}</div>;`],
  ["agent-page/ScheduledTriggerNotice.js", `export const ScheduledTriggerNotice=()=>null;`],
]);
let built;
let bundleRoot;
async function build() {
  const entries = { dialog: "resources/McpIntegrationDialog.js", section: "integrations/IntegrationsPanel.js", detail: "resources/McpServerDetail.js",
    onboarding: "onboarding/FirstRunOnboarding.js", schedule: "agent-page/AutomationScheduleDialog.js", cron: "agent-page/automation-schedule.js" };
  const icons = new Set();
  for (const entry of Object.values(entries)) {
    for (const name of (await readFile(path.join(CLIENT, entry), "utf8")).match(/\bIcon\w+/g) ?? []) icons.add(name);
  }
  const result = await esbuild.build({ stdin: { contents: proof, resolveDir: WB, loader: "tsx" }, absWorkingDir: WB,
    bundle: true, write: false, platform: "node", format: "esm", jsx: "automatic", logLevel: "silent",
    banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(path.join(WB, "package.json"))});` },
    // Vite replaces import.meta.env.DEV at build time. A packaged app reads false, which the Builder choice screen needs.
    define: { "process.env.NODE_ENV": '"development"', "import.meta.env.DEV": "false" },
    plugins: [{ name: "oauth-component-controls", setup(build) {
      build.onResolve({ filter: /^@proof\// }, args => ({ path: path.join(CLIENT, entries[args.path.slice(7)]) }));
      build.onResolve({ filter: /^@tabler\/icons-react$/ }, () => ({ path: "icons", namespace: "proof" }));
      build.onResolve({ filter: /^@agent-native\/toolkit\/ui\// }, () => ({ path: "ui", namespace: "proof" }));
      build.onLoad({ filter: /.*/, namespace: "proof" }, args => ({ contents: args.path === "ui" ? passthrough : [...icons].map(name => `export const ${name}=()=>null;`).join("\n"), loader: "tsx", resolveDir: WB }));
      build.onLoad({ filter: /\.js$/ }, async args => {
        if (!args.path.startsWith(CLIENT + path.sep)) return;
        const relative = path.relative(CLIENT, args.path);
        if (stubs.has(relative)) return { contents: stubs.get(relative), loader: "tsx", resolveDir: path.dirname(args.path) };
        if (relative.startsWith("components/ui/")) return { contents: passthrough, loader: "tsx", resolveDir: WB };
        if (relative === "onboarding/FirstRunOnboarding.js") {
          // Start at the integrations step unless a test names another. Its actual buttons and handlers remain intact.
          return { contents: (await readFile(args.path, "utf8")).replace('useState("intro")', 'useState(globalThis.__onboardingStart ?? "tools")'), loader: "js", resolveDir: path.dirname(args.path) };
        }
      });
    } }],
  });
  bundleRoot = await mkdtemp(path.join(os.tmpdir(), "vivary-oauth-component-"));
  const file = path.join(bundleRoot, "proof.mjs");
  await writeFile(file, result.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}
function state(oauth = unavailable, servers = []) {
  fixture = { calls: [], query: { isSuccess: true, isError: false, data: { oauth, user: servers, org: [], role: null, orgId: null } } };
  globalThis.__oauthFixture = fixture;
}
function dom() {
  const view = createRequire(path.join(CORE, "package.json"))("linkedom").parseHTML("<!doctype html><html><body></body></html>");
  const channels = [];
  class TrackedChannel extends MessageChannel { constructor() { super(); channels.push(this); } }
  Object.assign(view, { location: { pathname: "/", search: "", hash: "", assign: url => fixture.calls.push(["navigate", url]) } });
  for (const [key, value] of Object.entries({ window: view, self: view, document: view.document, navigator: view.navigator,
    HTMLElement: view.HTMLElement, Element: view.Element, Node: view.Node, Event: view.Event, CustomEvent: view.CustomEvent,
    MessageChannel: TrackedChannel, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  return () => channels.forEach(channel => { channel.port1.close(); channel.port2.close(); });
}
let closeDom;
test.before(async () => { state(); closeDom = dom(); built = await build(); });
test.after(async () => { closeDom?.(); await esbuild.stop(); if (bundleRoot) await rm(bundleRoot, { recursive: true, force: true }); });
const dialogProps = { open: true, onOpenChange() {}, defaultScope: "user", canCreateOrgMcp: false, hasOrg: false, onCreateMcpServer: async () => {}, integrations: [integration] };
const button = (host, text) => [...host.querySelectorAll("button")].find(item => item.textContent.trim() === text);

for (const connectIntegrationId of [undefined, "fixture"]) {
  test(`ready OAuth catalog explains refusal with ${connectIntegrationId ? "requested Connect" : "default catalog"}`, async () => {
    state();
    const mounted = await built.mount("dialog", { ...dialogProps, connectIntegrationId,
      onOAuthStart: () => fixture.calls.push(["start"]) });
    try {
      assert.match(mounted.host.textContent, /OAuth setup and signing in again are unavailable/);
      const connect = button(mounted.host, "Fixture mcpIntegrations.connect");
      assert.ok(connect); assert.ok(connect.disabled);
      await mounted.click(connect); assert.deepEqual(fixture.calls, []);
    } finally { await mounted.close(); }
  });
}
test("non-desktop catalog OAuth still starts the existing flow", async () => {
  state({ available: true });
  const mounted = await built.mount("dialog", { ...dialogProps, onOAuthStart: () => fixture.calls.push(["start"]) });
  try {
    const connect = button(mounted.host, "Fixture mcpIntegrations.connect");
    assert.ok(connect); assert.equal(connect.disabled, false);
    await mounted.click(connect); assert.deepEqual(fixture.calls, [["start"]]);
  } finally { await mounted.close(); }
});
for (const authMode of ["none", "headers"]) {
  test(`desktop catalog ${authMode} connection remains available`, async () => {
    state();
    const plain = { ...integration, authMode, connectionMode: "direct" };
    const mounted = await built.mount("dialog", { ...dialogProps, integrations: [plain],
      onCreateMcpServer: async args => fixture.calls.push(["create", args]) });
    try {
      const connect = button(mounted.host, "Fixture mcpIntegrations.connect");
      assert.ok(connect); assert.equal(connect.disabled, false); await mounted.click(connect);
      if (authMode === "none") assert.equal(fixture.calls[0][0], "create");
      else { assert.ok(button(mounted.host, "mcpIntegrations.connect")); assert.deepEqual(fixture.calls, []); }
    } finally { await mounted.close(); }
  });
}
test("desktop setup-only catalog keeps its API-token fallback", async () => {
  state();
  const manual = { ...integration, connectionMode: "manual", availability: "provider-setup",
    apiFallback: { secretKey: "FIXTURE_API_KEY" } };
  const mounted = await built.mount("dialog", { ...dialogProps, integrations: [manual] });
  try {
    const fallback = button(mounted.host, "Fixture mcpIntegrations.useApiToken");
    assert.ok(fallback); assert.equal(fallback.disabled, false); await mounted.click(fallback);
    assert.deepEqual(fixture.calls, [["settings", "secrets:FIXTURE_API_KEY"]]);
  } finally { await mounted.close(); }
});
test("catalog OAuth with filled defaults explains desktop unavailability and cannot start", async () => {
  state(); const mounted = await built.mount("dialog", { ...dialogProps, initialIntegrationId: "fixture" });
  try {
    assert.match(mounted.host.textContent, /OAuth setup and signing in again are unavailable/);
    const connect = button(mounted.host, "mcpIntegrations.connectWithOAuth"); assert.ok(connect); assert.ok(connect.disabled);
    assert.equal(mounted.host.querySelectorAll("input")[0].value, "Fixture");
    await mounted.click(connect); assert.deepEqual(fixture.calls, []);
  } finally { await mounted.close(); }
});
test("custom OAuth form has the same reason and disabled start", async () => {
  state(); const mounted = await built.mount("dialog", { ...dialogProps, integrations: [] });
  try { assert.match(mounted.host.textContent, /OAuth setup and signing in again are unavailable/);
    assert.ok(button(mounted.host, "mcpIntegrations.connectWithOAuth").disabled); assert.deepEqual(fixture.calls, []);
  } finally { await mounted.close(); }
});
test("non-desktop OAuth remains enabled for a complete catalog form", async () => {
  state({ available: true }); const mounted = await built.mount("dialog", { ...dialogProps, initialIntegrationId: "fixture", onOAuthStart: async url => fixture.calls.push(["navigate", url]) });
  try { const connect = button(mounted.host, "mcpIntegrations.connectWithOAuth"); assert.ok(connect); assert.equal(connect.disabled, false);
    await mounted.click(connect); assert.equal(fixture.calls[0][0], "navigate");
  } finally { await mounted.close(); }
});
const server = { id: "saved", scope: "user", name: "Saved", url: integration.url, authMode: "oauth", createdAt: 1, mergedId: "fixture", status: { state: "error", error: "Connection unavailable" } };
test("desktop saved OAuth retry uses POST retry rather than interactive sign-in", async () => {
  state(unavailable, [server]); const mounted = await built.mount("section", { integrations: [], showHeader: false });
  try { const retry = button(mounted.host, "Retry saved connection"); assert.ok(retry); await mounted.click(retry);
    assert.deepEqual(fixture.calls, [["retry", { id: "saved", scope: "user" }]]);
  } finally { await mounted.close(); }
});
test("saved OAuth detail keeps Test enabled despite unavailable setup", async () => {
  state(unavailable, [server]); const mounted = await built.mount("detail", { server });
  try { const probe = button(mounted.host, "Test connection"); assert.ok(probe); assert.equal(probe.disabled, false);
    await mounted.click(probe); assert.deepEqual(fixture.calls, [["test", { id: "saved", scope: "user" }]]);
  } finally { await mounted.close(); }
});
test("first-run OAuth cards expose the reason and cannot navigate", async () => {
  state(); const mounted = await built.mount("onboarding", {});
  try { assert.match(mounted.host.textContent, /OAuth setup and signing in again are unavailable/);
    const oauthButtons = [...mounted.host.querySelectorAll("button")].filter(item => /GitHub|Linear/.test(item.textContent));
    assert.ok(oauthButtons.length > 0); assert.ok(oauthButtons.every(item => item.disabled)); assert.deepEqual(fixture.calls, []);
  } finally { await mounted.close(); }
});
for (const [cron, text] of [["15 */2 * * *", "Runs every 2 hours at minute 15."], ["0 */1 * * *", "Runs every hour at minute 0."], ["59 */3 * * *", "Runs every 3 hours at minute 59."]]) {
  test(`hourly summary and cron agree for ${cron}`, () => { const html=built.schedule(cron); assert.ok(html.includes(text), JSON.stringify(html.match(/Runs[^<]+/g)));
    assert.equal(built.automationScheduleToCron(built.automationScheduleDraftFromCron(cron).draft).schedule, cron.replace("*/1", "*"));
  });
}
for (const backIndex of [0, 1]) {
  test(`local first-run key form Back ${backIndex === 0 ? "link" : "button"} returns to the intro`, async () => {
    state(); globalThis.__onboardingStart = "intro"; window.__AGENT_NATIVE_CONFIG__ = { builderOffers: false };
    const mounted = await built.mount("onboarding", {});
    try {
      await mounted.click(button(mounted.host, "Continue"));
      assert.match(mounted.host.textContent, /Your keys/, "local Continue skips the Builder choice");
      const backs = [...mounted.host.querySelectorAll("button")].filter(item => item.textContent.trim() === "Back");
      assert.equal(backs.length, 2);
      await mounted.click(backs[backIndex]);
      assert.match(mounted.host.textContent, /Free forever\./);
      assert.doesNotMatch(mounted.host.textContent, /Your keys/);
    } finally { delete globalThis.__onboardingStart; delete window.__AGENT_NATIVE_CONFIG__; await mounted.close(); }
  });
}
test("first-run key form Back still returns to the Builder choice when offers are on", async () => {
  state(); globalThis.__onboardingStart = "manual"; window.__AGENT_NATIVE_CONFIG__ = {};
  const mounted = await built.mount("onboarding", {});
  try {
    assert.match(mounted.host.textContent, /Your keys/);
    await mounted.click(button(mounted.host, "Back"));
    assert.match(mounted.host.textContent, /Choose your setup\./);
  } finally { delete globalThis.__onboardingStart; delete window.__AGENT_NATIVE_CONFIG__; await mounted.close(); }
});
