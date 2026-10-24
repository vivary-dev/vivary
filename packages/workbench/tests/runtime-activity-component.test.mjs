import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKBENCH = resolve(HERE, "..");
const APP = join(WORKBENCH, "app");
const TEST_FILE = fileURLToPath(import.meta.url);
const DEPENDENCY_MANIFEST_ENV = "VIVARY_TEST_COMPONENT_DEPENDENCY_MANIFEST";
const CORE_MANIFEST_ENV = "VIVARY_TEST_CORE_PACKAGE_JSON";
const TARGET_CASE_ENV = "VIVARY_RUNTIME_ACTIVITY_COMPONENT_TARGET_CASE";
const REMOUNT_CASE = "replaced reference remounts the Native renderer";
const FAILED_WRITE_CASE = "failed write keeps requested project and retries";
const INVALID_TARGET_CASE = "invalid and revoked targets stay fail closed";
const TARGET_CASES = new Set([REMOUNT_CASE, FAILED_WRITE_CASE, INVALID_TARGET_CASE]);
const MAX_BUNDLE_INPUTS = 16_384;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const esbuildPlatforms = Object.freeze({
  "linux-x64": Object.freeze({
    packageName: "@esbuild/linux-x64", binarySegments: Object.freeze(["bin", "esbuild"]),
  }),
  "win32-x64": Object.freeze({
    packageName: "@esbuild/win32-x64", binarySegments: Object.freeze(["esbuild.exe"]),
  }),
});
const platformKey = `${process.platform}-${process.arch}`;
const esbuildPlatform = esbuildPlatforms[platformKey];
assert.ok(esbuildPlatform, `unsupported esbuild test platform: ${platformKey}`);
const expectedDependencies = Object.freeze({
  esbuild: Object.freeze({ name: "esbuild", version: "0.28.2" }),
  esbuildNative: Object.freeze({ name: esbuildPlatform.packageName, version: "0.28.2" }),
  linkedom: Object.freeze({ name: "linkedom", version: "0.18.12" }),
  react: Object.freeze({ name: "react", version: "19.2.8" }),
  reactDom: Object.freeze({ name: "react-dom", version: "19.2.8" }),
  reactQuery: Object.freeze({ name: "@tanstack/react-query", version: "5.102.8" }),
  zod: Object.freeze({ name: "zod", version: "4.6.7" }),
});

function loadDependencies() {
  const configured = process.env[DEPENDENCY_MANIFEST_ENV]; // guard:allow-env-credential - Reviewed dependency manifest path.
  assert.ok(configured && isAbsolute(configured), "explicit absolute component dependency manifest required");
  const manifestPath = realpathSync(configured);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.ok(typeof manifest === "object" && manifest !== null && !Array.isArray(manifest));
  assert.deepEqual(Object.keys(manifest).sort(), ["packages", "schemaVersion"]);
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(typeof manifest.packages === "object" && manifest.packages !== null && !Array.isArray(manifest.packages));
  assert.deepEqual(Object.keys(manifest.packages).sort(), Object.keys(expectedDependencies).sort());
  const dependencies = new Map();
  for (const [key, expected] of Object.entries(expectedDependencies)) {
    const packageJsonInput = manifest.packages[key];
    assert.ok(typeof packageJsonInput === "string" && isAbsolute(packageJsonInput));
    const packageJson = realpathSync(packageJsonInput);
    const actual = JSON.parse(readFileSync(packageJson, "utf8"));
    assert.deepEqual({ name: actual.name, version: actual.version }, expected);
    dependencies.set(key, Object.freeze({ packageJson, root: dirname(packageJson),
      require: createRequire(packageJson) }));
  }
  const coreInput = process.env[CORE_MANIFEST_ENV]; // guard:allow-env-credential - Reviewed Core package manifest path.
  assert.ok(coreInput && isAbsolute(coreInput), "explicit absolute Core package manifest required");
  const corePackageJson = realpathSync(coreInput);
  const coreManifest = JSON.parse(readFileSync(corePackageJson, "utf8"));
  assert.deepEqual({ name: coreManifest.name, version: coreManifest.version },
    { name: "@agent-native/core", version: "0.176.5" });
  dependencies.set("core", Object.freeze({ packageJson: corePackageJson,
    root: dirname(corePackageJson), require: createRequire(corePackageJson) }));
  return dependencies;
}

function dependencyEntry(dependencies, key, specifier) {
  const dependency = dependencies.get(key);
  assert.ok(dependency, `missing reviewed dependency ${key}`);
  const entry = realpathSync(dependency.require.resolve(specifier));
  const fromRoot = relative(dependency.root, entry);
  assert.ok(fromRoot.length > 0 && !fromRoot.startsWith("..") && !isAbsolute(fromRoot));
  return entry;
}

function dependencyFile(dependencies, key, ...segments) {
  const dependency = dependencies.get(key);
  assert.ok(dependency, `missing reviewed dependency ${key}`);
  const entry = realpathSync(join(dependency.root, ...segments));
  const fromRoot = relative(dependency.root, entry);
  assert.ok(fromRoot.length > 0 && !fromRoot.startsWith("..") && !isAbsolute(fromRoot));
  return entry;
}

function assertWorkerEvidence(stdout, expectedCases) {
  const lines = stdout.split(/\r?\n/);
  const starts = lines.filter(line => line.startsWith("START ")).map(line => line.slice(6));
  const passes = lines.filter(line => line.startsWith("PASS ")
    && !line.startsWith("PASS runtime activity component cleanup ")).map(line => line.slice(5));
  assert.equal(starts.length, expectedCases);
  assert.deepEqual(passes, starts);
  assert.equal(lines.filter(line => line === "PASS runtime activity component cleanup "
    + "nodeWorkers=1 esbuildServices=1 esbuildStopped=true globalsRestored=true").length, 1);
  assert.equal(lines.filter(line => line ===
    "TEMP_MODULE_CLEANUP fileRemoved=true directoryRemoved=true").length, 1);
  const directoryEvidence = lines.filter(line => line.startsWith("TEMP_MODULE_DIRECTORY "));
  assert.equal(directoryEvidence.length, 1);
  const bundleDirectory = JSON.parse(directoryEvidence[0].slice("TEMP_MODULE_DIRECTORY ".length));
  assert.ok(typeof bundleDirectory === "string" && isAbsolute(bundleDirectory));
  assert.equal(dirname(bundleDirectory), realpathSync(tmpdir()));
  assert.ok(basename(bundleDirectory).startsWith("vivary-04b-component-"));
  const channelEvidence = lines.filter(line => line.startsWith("MESSAGE_CHANNEL_CLEANUP "));
  assert.equal(channelEvidence.length, 1);
  const match = /^MESSAGE_CHANNEL_CLEANUP channels=(\d+) portsClosed=(\d+)$/.exec(channelEvidence[0]);
  assert.ok(match && Number(match[1]) > 0);
  assert.equal(Number(match[2]), Number(match[1]) * 2);
  const bundleLines = lines.filter(line => line.startsWith("BUNDLE_INPUTS "));
  assert.equal(bundleLines.length, 1);
  const encoded = bundleLines[0].slice("BUNDLE_INPUTS ".length);
  assert.ok(Buffer.byteLength(encoded, "utf8") <= MAX_CAPTURE_BYTES);
  const evidence = JSON.parse(encoded);
  assert.equal(evidence.schemaVersion, 1);
  assert.ok(Array.isArray(evidence.files) && evidence.files.length > 0
    && evidence.files.length <= MAX_BUNDLE_INPUTS);
  assert.match(evidence.output.sha256, /^[0-9a-f]{64}$/);
}

function assertWorkerFailureEvidence(stdout, stderr) {
  const lines = stdout.split(/\r?\n/);
  const starts = lines.filter(line => line.startsWith("START ")).map(line => line.slice(6));
  const passes = lines.filter(line => line.startsWith("PASS ")
    && !line.startsWith("PASS runtime activity component cleanup ")).map(line => line.slice(5));
  assert.deepEqual(starts, [REMOUNT_CASE]);
  assert.deepEqual(passes, []);
  assert.equal(lines.filter(line => line === "PASS runtime activity component cleanup "
    + "nodeWorkers=1 esbuildServices=1 esbuildStopped=true globalsRestored=true").length, 1);
  assert.equal(lines.filter(line => line ===
    "TEMP_MODULE_CLEANUP fileRemoved=true directoryRemoved=true").length, 1);
  const channelEvidence = lines.filter(line => line.startsWith("MESSAGE_CHANNEL_CLEANUP "));
  assert.equal(channelEvidence.length, 1);
  const channelMatch = /^MESSAGE_CHANNEL_CLEANUP channels=(\d+) portsClosed=(\d+)$/.exec(channelEvidence[0]);
  assert.ok(channelMatch && Number(channelMatch[1]) > 0);
  assert.equal(Number(channelMatch[2]), Number(channelMatch[1]) * 2);
  const bundleLines = lines.filter(line => line.startsWith("BUNDLE_INPUTS "));
  assert.equal(bundleLines.length, 1);
  const encoded = bundleLines[0].slice("BUNDLE_INPUTS ".length);
  assert.ok(Buffer.byteLength(encoded, "utf8") <= MAX_CAPTURE_BYTES);
  const evidence = JSON.parse(encoded);
  assert.equal(evidence.schemaVersion, 1);
  assert.ok(Array.isArray(evidence.files) && evidence.files.length > 0
    && evidence.files.length <= MAX_BUNDLE_INPUTS);
  assert.match(evidence.output.sha256, /^[0-9a-f]{64}$/);
  assert.equal(lines.filter(line => line.startsWith("FAIL ")).length, 1);
  assert.equal(lines.filter(line => line === "FAIL replaced reference remount "
    + 'code=ERR_ASSERTION message="replaced reference remount"').length, 1);
  assert.match(stderr, /AssertionError \[ERR_ASSERTION\]: replaced reference remount/);
}

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function outerNodeModulesRoot(packageJsonInput) {
  let current = dirname(packageJsonInput);
  let found = null;
  while (true) {
    if (basename(current).toLowerCase() === "node_modules") found = current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  assert.ok(found, "Core package path must descend from an installed node_modules root");
  return realpathSync(found);
}

function inside(root, candidate) {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function captureBundleInputs(result, corePackageJsonInput) {
  const roots = Object.freeze({ workbench: realpathSync(WORKBENCH),
    installedNodeModules: outerNodeModulesRoot(corePackageJsonInput) });
  const files = [];
  for (const input of Object.keys(result.metafile.inputs)) {
    const candidate = isAbsolute(input) ? input : resolve(WORKBENCH, input);
    if (!existsSync(candidate)) {
      assert.match(input, /^(proof:|tests\/runtime-activity-component-proof\.tsx$)/,
        `unexpected non-physical bundle input: ${input}`);
      continue;
    }
    const real = realpathSync(candidate);
    const root = inside(roots.workbench, real) ? "workbench"
      : inside(roots.installedNodeModules, real) ? "installedNodeModules" : null;
    assert.ok(root, `bundle input escaped reviewed roots: ${real}`);
    const bytes = readFileSync(real);
    files.push(Object.freeze({ root, path: relative(roots[root], real).replaceAll("\\", "/"),
      byteCount: bytes.length, sha256: sha256(bytes) }));
  }
  files.sort((left, right) => `${left.root}/${left.path}`.localeCompare(`${right.root}/${right.path}`));
  assert.ok(files.length > 0 && files.length <= MAX_BUNDLE_INPUTS,
    `bundle input count must be within 1..${MAX_BUNDLE_INPUTS}`);
  const outputBytes = result.outputFiles[0].contents;
  const evidence = Object.freeze({ schemaVersion: 1, roots, files: Object.freeze(files),
    output: Object.freeze({ byteCount: outputBytes.length, sha256: sha256(outputBytes) }) });
  const encoded = JSON.stringify(evidence);
  assert.ok(Buffer.byteLength(encoded, "utf8") <= MAX_CAPTURE_BYTES,
    `bundle evidence exceeds ${MAX_CAPTURE_BYTES} bytes`);
  return Object.freeze({ evidence, encoded });
}

function recaptureFiles(evidence) {
  return evidence.files.map(file => {
    const real = realpathSync(join(evidence.roots[file.root], ...file.path.split("/")));
    assert.ok(inside(evidence.roots[file.root], real));
    const bytes = readFileSync(real);
    return { root: file.root, path: file.path, byteCount: bytes.length, sha256: sha256(bytes) };
  });
}

const nativeHooksSource = String.raw`
import { useQuery } from "@tanstack/react-query";
import { catalogSchema, selectionSchema, type CatalogResult, type ProjectSelection } from "@/lib/project-catalog-schema";

type Gate = { promise: Promise<void>; release: () => void };
type ActionOptions = { enabled?: boolean; retry?: boolean; refetchInterval?: number;
  refetchOnWindowFocus?: boolean | "always" };
function gate(): Gate {
  let resolvePromise = () => {};
  let released = false;
  const promise = new Promise<void>(resolve => { resolvePromise = resolve; });
  return { promise, release: () => { if (!released) { released = true; resolvePromise(); } } };
}

let catalog: CatalogResult = { code: "unavailable" };
let selection: ProjectSelection | null = null;
let readiness = new Map<string, unknown>();
let activity = new Map<string, unknown>();
let activityUnavailable = false;
let selectionWriteFailures = 0;
let selectionWriteGate: Gate | null = null;
let activityGates = new Map<string, Gate>();
type Metrics = { catalogReads: number; readinessReads: string[]; activityReads: string[];
  activityInputs: Array<Record<string, unknown>>; selectionWrites: Array<string | null> };
let metrics: Metrics = { catalogReads: 0, readinessReads: [], activityReads: [], activityInputs: [],
  selectionWrites: [] };

function releaseAll(): void {
  for (const held of activityGates.values()) held.release();
  activityGates.clear();
  selectionWriteGate?.release();
  selectionWriteGate = null;
}

export const nativeProofControl = {
  configure(value: { catalog: unknown; selection: unknown; readiness: Record<string, unknown>;
    activity: Record<string, unknown> }): void {
    releaseAll();
    catalog = catalogSchema.parse(value.catalog);
    selection = value.selection === null ? null : selectionSchema.parse(value.selection);
    readiness = new Map(Object.entries(value.readiness));
    activity = new Map(Object.entries(value.activity));
    activityUnavailable = false;
    selectionWriteFailures = 0;
    selectionWriteGate = null;
    metrics = { catalogReads: 0, readinessReads: [], activityReads: [], activityInputs: [], selectionWrites: [] };
  },
  setCatalog(value: unknown): void { catalog = catalogSchema.parse(value); },
  setActivity(projectId: string, value: unknown): void { activity.set(projectId, value); },
  setActivityUnavailable(value: boolean): void { activityUnavailable = value; },
  failNextSelectionWrite(): void { selectionWriteFailures += 1; },
  holdNextSelectionWrite(): () => void {
    if (selectionWriteGate) throw new Error("selection write already held");
    selectionWriteGate = gate();
    return selectionWriteGate.release;
  },
  holdActivity(projectId: string): () => void {
    if (activityGates.has(projectId)) throw new Error("activity read already held");
    const held = gate();
    activityGates.set(projectId, held);
    return held.release;
  },
  releaseAll,
  snapshot() {
    return { metrics: structuredClone(metrics), pending: activityGates.size + (selectionWriteGate ? 1 : 0),
      selection: structuredClone(selection) };
  },
};

async function readAction(action: string, input: Record<string, unknown>): Promise<unknown> {
  if (action === "vivary-project-catalog") {
    metrics.catalogReads += 1;
    return structuredClone(catalog);
  }
  const projectId = typeof input.projectId === "string" ? input.projectId : "invalid";
  if (action === "vivary-project-runtime-readiness") {
    metrics.readinessReads.push(projectId);
    return structuredClone(readiness.get(projectId));
  }
  if (action !== "vivary-project-runtime-activity") throw new Error("unexpected Native action: " + action);
  metrics.activityReads.push(projectId);
  metrics.activityInputs.push(structuredClone(input));
  const captured = structuredClone(activity.get(projectId));
  const held = activityGates.get(projectId);
  if (held) await held.promise;
  if (activityGates.get(projectId) === held) activityGates.delete(projectId);
  if (activityUnavailable) throw new Error("synthetic unavailable activity transport");
  return captured;
}

export function useActionQuery<T>(action: string, input: Record<string, unknown>, options: ActionOptions = {}) {
  return useQuery<T>({ ...options, queryKey: ["proof-action", action, input],
    queryFn: async () => await readAction(action, input) as T });
}

export async function readClientAppState(_key: string, _options: { signal?: AbortSignal } = {}) {
  return structuredClone(selection);
}

export function useAppStateWriter() { return { ready: true, retrySession() {}, sessionStatus: "authenticated", writeAppState: writeClientAppState }; }

export async function writeClientAppState(_key: string, value: unknown): Promise<void> {
  const parsed = value === null ? null : selectionSchema.parse(value);
  metrics.selectionWrites.push(parsed?.projectId ?? null);
  const held = selectionWriteGate;
  if (held) await held.promise;
  if (selectionWriteGate === held) selectionWriteGate = null;
  if (selectionWriteFailures > 0) {
    selectionWriteFailures -= 1;
    throw new Error("synthetic selection write failure");
  }
  selection = parsed;
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

const SCOPE = "scope-runtime-activity";
const PROJECT_A = "project-a";
const PROJECT_B = "project-b";
const NATIVE_SCOPE_A = "a".repeat(64);
const NATIVE_SCOPE_B = "b".repeat(64);
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

function observations() {
  return { installed: { state: "available", evidence: ["package-inventory"] },
    configured: { state: "available", evidence: ["trusted-configuration"] },
    authenticated: { state: "available", evidence: ["runtime-authentication"] },
    bound: { state: "available", evidence: ["current-binding", "root-observation"] },
    runnable: { state: "available", evidence: ["runtime-execution"] },
    verified: { state: "available", evidence: ["verification-receipt"] } };
}

function ready(projectId: string, bindingRevision: number) {
  return { code: "readiness", projectId, scopeKey: SCOPE, bindingRevision, policyRevision: 7,
    observations: observations(), blockers: [] };
}

function activity(projectId: string, bindingRevision: number, label: string, scopeKey = SCOPE) {
  const runId = "run-" + projectId;
  return { code: "activity", projectId, scopeKey, bindingRevision, policyRevision: 7,
    referenceRevision: 2, nativeThreadId: "thread-" + projectId,
    nativeScope: { type: "vivary-project-runtime-v1",
      id: projectId === PROJECT_A ? NATIVE_SCOPE_A : NATIVE_SCOPE_B },
    nativeRunId: runId, items: [
      { id: runId + ":1", runId, kind: "note", message: label + " text", createdAt: "2026-09-07T12:00:00.000Z" },
      { id: runId + ":2", runId, kind: "status", message: "Running read_file",
        createdAt: "2026-09-07T12:00:01.000Z",
        metadata: { type: "tool_start", tool: "read_file", input: { path: "safe.txt" } } },
      { id: runId + ":3", runId, kind: "artifact", message: label + " tool result",
        createdAt: "2026-09-07T12:00:02.000Z",
        metadata: { type: "tool_done", tool: "read_file", input: { path: "safe.txt" },
          result: label + " tool result" } },
    ] };
}

function configure(activityValues: Record<string, unknown>) {
  nativeProofControl.configure({ catalog: catalog(), selection: { scopeKey: SCOPE, projectId: PROJECT_A },
    readiness: { [PROJECT_A]: ready(PROJECT_A, 4), [PROJECT_B]: ready(PROJECT_B, 5) },
    activity: activityValues });
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
  await act(async () => { await Promise.resolve(); await new Promise<void>(resolve => setTimeout(resolve, 0)); });
}
async function waitFor(check: () => boolean, message: string): Promise<void> {
  const expires = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= expires) throw new Error("timed out: " + message);
    await flush();
  }
}

async function waitForReplacedReferenceRemount(
  container: HTMLElement,
  originalMessage: Element,
): Promise<void> {
  const expires = Date.now() + 2_000;
  while (container.querySelector(".agent-conversation-message") === originalMessage
    && Date.now() < expires) {
    await flush();
  }
  const replacementMessage = container.querySelector(".agent-conversation-message");
  assert.ok(replacementMessage, "replacement Native message remains rendered");
  assert.notEqual(replacementMessage, originalMessage, "replaced reference remount");
}

type Mounted = { container: HTMLElement; queryClient: QueryClient; root: Root; dispose: () => Promise<void> };
async function mount(fullPage = false): Promise<Mounted> {
  observedState = null;
  const container = document.createElement("div");
  document.body.append(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const root = createRoot(container);
  activeRoots += 1;
  activeClients += 1;
  try {
    await act(async () => { root.render(<QueryClientProvider client={queryClient}><ProjectProvider>
      <Capture><Conversation fullPage={fullPage} /></Capture></ProjectProvider></QueryClientProvider>); });
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

async function selectProject(projectId: string | null): Promise<boolean> {
  let operation = Promise.resolve(false);
  act(() => { operation = currentState().selectProject(projectId); });
  let selected = false;
  await act(async () => { selected = await operation; });
  return selected;
}

function assertNoRunControls(container: HTMLElement): void {
  assert.equal(container.querySelectorAll("input, textarea").length, 0);
  const labels = [...container.querySelectorAll("button")]
    .map(button => (button.getAttribute("aria-label") ?? button.textContent ?? "").toLowerCase());
  for (const forbidden of ["send", "stop", "approve", "deny", "resume", "follow up"]) {
    assert.ok(labels.every(label => !label.includes(forbidden)), forbidden);
  }
  assert.equal(container.querySelectorAll("[data-native-agent-chat-surface]").length, 0);
}

async function rendersNativeTextAndToolWithoutComposer(): Promise<void> {
  for (const [fullPage, mode] of [[false, "panel"], [true, "page"]] as const) {
    configure({ [PROJECT_A]: activity(PROJECT_A, 4, "alpha") });
    const mounted = await mount(fullPage);
    try {
      await waitFor(() => (mounted.container.textContent ?? "").includes("alpha text"), "Native text");
      assert.match(mounted.container.textContent ?? "", /read file/i);
      assert.equal(mounted.container.querySelectorAll(".agent-conversation-message--user").length, 0);
      const surface = mounted.container.querySelector("[aria-label='Run activity']");
      assert.equal(surface?.querySelector("h2")?.textContent, "Run activity");
      assert.equal(surface?.getAttribute("data-conversation-mode"), mode);
      assert.deepEqual(nativeProofControl.snapshot().metrics.activityInputs[0], {
        projectId: PROJECT_A, expectedBindingRevision: "4",
        expectedPolicyRevision: "7", scopeKey: SCOPE,
      });
      assertNoRunControls(mounted.container);
    } finally { await mounted.dispose(); }
  }
}

async function selectionChangeHidesOldActivity(): Promise<void> {
  const emptyB = activity(PROJECT_B, 5, "beta");
  emptyB.items = [];
  configure({ [PROJECT_A]: activity(PROJECT_A, 4, "alpha"), [PROJECT_B]: emptyB });
  const mounted = await mount();
  try {
    await waitFor(() => (mounted.container.textContent ?? "").includes("alpha text"), "alpha activity");
    const releaseB = nativeProofControl.holdActivity(PROJECT_B);
    assert.equal(await selectProject(PROJECT_B), true);
    await waitFor(() => nativeProofControl.snapshot().metrics.activityReads.includes(PROJECT_B), "beta read");
    assert.equal(mounted.container.querySelectorAll("[data-proof-skeleton]").length, 2);
    assert.ok(!(mounted.container.textContent ?? "").includes("alpha text"));
    releaseB();
    await waitFor(() => (mounted.container.textContent ?? "").includes("Run activity unavailable"),
      "empty beta activity");
    assert.ok(!(mounted.container.textContent ?? "").includes("alpha text"));
  } finally { await mounted.dispose(); }
}

async function lateOldResultCannotCrossSelection(): Promise<void> {
  const emptyB = activity(PROJECT_B, 5, "beta");
  emptyB.items = [];
  configure({ [PROJECT_A]: activity(PROJECT_A, 4, "alpha"), [PROJECT_B]: emptyB });
  const releaseA = nativeProofControl.holdActivity(PROJECT_A);
  const mounted = await mount();
  try {
    await waitFor(() => nativeProofControl.snapshot().metrics.activityReads.includes(PROJECT_A), "held alpha read");
    assert.equal(await selectProject(PROJECT_B), true);
    await waitFor(() => (mounted.container.textContent ?? "").includes("Run activity unavailable"),
      "empty beta activity");
    releaseA();
    await flush();
    await flush();
    assert.ok(!(mounted.container.textContent ?? "").includes("alpha text"));
    assert.equal(mounted.container.querySelector(".conversation-unavailable-shell")
      ?.getAttribute("data-project-scope"), PROJECT_B);
  } finally { await mounted.dispose(); }
}

async function failedWriteKeepsRequestedProjectAndRetries(): Promise<void> {
  configure({
    [PROJECT_A]: activity(PROJECT_A, 4, "alpha"),
    [PROJECT_B]: activity(PROJECT_B, 5, "beta"),
  });
  nativeProofControl.failNextSelectionWrite();
  const releaseFailedWrite = nativeProofControl.holdNextSelectionWrite();
  const mounted = await mount();
  try {
    await waitFor(() => (mounted.container.textContent ?? "").includes("alpha text"), "alpha activity");
    let selectionOperation = Promise.resolve(true);
    act(() => { selectionOperation = currentState().selectProject(PROJECT_B); });
    await waitFor(() => nativeProofControl.snapshot().metrics.selectionWrites.length === 1, "pending write");
    await act(async () => { await mounted.queryClient.refetchQueries({
      queryKey: ["vivary-project-selection-v1", SCOPE], exact: true,
    }); });
    assert.equal(currentState().activeProject?.projectId, PROJECT_B);
    releaseFailedWrite();
    let selected = true;
    await act(async () => { selected = await selectionOperation; });
    assert.equal(selected, false);
    await waitFor(() => currentState().activeProject?.projectId === PROJECT_B, "requested project retained");
    await waitFor(() => (mounted.container.textContent ?? "").includes("beta text"), "beta activity");
    assert.equal(currentState().error, "Project selection could not be saved.");
    assert.deepEqual(nativeProofControl.snapshot().selection, { scopeKey: SCOPE, projectId: PROJECT_A });
    assert.deepEqual(nativeProofControl.snapshot().metrics.selectionWrites, [PROJECT_B]);

    await act(async () => { await mounted.queryClient.refetchQueries({
      queryKey: ["vivary-project-selection-v1", SCOPE], exact: true,
    }); });
    assert.equal(currentState().activeProject?.projectId, PROJECT_B);
    assert.equal(currentState().error, "Project selection could not be saved.");

    const catalogReadsBeforeRetry = nativeProofControl.snapshot().metrics.catalogReads;
    const retry = currentState().retrySelection;
    assert.ok(retry, "failed selection exposes a retry");
    const releaseWrite = nativeProofControl.holdNextSelectionWrite();
    let retryOperation = Promise.resolve(false);
    act(() => { retryOperation = retry(); });
    await waitFor(() => nativeProofControl.snapshot().metrics.selectionWrites.length === 2, "retry write");
    await act(async () => { await mounted.queryClient.refetchQueries({
      queryKey: ["vivary-project-selection-v1", SCOPE], exact: true,
    }); });
    assert.equal(currentState().activeProject?.projectId, PROJECT_B);
    releaseWrite();
    let retried = false;
    await act(async () => { retried = await retryOperation; });
    assert.equal(retried, true);
    assert.equal(nativeProofControl.snapshot().metrics.catalogReads, catalogReadsBeforeRetry + 1);
    assert.equal(currentState().activeProject?.projectId, PROJECT_B);
    assert.equal(currentState().error, null);
    assert.equal(currentState().retrySelection, null);
    assert.deepEqual(nativeProofControl.snapshot().selection, { scopeKey: SCOPE, projectId: PROJECT_B });
    assert.deepEqual(nativeProofControl.snapshot().metrics.selectionWrites, [PROJECT_B, PROJECT_B]);
  } finally { await mounted.dispose(); }
}

async function invalidAndRevokedTargetsStayFailClosed(): Promise<void> {
  configure({
    [PROJECT_A]: activity(PROJECT_A, 4, "alpha"),
    [PROJECT_B]: activity(PROJECT_B, 5, "beta"),
  });
  nativeProofControl.failNextSelectionWrite();
  let mounted = await mount();
  try {
    await waitFor(() => (mounted.container.textContent ?? "").includes("alpha text"), "alpha activity");
    assert.equal(await selectProject(null), false);
    assert.equal(currentState().activeProject, null);
    assert.equal(currentState().workspaceAvailable, true);
    assert.deepEqual(nativeProofControl.snapshot().selection, { scopeKey: SCOPE, projectId: PROJECT_A });
    assert.deepEqual(nativeProofControl.snapshot().metrics.selectionWrites, [null]);
    const retry = currentState().retrySelection;
    assert.ok(retry);
    let retried = false;
    await act(async () => { retried = await retry(); });
    assert.equal(retried, true);
    assert.equal(currentState().workspaceAvailable, true);
    assert.equal(currentState().retrySelection, null);
    assert.deepEqual(nativeProofControl.snapshot().selection, { scopeKey: SCOPE, projectId: null });
    assert.deepEqual(nativeProofControl.snapshot().metrics.selectionWrites, [null, null]);

    await mounted.dispose();
    mounted = await mount();
    await waitFor(() => currentState().workspaceAvailable, "Personal selection reload");
    assert.equal(currentState().activeProject, null);
    assert.equal(currentState().error, null);
  } finally { await mounted.dispose(); }

  configure({
    [PROJECT_A]: activity(PROJECT_A, 4, "alpha"),
    [PROJECT_B]: activity(PROJECT_B, 5, "beta"),
  });
  mounted = await mount();
  try {
    await waitFor(() => (mounted.container.textContent ?? "").includes("alpha text"), "alpha activity");
    assert.equal(await selectProject("project-missing"), false);
    assert.equal(currentState().activeProject, null);
    assert.equal(currentState().workspaceAvailable, false);
    assert.equal(currentState().retrySelection, null);
    assert.equal(currentState().error, "This project is no longer available. Refresh the project list.");
    assert.deepEqual(nativeProofControl.snapshot().selection, { scopeKey: SCOPE, projectId: PROJECT_A });
    assert.deepEqual(nativeProofControl.snapshot().metrics.selectionWrites, []);
  } finally { await mounted.dispose(); }

  for (const changedCatalog of [
    { ...catalog(), projects: catalog().projects.map(project =>
      project.projectId === PROJECT_B ? { ...project, status: "unavailable" as const } : project) },
    { ...catalog(), scopeKey: "scope-replaced" },
  ]) {
    configure({
      [PROJECT_A]: activity(PROJECT_A, 4, "alpha"),
      [PROJECT_B]: activity(PROJECT_B, 5, "beta"),
    });
    nativeProofControl.failNextSelectionWrite();
    mounted = await mount();
    try {
      await waitFor(() => (mounted.container.textContent ?? "").includes("alpha text"), "alpha activity");
      assert.equal(await selectProject(PROJECT_B), false);
      assert.equal(currentState().activeProject?.projectId, PROJECT_B);
      nativeProofControl.setCatalog(changedCatalog);
      const retry = currentState().retrySelection;
      assert.ok(retry);
      let retried = true;
      await act(async () => { retried = await retry(); });
      assert.equal(retried, false);
      assert.equal(currentState().workspaceAvailable, false);
      assert.equal(currentState().retrySelection, null);
      assert.equal(currentState().error, "This project is no longer available. Refresh the project list.");
      assert.deepEqual(nativeProofControl.snapshot().selection, { scopeKey: SCOPE, projectId: PROJECT_A });
      assert.deepEqual(nativeProofControl.snapshot().metrics.selectionWrites, [PROJECT_B]);
      if (changedCatalog.scopeKey === SCOPE) {
        assert.equal(currentState().activeProject?.projectId, PROJECT_B);
        assert.equal(currentState().activeProject?.status, "unavailable");
      } else {
        assert.equal(currentState().activeProject, null);
      }
    } finally { await mounted.dispose(); }
  }
}

async function replacedReferenceRemountsRenderer(): Promise<void> {
  const first = activity(PROJECT_A, 4, "alpha");
  configure({ [PROJECT_A]: first });
  const mounted = await mount();
  try {
    await waitFor(() => (mounted.container.textContent ?? "").includes("alpha text"), "first reference");
    const originalMessage = mounted.container.querySelector(".agent-conversation-message");
    assert.ok(originalMessage);
    const replacedRunId = "run-project-a-replaced";
    const replacement = { ...first, referenceRevision: 3,
      nativeThreadId: "thread-project-a-replaced",
      nativeScope: { type: "vivary-project-runtime-v1", id: "c".repeat(64) },
      nativeRunId: replacedRunId,
      items: first.items.map(item => ({ ...item, runId: replacedRunId })) };
    const activityKey = ["proof-action", "vivary-project-runtime-activity", {
      projectId: PROJECT_A, expectedBindingRevision: "4",
      expectedPolicyRevision: "7", scopeKey: SCOPE,
    }];
    await act(async () => { mounted.queryClient.setQueryData(activityKey, replacement); });
    assert.equal(mounted.container.querySelectorAll("[data-proof-skeleton]").length, 0);
    await waitForReplacedReferenceRemount(mounted.container, originalMessage);
    assert.ok((mounted.container.textContent ?? "").includes("alpha text"));
    assertNoRunControls(mounted.container);
  } finally { await mounted.dispose(); }
}

async function revocationClearsActivity(): Promise<void> {
  configure({ [PROJECT_A]: activity(PROJECT_A, 4, "alpha") });
  const mounted = await mount();
  try {
    await waitFor(() => (mounted.container.textContent ?? "").includes("alpha text"), "alpha activity");
    nativeProofControl.setCatalog({ code: "denied" });
    await act(async () => { await currentState().refresh(); });
    await waitFor(() => (mounted.container.textContent ?? "").includes("Choose a project"), "revoked project");
    assert.ok(!(mounted.container.textContent ?? "").includes("alpha text"));
  } finally { await mounted.dispose(); }
}

async function malformedMismatchAndOversizeFailClosed(): Promise<void> {
  const oversizedItem = activity(PROJECT_A, 4, "oversized item");
  oversizedItem.items = [{ id: "oversized-item", runId: oversizedItem.nativeRunId, kind: "note",
    message: "i".repeat(8 * 1024), createdAt: "2026-09-07T12:00:00.000Z" }];
  const tooManyItems = activity(PROJECT_A, 4, "too many items");
  tooManyItems.items = Array.from({ length: 129 }, (_, index) => ({ id: "count-" + index,
    runId: tooManyItems.nativeRunId, kind: "note", message: "bounded",
    createdAt: "2026-09-07T12:00:00.000Z" }));
  const oversizedResponse = activity(PROJECT_A, 4, "oversized response");
  oversizedResponse.items = Array.from({ length: 40 }, (_, index) => ({ id: "response-" + index,
    runId: oversizedResponse.nativeRunId, kind: "note", message: "r".repeat(7_000),
    createdAt: "2026-09-07T12:00:00.000Z" }));
  const valid = activity(PROJECT_A, 4, "valid");
  for (const response of [{ nope: true }, activity(PROJECT_A, 4, "old", "old-scope"), oversizedItem,
    tooManyItems, oversizedResponse, { ...valid, nativeThreadId: undefined },
    { ...valid, nativeScope: undefined },
    { ...valid, nativeScope: { ...valid.nativeScope, type: "other" } },
    { ...valid, nativeScope: { ...valid.nativeScope, id: "A".repeat(64) } },
    { ...valid, nativeScope: { ...valid.nativeScope, extra: true } },
    { ...valid, extra: true }, { code: "activity-too-large" }, { code: "unavailable" }]) {
    configure({ [PROJECT_A]: response });
    const mounted = await mount();
    try {
      await waitFor(() => (mounted.container.textContent ?? "").includes("Run activity"), "activity state");
      await flush();
      const text = mounted.container.textContent ?? "";
      assert.ok(!text.includes("old text"));
      assert.match(text, /unavailable|too large|could not be verified/i);
      assertNoRunControls(mounted.container);
    } finally { await mounted.dispose(); }
  }
}

async function unavailableTransportUsesRendererErrorState(): Promise<void> {
  configure({ [PROJECT_A]: activity(PROJECT_A, 4, "alpha") });
  const mounted = await mount();
  try {
    await waitFor(() => (mounted.container.textContent ?? "").includes("alpha text"), "initial activity");
    nativeProofControl.setActivityUnavailable(true);
    await act(async () => { await mounted.queryClient.refetchQueries({
      queryKey: ["proof-action", "vivary-project-runtime-activity"],
    }); });
    await waitFor(() => mounted.container.querySelector("[role='alert']") !== null, "renderer error state");
    assert.ok(!(mounted.container.textContent ?? "").includes("alpha text"));
    assert.match(mounted.container.textContent ?? "", /could not be verified/i);
    assertNoRunControls(mounted.container);
  } finally { await mounted.dispose(); }
}

export async function runComponentProof(): Promise<void> {
  const cases: ReadonlyArray<readonly [string, () => Promise<void>]> = [
    ["Native text and tool render without a composer", rendersNativeTextAndToolWithoutComposer],
    ["selection change hides old activity immediately", selectionChangeHidesOldActivity],
    ["late old activity cannot cross selection", lateOldResultCannotCrossSelection],
    ["failed write keeps requested project and retries", failedWriteKeepsRequestedProjectAndRetries],
    ["invalid and revoked targets stay fail closed", invalidAndRevokedTargetsStayFailClosed],
    ["replaced reference remounts the Native renderer", replacedReferenceRemountsRenderer],
    ["revocation clears rendered activity", revocationClearsActivity],
    ["malformed mismatched and oversize responses fail closed", malformedMismatchAndOversizeFailClosed],
    ["unavailable transport uses the renderer error state", unavailableTransportUsesRendererErrorState],
  ];
  const targetCase = process.env.${TARGET_CASE_ENV};
  assert.ok(targetCase === undefined || cases.some(([name]) => name === targetCase),
    "unknown runtime activity component target case: " + targetCase);
  const selectedCases = targetCase === undefined
    ? cases
    : cases.filter(([name]) => name === targetCase);
  assert.equal(selectedCases.length, targetCase === undefined ? 9 : 1);
  try {
    for (const [name, run] of selectedCases) {
      process.stdout.write("START " + name + "\n");
      await run();
      process.stdout.write("PASS " + name + "\n");
    }
  } finally {
    nativeProofControl.releaseAll();
    assert.equal(activeRoots, 0);
    assert.equal(activeClients, 0);
    assert.equal(nativeProofControl.snapshot().pending, 0);
  }
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
  const dependencies = loadDependencies();
  const nativeBinary = dependencyFile(dependencies, "esbuildNative", ...esbuildPlatform.binarySegments);
  // guard:allow-env-mutation - Isolated fixture worker binds the reviewed esbuild binary.
  process.env.ESBUILD_BINARY_PATH = nativeBinary; // guard:allow-env-credential - Exact reviewed test binary path.
  const esbuild = dependencies.get("esbuild").require("esbuild");
  const priorGlobals = new Map();
  const NativeMessageChannel = globalThis.MessageChannel;
  assert.equal(typeof NativeMessageChannel, "function");
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
  let bundleDirectory = null;
  let bundleFile = null;
  let bundleFileRemoved = false;
  let bundleDirectoryRemoved = false;
  let proofFailure = null;
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; void esbuild.stop(); }, 25_000);
  try {
    const aliases = new Map([
      ["react", dependencyEntry(dependencies, "react", "react")],
      ["react/jsx-runtime", dependencyEntry(dependencies, "react", "react/jsx-runtime")],
      ["react-dom", dependencyEntry(dependencies, "reactDom", "react-dom")],
      ["react-dom/client", dependencyEntry(dependencies, "reactDom", "react-dom/client")],
      ["@tanstack/react-query", dependencyEntry(dependencies, "reactQuery", "@tanstack/react-query")],
      ["zod", dependencyEntry(dependencies, "zod", "zod")],
      ["@agent-native/core/client/conversation",
        dependencyEntry(dependencies, "core", "@agent-native/core/client/conversation")],
      ["@canonical/ProjectContext", join(APP, "components", "projects", "ProjectContext.tsx")],
      ["@canonical/Conversation", join(APP, "components", "workbench", "Conversation.tsx")],
    ]);
    const result = await esbuild.build({
      stdin: { contents: proofSource, resolveDir: HERE,
        sourcefile: "runtime-activity-component-proof.tsx", loader: "tsx" },
      absWorkingDir: WORKBENCH, bundle: true, write: false, metafile: true,
      platform: "node", format: "esm", target: "node22", jsx: "automatic",
      tsconfigRaw: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" } },
      define: { "process.env.NODE_ENV": '"development"' },
      external: ["shiki/*"],
      plugins: [{ name: "runtime-activity-component-proof", setup(build) {
        build.onResolve({ filter: /^@proof\/native-hooks$/ }, () => ({ path: "native-hooks", namespace: "proof" }));
        build.onResolve({ filter: /^@\/lib\/native-state$/ }, () => ({ path: "native-hooks", namespace: "proof" }));
        build.onResolve({ filter: /^@agent-native\/core\/client\/hooks$/ }, () => (
          { path: "native-hooks", namespace: "proof" }));
        build.onResolve({ filter: /^@agent-native\/toolkit\/ui$/ }, () => ({ path: "toolkit", namespace: "proof" }));
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
      } }],
    });
    assert.equal(result.outputFiles.length, 1);
    for (const source of [join(APP, "components", "projects", "ProjectContext.tsx"),
      join(APP, "components", "workbench", "Conversation.tsx"),
      join(APP, "lib", "project-catalog-schema.ts"), join(APP, "lib", "runtime-readiness-schema.ts"),
      join(APP, "lib", "runtime-activity-schema.ts")]) {
      const normalized = source.replaceAll("\\", "/").toLowerCase();
      assert.ok(Object.keys(result.metafile.inputs).some(input =>
        resolve(WORKBENCH, input).replaceAll("\\", "/").toLowerCase() === normalized));
    }
    const coreConversation = dependencyEntry(dependencies, "core", "@agent-native/core/client/conversation");
    assert.ok(Object.keys(result.metafile.inputs).some(input =>
      resolve(WORKBENCH, input).replaceAll("\\", "/").toLowerCase()
      === coreConversation.replaceAll("\\", "/").toLowerCase()), "public Native conversation renderer was not bundled");
    const bundleCapture = captureBundleInputs(result, process.env[CORE_MANIFEST_ENV]); // guard:allow-env-credential - Reviewed Core dependency manifest path.
    const bundleBytes = Buffer.from(result.outputFiles[0].contents);
    process.stdout.write(`BUNDLE_INPUTS ${bundleCapture.encoded}\n`);
    await esbuild.stop();
    esbuildStopped = true;

    const tempRoot = realpathSync(tmpdir());
    bundleDirectory = mkdtempSync(join(tempRoot, "vivary-04b-component-"));
    assert.equal(dirname(realpathSync(bundleDirectory)), tempRoot);
    assert.deepEqual(readdirSync(bundleDirectory), []);
    process.stdout.write(`TEMP_MODULE_DIRECTORY ${JSON.stringify(bundleDirectory)}\n`);
    bundleFile = join(bundleDirectory, "runtime-activity-component-bundle.mjs");
    writeFileSync(bundleFile, bundleBytes, { flag: "wx" });
    assert.equal(realpathSync(bundleFile), bundleFile);
    assert.equal(sha256(readFileSync(bundleFile)), bundleCapture.evidence.output.sha256);

    const linkedom = await import(pathToFileURL(dependencyFile(dependencies, "linkedom", "esm", "index.js")).href);
    const fixtureUrl = new URL("https://fixture.example.invalid/");
    const fixtureLocation = Object.freeze({
      ancestorOrigins: Object.freeze([]), hash: fixtureUrl.hash, host: fixtureUrl.host,
      hostname: fixtureUrl.hostname, href: fixtureUrl.href, origin: fixtureUrl.origin,
      pathname: fixtureUrl.pathname, port: fixtureUrl.port, protocol: fixtureUrl.protocol,
      search: fixtureUrl.search, assign() {}, reload() {}, replace() {},
      toString: () => fixtureUrl.href,
    });
    const fixtureHistory = Object.freeze({
      length: 1, scrollRestoration: "auto", state: null,
      back() {}, forward() {}, go() {}, pushState() {}, replaceState() {},
    });
    const browserGlobals = {
      cancelAnimationFrame: handle => clearTimeout(handle),
      clearTimeout: handle => clearTimeout(handle),
      getComputedStyle: element => element.style ?? Object.freeze({}),
      history: fixtureHistory,
      location: fixtureLocation,
      requestAnimationFrame: callback => setTimeout(() => callback(Date.now()), 0),
      scrollTo() {},
      setTimeout: (callback, delay, ...args) => setTimeout(callback, delay, ...args),
    };
    const view = linkedom.parseHTML("<!doctype html><html><body></body></html>", browserGlobals);
    Object.assign(browserGlobals, { parent: view, top: view });
    for (const name of ["clientHeight", "clientWidth", "scrollHeight", "scrollWidth"]) {
      if (!(name in view.HTMLElement.prototype)) {
        Object.defineProperty(view.HTMLElement.prototype, name,
          { configurable: true, get: () => 0 });
      }
    }
    for (const name of ["scrollLeft", "scrollTop"]) {
      if (!(name in view.HTMLElement.prototype)) {
        Object.defineProperty(view.HTMLElement.prototype, name,
          { configurable: true, writable: true, value: 0 });
      }
    }
    if (typeof view.HTMLElement.prototype.getBoundingClientRect !== "function") {
      Object.defineProperty(view.HTMLElement.prototype, "getBoundingClientRect", {
        configurable: true,
        value() {
          return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0,
            toJSON() { return {}; } };
        },
      });
    }
    if (typeof view.HTMLElement.prototype.scrollTo !== "function") {
      Object.defineProperty(view.HTMLElement.prototype, "scrollTo", {
        configurable: true,
        value(leftOrOptions = 0, top = 0) {
          if (typeof leftOrOptions === "object") {
            this.scrollLeft = leftOrOptions.left ?? this.scrollLeft ?? 0;
            this.scrollTop = leftOrOptions.top ?? this.scrollTop ?? 0;
          } else {
            this.scrollLeft = leftOrOptions;
            this.scrollTop = top;
          }
        },
      });
    }
    const domValues = new Map([["window", view], ["self", view], ["document", view.document],
      ["navigator", view.navigator], ["HTMLElement", view.HTMLElement], ["Element", view.Element],
      ["Node", view.Node], ["Event", view.Event], ["EventTarget", view.EventTarget],
      ["MutationObserver", view.MutationObserver], ["MessageChannel", TrackedMessageChannel],
      ["IS_REACT_ACT_ENVIRONMENT", true]]);
    for (const [name, value] of domValues) {
      priorGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    const proof = await import(pathToFileURL(bundleFile).href);
    assert.equal(typeof proof.runComponentProof, "function");
    try { await proof.runComponentProof(); }
    catch (error) { proofFailure = error; }
    assert.deepEqual(recaptureFiles(bundleCapture.evidence), bundleCapture.evidence.files,
      "a physical bundle input changed while the component cases ran");
    assert.equal(sha256(bundleBytes), bundleCapture.evidence.output.sha256);
    assert.equal(sha256(readFileSync(bundleFile)), bundleCapture.evidence.output.sha256);
  } finally {
    clearTimeout(deadline);
    for (const channel of messageChannels) {
      for (const port of [channel.port1, channel.port2]) {
        try { port.close(); messageChannelPortsClosed += 1; }
        catch (error) { messageChannelCleanupError ??= error; }
      }
    }
    messageChannels.clear();
    for (const [name, descriptor] of priorGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    globalsRestored = true;
    if (!esbuildStopped) {
      await esbuild.stop();
      esbuildStopped = true;
    }
    try {
      if (bundleFile !== null) {
        assert.equal(dirname(bundleFile), bundleDirectory);
        if (existsSync(bundleFile)) unlinkSync(bundleFile);
        assert.equal(existsSync(bundleFile), false);
        bundleFileRemoved = true;
      }
    } finally {
      if (bundleDirectory !== null) {
        assert.deepEqual(readdirSync(bundleDirectory), []);
        rmdirSync(bundleDirectory);
        assert.equal(existsSync(bundleDirectory), false);
        bundleDirectoryRemoved = true;
      }
    }
  }
  assert.equal(timedOut, false);
  assert.equal(messageChannelCleanupError, null);
  assert.ok(messageChannelsCreated > 0);
  assert.equal(messageChannelPortsClosed, messageChannelsCreated * 2);
  assert.equal(esbuildStopped, true);
  assert.equal(globalsRestored, true);
  assert.equal(bundleFileRemoved, true);
  assert.equal(bundleDirectoryRemoved, true);
  process.stdout.write("TEMP_MODULE_CLEANUP fileRemoved=true directoryRemoved=true\n");
  process.stdout.write(`MESSAGE_CHANNEL_CLEANUP channels=${messageChannelsCreated} `
    + `portsClosed=${messageChannelPortsClosed}\n`);
  process.stdout.write("PASS runtime activity component cleanup "
    + "nodeWorkers=1 esbuildServices=1 esbuildStopped=true globalsRestored=true\n");
  if (proofFailure !== null) {
    const code = typeof proofFailure === "object" && proofFailure !== null && "code" in proofFailure
      ? String(proofFailure.code) : "unknown";
    const message = proofFailure instanceof Error ? proofFailure.message : String(proofFailure);
    const expectedRemountFailure = process.env[TARGET_CASE_ENV] === REMOUNT_CASE // guard:allow-env-credential - Exact reviewed component case selector.
      && code === "ERR_ASSERTION" && message === "replaced reference remount";
    const label = expectedRemountFailure ? "replaced reference remount" : "component proof";
    process.stdout.write(`FAIL ${label} code=${code} message=${JSON.stringify(message)}\n`);
    throw proofFailure;
  }
}

if (process.env.VIVARY_RUNTIME_ACTIVITY_COMPONENT_WORKER === "1") { // guard:allow-env-credential - Test child mode flag.
  try { await worker(); }
  catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
} else {
  test("Conversation renders only current bounded Native run activity", () => {
    for (const key of [DEPENDENCY_MANIFEST_ENV, CORE_MANIFEST_ENV]) {
      const value = process.env[key]; // guard:allow-env-credential - Reviewed dependency manifest path.
      assert.ok(value && isAbsolute(value), `explicit absolute dependency manifest required: ${key}`);
    }
    const retained = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP",
      "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"];
    const env = Object.fromEntries(retained.filter(key => process.env[key]) // guard:allow-env-credential - Fixed OS launch paths.
      .map(key => [key, process.env[key]])); // guard:allow-env-credential - Fixed OS launch paths.
    const targetCase = process.env[TARGET_CASE_ENV]; // guard:allow-env-credential - Exact reviewed component case selector.
    assert.ok(targetCase === undefined || TARGET_CASES.has(targetCase),
      "unknown runtime activity component target case: " + targetCase);
    Object.assign(env, { VIVARY_RUNTIME_ACTIVITY_COMPONENT_WORKER: "1",
      [DEPENDENCY_MANIFEST_ENV]: process.env[DEPENDENCY_MANIFEST_ENV], // guard:allow-env-credential - Reviewed manifest path.
      [CORE_MANIFEST_ENV]: process.env[CORE_MANIFEST_ENV], // guard:allow-env-credential - Reviewed Core manifest path.
      NODE_ENV: "test" });
    if (targetCase !== undefined) env[TARGET_CASE_ENV] = targetCase;
    const result = spawnSync(process.execPath, ["--max-old-space-size=192", TEST_FILE], {
      cwd: WORKBENCH, env, windowsHide: true, encoding: "utf8", timeout: 50_000,
      maxBuffer: MAX_CAPTURE_BYTES,
    });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    const stderrTail = (result.stderr ?? "").slice(-4_096);
    assert.equal(result.error, undefined, `${result.error?.message ?? ""}\n${stderrTail}`);
    if (result.status !== 0 && targetCase === REMOUNT_CASE) {
      assert.equal(result.status, 1, stderrTail);
      assertWorkerFailureEvidence(result.stdout, result.stderr ?? "");
      assert.fail("replaced reference remount");
    }
    assert.equal(result.status, 0, stderrTail);
    assertWorkerEvidence(result.stdout, targetCase === undefined ? 9 : 1);
  });
}
