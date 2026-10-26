import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKBENCH = resolve(HERE, "..");
const APP = join(WORKBENCH, "app");
const TEST_FILE = fileURLToPath(import.meta.url);
const DEPENDENCY_MANIFEST_ENV = "VIVARY_TEST_COMPONENT_DEPENDENCY_MANIFEST";
const expectedDependencies = Object.freeze({
  esbuild: Object.freeze({ name: "esbuild", version: "0.28.2" }),
  esbuildNative: Object.freeze({ name: "@esbuild/win32-x64", version: "0.28.2" }),
  linkedom: Object.freeze({ name: "linkedom", version: "0.18.12" }),
  react: Object.freeze({ name: "react", version: "19.2.8" }),
  reactDom: Object.freeze({ name: "react-dom", version: "19.2.8" }),
  reactQuery: Object.freeze({ name: "@tanstack/react-query", version: "5.102.8" }),
  zod: Object.freeze({ name: "zod", version: "4.6.7" }),
});

function loadDependencies() {
  const configured = process.env[DEPENDENCY_MANIFEST_ENV]; // guard:allow-env-credential - Reviewed test manifest path; no credential value.
  assert.ok(configured && isAbsolute(configured), "explicit absolute component dependency manifest required");
  const manifestPath = realpathSync(configured);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.ok(typeof manifest === "object" && manifest !== null && !Array.isArray(manifest));
  assert.deepEqual(Object.keys(manifest).sort(), ["packages", "schemaVersion"]);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(typeof manifest.packages, "object");
  assert.ok(manifest.packages !== null && !Array.isArray(manifest.packages));
  assert.deepEqual(Object.keys(manifest.packages).sort(), Object.keys(expectedDependencies).sort());
  const dependencies = new Map();
  for (const [key, expected] of Object.entries(expectedDependencies)) {
    const packageJsonInput = manifest.packages[key];
    assert.ok(typeof packageJsonInput === "string" && isAbsolute(packageJsonInput),
      `absolute package.json path required for ${key}`);
    const packageJson = realpathSync(packageJsonInput);
    const actual = JSON.parse(readFileSync(packageJson, "utf8"));
    assert.deepEqual({ name: actual.name, version: actual.version }, expected,
      `unexpected component proof dependency at ${packageJson}`);
    dependencies.set(key, Object.freeze({ packageJson, root: dirname(packageJson),
      require: createRequire(packageJson) }));
  }
  return dependencies;
}

function dependencyEntry(dependencies, key, specifier) {
  const dependency = dependencies.get(key);
  assert.ok(dependency, `missing reviewed dependency ${key}`);
  const entry = realpathSync(dependency.require.resolve(specifier));
  const fromRoot = relative(dependency.root, entry);
  assert.ok(fromRoot.length > 0 && !fromRoot.startsWith("..") && !isAbsolute(fromRoot),
    `${specifier} resolved outside its reviewed package root`);
  return entry;
}

function dependencyFile(dependencies, key, ...segments) {
  const dependency = dependencies.get(key);
  assert.ok(dependency, `missing reviewed dependency ${key}`);
  const entry = realpathSync(join(dependency.root, ...segments));
  const fromRoot = relative(dependency.root, entry);
  assert.ok(fromRoot.length > 0 && !fromRoot.startsWith("..") && !isAbsolute(fromRoot),
    `${segments.join("/")} resolved outside its reviewed package root`);
  return entry;
}

function assertWorkerEvidence(stdout, expectedCases) {
  const lines = stdout.split(/\r?\n/);
  const starts = lines.filter(line => line.startsWith("START ")).map(line => line.slice(6));
  const passes = lines.filter(line => line.startsWith("PASS ")
    && !line.startsWith("PASS runtime readiness component cleanup ")).map(line => line.slice(5));
  assert.equal(starts.length, expectedCases, `expected ${expectedCases} component case starts`);
  assert.deepEqual(passes, starts, "every started component case must emit one ordered pass marker");
  assert.equal(lines.filter(line => line === "PASS runtime readiness component cleanup "
    + "nodeWorkers=1 esbuildServices=1 esbuildStopped=true globalsRestored=true").length, 1,
    "component cleanup evidence must appear exactly once");
  const channelEvidence = lines.filter(line => line.startsWith("MESSAGE_CHANNEL_CLEANUP "));
  assert.equal(channelEvidence.length, 1, "MessageChannel cleanup evidence must appear exactly once");
  const match = /^MESSAGE_CHANNEL_CLEANUP channels=(\d+) portsClosed=(\d+)$/.exec(channelEvidence[0]);
  assert.ok(match);
  assert.ok(Number(match[1]) > 0, "React proof must exercise the tracked MessageChannel fallback");
  assert.equal(Number(match[2]), Number(match[1]) * 2, "both ports of every MessageChannel must close");
}

const nativeHooksSource = String.raw`
import { useQuery } from "@tanstack/react-query";
import { catalogSchema, selectionSchema, type CatalogResult, type ProjectSelection } from "@/lib/project-catalog-schema";

type Gate = { promise: Promise<void>; release: () => void };
type ActionOptions = {
  enabled?: boolean;
  retry?: boolean;
  refetchInterval?: number;
  refetchOnWindowFocus?: boolean | "always";
};

function gate(): Gate {
  let resolvePromise = () => {};
  let released = false;
  const promise = new Promise<void>(resolve => { resolvePromise = resolve; });
  return { promise, release: () => { if (!released) { released = true; resolvePromise(); } } };
}

let catalog: CatalogResult = { code: "unavailable" };
let selection: ProjectSelection | null = null;
let readiness = new Map<string, unknown>();
let readinessUnavailable = false;
let readinessGates = new Map<string, Gate>();
type Metrics = { catalogReads: number; readinessReads: string[];
  readinessInputs: Array<Record<string, unknown>>; selectionReads: number;
  selectionWrites: string[] };
let metrics: Metrics = { catalogReads: 0, readinessReads: [], readinessInputs: [], selectionReads: 0,
  selectionWrites: [] };

function releaseAll(): void {
  for (const held of readinessGates.values()) held.release();
  readinessGates.clear();
}

export const nativeProofControl = {
  configure(value: { catalog: unknown; selection: unknown; readiness: Record<string, unknown> }): void {
    releaseAll();
    catalog = catalogSchema.parse(value.catalog);
    selection = value.selection === null ? null : selectionSchema.parse(value.selection);
    readiness = new Map(Object.entries(value.readiness));
    readinessUnavailable = false;
    metrics = { catalogReads: 0, readinessReads: [], readinessInputs: [], selectionReads: 0,
      selectionWrites: [] };
  },
  setCatalog(value: unknown): void { catalog = catalogSchema.parse(value); },
  setReadinessUnavailable(value: boolean): void { readinessUnavailable = value; },
  holdReadiness(projectId: string): () => void {
    if (readinessGates.has(projectId)) throw new Error("readiness read already held");
    const held = gate();
    readinessGates.set(projectId, held);
    return held.release;
  },
  releaseAll,
  snapshot() { return { metrics: structuredClone(metrics), pending: readinessGates.size }; },
};

async function readAction(action: string, input: Record<string, unknown>): Promise<unknown> {
  if (action === "vivary-project-catalog") {
    metrics.catalogReads += 1;
    return structuredClone(catalog);
  }
  if (action !== "vivary-project-runtime-readiness") throw new Error("unexpected Native action: " + action);
  const projectId = typeof input.projectId === "string" ? input.projectId : "invalid";
  metrics.readinessReads.push(projectId);
  metrics.readinessInputs.push(structuredClone(input));
  const captured = structuredClone(readiness.get(projectId));
  const held = readinessGates.get(projectId);
  if (held) await held.promise;
  if (readinessGates.get(projectId) === held) readinessGates.delete(projectId);
  if (readinessUnavailable) throw new Error("synthetic unavailable action transport");
  return captured;
}

export function useActionQuery<T>(action: string, input: Record<string, unknown>, options: ActionOptions = {}) {
  return useQuery<T>({
    ...options,
    queryKey: ["proof-action", action, input],
    queryFn: async () => await readAction(action, input) as T,
  });
}

export async function readClientAppState(_key: string, _options: { signal?: AbortSignal } = {}): Promise<ProjectSelection | null> {
  metrics.selectionReads += 1;
  return structuredClone(selection);
}

export async function writeClientAppState(_key: string, value: unknown): Promise<void> {
  const parsed = selectionSchema.parse(value);
  selection = parsed;
  metrics.selectionWrites.push(parsed.projectId);
}
`;

const toolkitSource = String.raw`
export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={className} data-proof-skeleton />;
}
`;

const proofSource = String.raw`
import assert from "node:assert/strict";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectProvider, useProjects } from "@canonical/ProjectContext";
import { Conversation } from "@canonical/Conversation";
import { nativeProofControl } from "@proof/native-hooks";
import type { ProjectCatalog } from "@/lib/project-catalog-schema";

const SCOPE = "scope-runtime-readiness";
const PROJECT_A = "project-a";
const PROJECT_B = "project-b";
type ProjectState = ReturnType<typeof useProjects>;
let observedState: ProjectState | null = null;
let activeRoots = 0;
let activeClients = 0;

function catalog(): ProjectCatalog {
  return { code: "catalog", scopeKey: SCOPE, policyRevision: 7, registryRevision: 11, locations: [], projects: [
    { projectId: PROJECT_A, displayName: "Project Alpha", bindingRevision: 4, status: "available" },
    { projectId: PROJECT_B, displayName: "Project Beta", bindingRevision: 5, status: "available" },
  ] };
}

function observations(bound: "available" | "unavailable" = "available") {
  const currentBinding = { state: bound, evidence: ["current-binding", "root-observation"] };
  return {
    installed: { state: "available", evidence: ["package-inventory"] },
    configured: { state: "available", evidence: ["trusted-configuration"] },
    authenticated: { state: "available", evidence: ["runtime-authentication"] },
    bound: currentBinding,
    runnable: bound === "available"
      ? { state: "available", evidence: ["runtime-execution"] }
      : { state: "unavailable", evidence: ["current-binding"] },
    verified: bound === "available"
      ? { state: "available", evidence: ["verification-receipt"] }
      : { state: "unavailable", evidence: ["current-binding"] },
  };
}

function ready(projectId: string, bindingRevision: number, scopeKey = SCOPE) {
  return { code: "readiness", projectId, scopeKey, bindingRevision, policyRevision: 7,
    observations: observations(), blockers: [] };
}

function blocked(projectId: string, bindingRevision: number) {
  return { code: "readiness", projectId, scopeKey: SCOPE, bindingRevision, policyRevision: 7,
    observations: observations("unavailable"),
    blockers: ["binding-unavailable", "runtime-unavailable", "runtime-unverified"] };
}

function Capture({ children }: { children?: ReactNode }) {
  observedState = useProjects();
  return <>{children}</>;
}

function currentState(): ProjectState {
  if (observedState === null) throw new Error("ProjectContext has not rendered");
  return observedState;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const expires = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= expires) throw new Error("timed out: " + message);
    await flush();
  }
}

type Mounted = { container: HTMLElement; queryClient: QueryClient; root: Root; dispose: () => Promise<void> };
async function mount(): Promise<Mounted> {
  observedState = null;
  const container = document.createElement("div");
  document.body.append(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const root = createRoot(container);
  activeRoots += 1;
  activeClients += 1;
  try {
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><ProjectProvider><Capture><Conversation /></Capture>
        </ProjectProvider></QueryClientProvider>);
    });
  } catch (error) {
    await act(async () => { root.unmount(); });
    nativeProofControl.releaseAll();
    await queryClient.cancelQueries();
    queryClient.clear();
    container.remove();
    observedState = null;
    activeRoots -= 1;
    activeClients -= 1;
    throw error;
  }
  return { container, queryClient, root, dispose: async () => {
    await act(async () => { root.unmount(); });
    nativeProofControl.releaseAll();
    await queryClient.cancelQueries();
    assert.equal(queryClient.isFetching(), 0);
    assert.equal(queryClient.isMutating(), 0);
    queryClient.clear();
    container.remove();
    observedState = null;
    activeRoots -= 1;
    activeClients -= 1;
    await flush();
  } };
}

async function selectProject(projectId: string): Promise<boolean> {
  let operation = Promise.resolve(false);
  act(() => { operation = currentState().selectProject(projectId); });
  let selected = false;
  await act(async () => { selected = await operation; });
  return selected;
}

async function pendingSelectionHidesOldReadiness(): Promise<void> {
  nativeProofControl.configure({ catalog: catalog(), selection: { scopeKey: SCOPE, projectId: PROJECT_A },
    readiness: { [PROJECT_A]: ready(PROJECT_A, 4), [PROJECT_B]: blocked(PROJECT_B, 5) } });
  const mounted = await mount();
  try {
    await waitFor(() => (mounted.container.textContent ?? "").includes("Runtime checks passed"), "A readiness");
    assert.deepEqual(nativeProofControl.snapshot().metrics.readinessInputs[0], {
      projectId: PROJECT_A, expectedBindingRevision: "4", expectedPolicyRevision: "7", scopeKey: SCOPE,
    });
    const releaseB = nativeProofControl.holdReadiness(PROJECT_B);
    assert.equal(await selectProject(PROJECT_B), true);
    await waitFor(() => nativeProofControl.snapshot().metrics.readinessReads.includes(PROJECT_B), "B readiness to start");
    assert.equal(mounted.container.querySelectorAll("[data-proof-skeleton]").length, 2);
    assert.ok(!(mounted.container.textContent ?? "").includes("Runtime checks passed"));
    releaseB();
    await waitFor(() => (mounted.container.textContent ?? "").includes("Current blockers for Project Beta"), "B blockers");
    assert.match(mounted.container.textContent ?? "", /current project folder binding is unavailable/i);
  } finally { await mounted.dispose(); }
}

async function delayedOldResultCannotCrossSelection(): Promise<void> {
  nativeProofControl.configure({ catalog: catalog(), selection: { scopeKey: SCOPE, projectId: PROJECT_A },
    readiness: { [PROJECT_A]: ready(PROJECT_A, 4), [PROJECT_B]: blocked(PROJECT_B, 5) } });
  const releaseA = nativeProofControl.holdReadiness(PROJECT_A);
  const mounted = await mount();
  try {
    await waitFor(() => nativeProofControl.snapshot().metrics.readinessReads.includes(PROJECT_A), "A delayed readiness");
    assert.equal(await selectProject(PROJECT_B), true);
    await waitFor(() => (mounted.container.textContent ?? "").includes("Current blockers for Project Beta"), "B blockers");
    releaseA();
    await flush();
    await flush();
    assert.equal(mounted.container.getAttribute("data-project-scope"), null);
    assert.equal(mounted.container.querySelector(".conversation-unavailable-shell")?.getAttribute("data-project-scope"), PROJECT_B);
    assert.ok(!(mounted.container.textContent ?? "").includes("Runtime checks passed"));
  } finally { await mounted.dispose(); }
}

async function revocationClearsReadiness(): Promise<void> {
  nativeProofControl.configure({ catalog: catalog(), selection: { scopeKey: SCOPE, projectId: PROJECT_A },
    readiness: { [PROJECT_A]: ready(PROJECT_A, 4) } });
  const mounted = await mount();
  try {
    await waitFor(() => (mounted.container.textContent ?? "").includes("Runtime checks passed"), "ready state");
    nativeProofControl.setCatalog({ code: "denied" });
    await act(async () => { await currentState().refresh(); });
    await waitFor(() => (mounted.container.textContent ?? "").includes("Choose a project"), "revoked project");
    assert.ok(!(mounted.container.textContent ?? "").includes("Runtime checks passed"));
  } finally { await mounted.dispose(); }
}

async function malformedAndMismatchedResponsesFailClosed(): Promise<void> {
  const incomplete = { ...ready(PROJECT_A, 4), observations: {
    ...observations(), authenticated: { state: "unknown" },
  } };
  for (const response of [{ nope: true }, ready(PROJECT_A, 4, "old-scope"), incomplete]) {
    nativeProofControl.configure({ catalog: catalog(), selection: { scopeKey: SCOPE, projectId: PROJECT_A },
      readiness: { [PROJECT_A]: response } });
    const mounted = await mount();
    try {
      await waitFor(() => (mounted.container.textContent ?? "").includes("could not be verified"), "failed response");
      assert.ok(!(mounted.container.textContent ?? "").includes("Runtime checks passed"));
    } finally { await mounted.dispose(); }
  }
}

async function unavailableTransportLeavesConversationInactive(): Promise<void> {
  nativeProofControl.configure({ catalog: catalog(), selection: { scopeKey: SCOPE, projectId: PROJECT_A },
    readiness: { [PROJECT_A]: ready(PROJECT_A, 4) } });
  const mounted = await mount();
  try {
    await waitFor(() => (mounted.container.textContent ?? "").includes("Runtime checks passed"), "initial success");
    nativeProofControl.setReadinessUnavailable(true);
    await act(async () => { await mounted.queryClient.refetchQueries({
      queryKey: ["proof-action", "vivary-project-runtime-readiness"],
    }); });
    await waitFor(() => (mounted.container.textContent ?? "").includes("could not be verified"), "transport failure");
    assert.ok(!(mounted.container.textContent ?? "").includes("Runtime checks passed"));
    assert.equal(mounted.container.querySelectorAll("input, button, textarea").length, 0);
    assert.equal(mounted.container.querySelectorAll("[data-native-agent-chat-surface]").length, 0);
  } finally { await mounted.dispose(); }
}

export async function runComponentProof(): Promise<void> {
  const cases: ReadonlyArray<readonly [string, () => Promise<void>]> = [
    ["pending selection hides old readiness", pendingSelectionHidesOldReadiness],
    ["delayed old result cannot cross selection", delayedOldResultCannotCrossSelection],
    ["revocation clears readiness", revocationClearsReadiness],
    ["malformed and mismatched responses fail closed", malformedAndMismatchedResponsesFailClosed],
    ["unavailable transport leaves conversation inactive", unavailableTransportLeavesConversationInactive],
  ];
  try {
    for (const [name, run] of cases) {
      process.stdout.write("START " + name + "\n");
      await run();
      process.stdout.write("PASS " + name + "\n");
    }
    assert.equal(activeRoots, 0);
    assert.equal(activeClients, 0);
    assert.equal(nativeProofControl.snapshot().pending, 0);
  } finally { nativeProofControl.releaseAll(); }
}
`;

function appImport(specifier) {
  const base = resolve(APP, specifier.slice(2));
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error(`unresolved app import: ${specifier}`);
  return found;
}

async function worker() {
  assert.equal(`${process.platform}-${process.arch}`, "win32-x64",
    "component proof dependency coordinates require Windows x64");
  const dependencies = loadDependencies();
  const esbuildDependency = dependencies.get("esbuild");
  const nativeDependency = dependencies.get("esbuildNative");
  assert.ok(esbuildDependency && nativeDependency);
  const nativeBinary = dependencyFile(dependencies, "esbuildNative", "esbuild.exe");
  // guard:allow-env-mutation - Isolated fixture worker binds the reviewed esbuild binary.
  process.env.ESBUILD_BINARY_PATH = nativeBinary; // guard:allow-env-credential - Exact reviewed test binary; no credential value.
  const esbuild = esbuildDependency.require("esbuild");
  const priorGlobals = new Map();
  const NativeMessageChannel = globalThis.MessageChannel;
  assert.equal(typeof NativeMessageChannel, "function", "native MessageChannel constructor required");
  const messageChannels = new Set();
  let messageChannelsCreated = 0;
  let messageChannelPortsClosed = 0;
  let messageChannelCleanupError = null;
  class TrackedMessageChannel extends NativeMessageChannel {
    constructor(...args) {
      super(...args);
      messageChannelsCreated += 1;
      messageChannels.add(this);
    }
  }
  let globalsRestored = false;
  let esbuildStopped = false;
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    void esbuild.stop();
  }, 25_000);
  try {
    const aliases = new Map([
      ["react", dependencyEntry(dependencies, "react", "react")],
      ["react/jsx-runtime", dependencyEntry(dependencies, "react", "react/jsx-runtime")],
      ["react-dom", dependencyEntry(dependencies, "reactDom", "react-dom")],
      ["react-dom/client", dependencyEntry(dependencies, "reactDom", "react-dom/client")],
      ["@tanstack/react-query", dependencyEntry(dependencies, "reactQuery", "@tanstack/react-query")],
      ["zod", dependencyEntry(dependencies, "zod", "zod")],
      ["@canonical/ProjectContext", join(APP, "components", "projects", "ProjectContext.tsx")],
      ["@canonical/Conversation", join(APP, "components", "workbench", "Conversation.tsx")],
    ]);
    const result = await esbuild.build({
      stdin: { contents: proofSource, resolveDir: HERE,
        sourcefile: "runtime-readiness-component-proof.tsx", loader: "tsx" },
      absWorkingDir: WORKBENCH,
      bundle: true,
      write: false,
      metafile: true,
      platform: "node",
      format: "esm",
      target: "node22",
      jsx: "automatic",
      tsconfigRaw: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" } },
      define: { "process.env.NODE_ENV": '"development"' },
      plugins: [{
        name: "runtime-readiness-component-proof",
        setup(build) {
          build.onResolve({ filter: /^@proof\/native-hooks$/ }, () => (
            { path: "native-hooks", namespace: "proof" }));
          build.onResolve({ filter: /^@agent-native\/core\/client\/hooks$/ }, () => (
            { path: "native-hooks", namespace: "proof" }));
          build.onResolve({ filter: /^@agent-native\/toolkit\/ui$/ }, () => (
            { path: "toolkit", namespace: "proof" }));
          build.onResolve({ filter: /.*/ }, args => {
            const alias = aliases.get(args.path);
            if (alias) return { path: alias };
            if (args.path.startsWith("@/")) return { path: appImport(args.path) };
            return undefined;
          });
          build.onLoad({ filter: /^native-hooks$/, namespace: "proof" }, () => (
            { contents: nativeHooksSource, loader: "tsx", resolveDir: APP }));
          build.onLoad({ filter: /^toolkit$/, namespace: "proof" }, () => (
            { contents: toolkitSource, loader: "tsx", resolveDir: APP }));
        },
      }],
    });
    assert.equal(result.outputFiles.length, 1);
    for (const source of [
      join(APP, "components", "projects", "ProjectContext.tsx"),
      join(APP, "components", "workbench", "Conversation.tsx"),
      join(APP, "lib", "project-catalog-schema.ts"),
      join(APP, "lib", "runtime-readiness-schema.ts"),
    ]) {
      const normalized = source.replaceAll("\\", "/").toLowerCase();
      assert.ok(Object.keys(result.metafile.inputs).some(input =>
        resolve(WORKBENCH, input).replaceAll("\\", "/").toLowerCase() === normalized),
      `component proof did not bundle ${source}`);
    }

    const linkedom = await import(pathToFileURL(
      dependencyFile(dependencies, "linkedom", "esm", "index.js")).href);
    const view = linkedom.parseHTML("<!doctype html><html><body></body></html>");
    const domValues = new Map([
      ["window", view], ["self", view], ["document", view.document], ["navigator", view.navigator],
      ["HTMLElement", view.HTMLElement], ["Element", view.Element], ["Node", view.Node],
      ["Event", view.Event], ["EventTarget", view.EventTarget], ["MutationObserver", view.MutationObserver],
      ["MessageChannel", TrackedMessageChannel], ["IS_REACT_ACT_ENVIRONMENT", true],
    ]);
    for (const [name, value] of domValues) {
      priorGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`;
    const proof = await import(moduleUrl);
    assert.equal(typeof proof.runComponentProof, "function");
    await proof.runComponentProof();
  } finally {
    clearTimeout(deadline);
    for (const channel of messageChannels) {
      for (const port of [channel.port1, channel.port2]) {
        try {
          port.close();
          messageChannelPortsClosed += 1;
        } catch (error) {
          messageChannelCleanupError ??= error;
        }
      }
    }
    messageChannels.clear();
    for (const [name, descriptor] of priorGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    globalsRestored = true;
    await esbuild.stop();
    esbuildStopped = true;
  }
  assert.equal(timedOut, false, "component worker exceeded its internal deadline");
  assert.equal(messageChannelCleanupError, null);
  assert.ok(messageChannelsCreated > 0, "React proof did not exercise MessageChannel scheduling");
  assert.equal(messageChannelPortsClosed, messageChannelsCreated * 2);
  assert.equal(messageChannels.size, 0);
  assert.equal(esbuildStopped, true);
  assert.equal(globalsRestored, true);
  process.stdout.write(`MESSAGE_CHANNEL_CLEANUP channels=${messageChannelsCreated} `
    + `portsClosed=${messageChannelPortsClosed}\n`);
  process.stdout.write("PASS runtime readiness component cleanup "
    + "nodeWorkers=1 esbuildServices=1 esbuildStopped=true globalsRestored=true\n");
}

if (process.env.VIVARY_RUNTIME_READINESS_COMPONENT_WORKER === "1") { // guard:allow-env-credential - Test child mode flag; no credential value.
  try { await worker(); }
  catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
} else {
  test("Conversation consumes only matching current readiness through real React Query", () => {
    const dependencyManifest = process.env[DEPENDENCY_MANIFEST_ENV]; // guard:allow-env-credential - Reviewed test manifest path; no credential value.
    assert.ok(dependencyManifest && isAbsolute(dependencyManifest),
      "explicit absolute component dependency manifest required");
    const retained = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP",
      "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"];
    const env = Object.fromEntries(retained.filter(key => process.env[key]) // guard:allow-env-credential - Child gets only fixed OS launch paths.
      .map(key => [key, process.env[key]])); // guard:allow-env-credential - Child gets only fixed OS launch paths.
    Object.assign(env, { VIVARY_RUNTIME_READINESS_COMPONENT_WORKER: "1",
      [DEPENDENCY_MANIFEST_ENV]: dependencyManifest, NODE_ENV: "test" });
    const result = spawnSync(process.execPath, ["--max-old-space-size=256", TEST_FILE], {
      cwd: WORKBENCH, env, windowsHide: true, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    assert.equal(result.error, undefined, `${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}\n`
      + "A forced timeout leaves the Node worker and esbuild service cleanup unconfirmed; retain both in external process accounting.");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assertWorkerEvidence(result.stdout, 5);
  });
}
