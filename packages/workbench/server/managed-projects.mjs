import { access, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { ActionContractError } from "@agent-native/core/action";
import { z } from "zod";
import { redactCredentials } from "./credential-redaction.ts";
import { ORIGINAL_RUN_FAILURES, runCreatorBridge } from "./original-runtime.ts";
import { connectLocalProjectFolder, getLocalProjectAccess, setLocalProjectKind } from "./project-services.mjs";
import { resolveOriginalRuntime } from "./original-runtime-location.mjs";

const projectName = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .refine(value => !value.endsWith("."));
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const BRIDGE_FILE = "managed_project_workspace.py";
const activeTargets = new Set();
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

/** True for a file or folder name Windows reserves for a device, with or without an extension. */
export function isWindowsReservedName(name) {
  return WINDOWS_RESERVED_NAME.test(name);
}

/** The launcher's bundle, else `VIVARY_PYTHON` or `python3` with the source bridge. */
async function creatorRuntime(dependencies) {
  // guard:allow-env-credential - Launcher-selected runtime directory, not a credential.
  const runtimeDirectory = dependencies.runtimeDirectory ?? process.env.VIVARY_ORIGINAL_RUNTIME;
  const bundled = runtimeDirectory ? await resolveOriginalRuntime(runtimeDirectory) : null;
  // guard:allow-env-credential - Development-selected Python executable, not a credential.
  const python = dependencies.python ?? process.env.VIVARY_PYTHON ?? "python3";
  // The child starts in the bridge's folder, so a relative path resolves here. The child finds a bare name itself,
  // first in that folder on Windows, then on a PATH without the entries spelled inside the project's folder.
  const executable = bundled?.executable ?? (path.basename(python) === python ? python : path.resolve(python));
  const bridge = bundled ? path.join(bundled.root, "bridge", BRIDGE_FILE)
    : dependencies.bridge ?? path.join(process.cwd(), "server", BRIDGE_FILE);
  if (!path.isAbsolute(bridge) || path.basename(bridge) !== BRIDGE_FILE) {
    throw new Error("The workspace creator bridge path is invalid.");
  }
  try {
    await (dependencies.access ?? access)(bridge);
  } catch {
    console.error(`[vivary-managed-projects] bridge-unavailable executable=${path.basename(executable)} bridge=${bridge}`);
    throw new Error("The original workspace creator is unavailable in this Vivary runtime.");
  }
  // A receipt names the interpreter's version. A Python outside the bundle has none, and no bytecode cache.
  return { executable, bridge, version: bundled?.version ?? "unbundled",
    bundle: bundled && { root: bundled.root, build: bundled.build } };
}

/** Exit 0 resolves the answer, another exit rejects with the bridge's message, and unparseable output is unavailable. */
function parseBridgeAnswer(exitCode, stdout, runtime) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    console.error(`[vivary-managed-projects] unreadable-result executable=${path.basename(runtime.executable)} bridge=${runtime.bridge} exit=${exitCode ?? "unknown"}`);
    throw new Error("The workspace creator is unavailable (unreadable-result).");
  }
  if (exitCode === 0) return value;
  // The answer is parsed exactly as printed. Only the refusal an owner reads is redacted.
  throw new Error(redactCredentials(String(value?.message ?? "The workspace creator refused this project.")));
}

async function runCreator(call, dependencies = {}) {
  const runtime = await creatorRuntime(dependencies);
  const { exitCode, stdout } = await runCreatorBridge(call, runtime,
    { dataDir: managedProjectDataDirectory(dependencies), execute: dependencies.execute }).catch(error => {
    // The runner's start failure says to reinstall Vivary, which cannot help a Python outside the bundle.
    if (runtime.version !== "unbundled" || error?.errorCode !== ORIGINAL_RUN_FAILURES.runtimeUnavailable) throw error;
    console.error(`[vivary-managed-projects] interpreter-unavailable executable=${path.basename(runtime.executable)}`);
    throw new ActionContractError("The Python interpreter for the workspace creator could not start.",
      { errorCode: error.errorCode, statusCode: error.statusCode });
  });
  return parseBridgeAnswer(exitCode, stdout, runtime);
}

export function managedProjectDataDirectory(dependencies = {}) {
  // guard:allow-env-credential - Private application data directory from the trusted launcher, not a user credential.
  return dependencies.dataDir ?? process.env.VIVARY_DATA_DIR;
}

async function managedTarget(context, name, createParent, dependencies = {}) {
  const childName = projectName.parse(name);
  if (isWindowsReservedName(childName)) {
    throw new Error("Choose a project name that is valid on Windows.");
  }
  const getAccess = dependencies.getAccess ?? getLocalProjectAccess;
  if ((await getAccess(context)).code !== "catalog") {
    throw Object.assign(new Error("Project access is unavailable."), { statusCode: 403 });
  }
  const dataDir = managedProjectDataDirectory(dependencies);
  if (!dataDir || !path.isAbsolute(dataDir)) {
    throw new Error("The managed project directory is not configured.");
  }
  const canonicalDataDir = await (dependencies.realpath ?? realpath)(dataDir);
  const parent = path.join(canonicalDataDir, "projects");
  if (createParent) {
    try {
      await (dependencies.mkdir ?? mkdir)(parent, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  if (createParent) {
    const info = await (dependencies.lstat ?? lstat)(parent);
    if (!info.isDirectory() || info.isSymbolicLink()
      || await (dependencies.realpath ?? realpath)(parent) !== parent) {
      throw new Error("The managed Projects directory is unavailable.");
    }
  }
  let entries = [];
  try {
    entries = await (dependencies.readdir ?? readdir)(parent);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (entries.some(entry => entry.toLocaleLowerCase("en-US") === childName.toLocaleLowerCase("en-US")
    && entry !== childName)) {
    throw new Error("A project with this name already exists with different capitalization.");
  }
  const target = path.join(parent, childName);
  if (path.dirname(target) !== parent) throw new Error("Choose a simple project name.");
  return { childName, parent, target };
}

export async function installedPatternCatalog(context, dependencies = {}) {
  const getAccess = dependencies.getAccess ?? getLocalProjectAccess;
  if ((await getAccess(context)).code !== "catalog") {
    throw Object.assign(new Error("Project access is unavailable."), { statusCode: 403 });
  }
  return runCreator({ operation: "catalog" }, dependencies);
}

const workspaceRelativePath = z.string().min(1).max(512).refine(value =>
  !value.startsWith("/") && !value.includes("\\") && !/^[A-Za-z]:/.test(value)
  && value.split("/").every(part => part && part !== "." && part !== ".."));
const rolePaths = z.array(workspaceRelativePath).max(64);
const memoryPrivacy = {
  protected: rolePaths,
  privacy_policy: z.enum(["gitignore", "none"]),
  private: rolePaths,
  private_files: z.array(workspaceRelativePath).max(4_000),
  ignore_files: z.array(workspaceRelativePath).max(4_000),
  private_candidates: z.array(workspaceRelativePath).max(16),
  // The creator caps this at _CONTEXT_CHECKED_TOTAL paths and leaves out
  // any name this schema would refuse, so one odd name cannot fail the answer.
  checked_files: z.array(workspaceRelativePath).max(3_000),
  // True when the engine's matching budget ran out and it treated every
  // path it had not decided as private.
  privacy_limited: z.boolean().optional(),
};
// The creator's answer is parsed here, so project memory can trust its shape.
const workspaceContextAnswer = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("thin"),
    roles: z.strictObject({ law: rolePaths, map: rolePaths, record: rolePaths, memory: rolePaths, boundary: rolePaths }),
    state: workspaceRelativePath,
    memory: rolePaths.min(1),
    memory_assigned: z.boolean(),
    ...memoryPrivacy,
  }),
  z.strictObject({
    status: z.literal("plain"), roles: z.null(), state: z.null(),
    memory: rolePaths.min(1), memory_assigned: z.literal(false), ...memoryPrivacy,
  }),
  z.strictObject({ status: z.literal("invalid"), message: z.string().max(2_000) }),
]);

/**
 * The engine's context paths for one project that project services already
 * admitted. This function does not authorize. The read holds the project's
 * read lock, so it waits for a write to that project. `candidates` are
 * workspace-relative files about to be created, checked against the ignore
 * rules. It throws when the bridge is unavailable or its answer does not
 * parse, and the caller reports that as unavailable settings.
 */
export async function readWorkspaceContext(workspace, candidates = [], dependencies = {}) {
  const call = { operation: "context", projectId: workspace.projectId, target: workspace.root,
    ...(candidates.length > 0 ? { candidates } : {}) };
  const result = await (dependencies.runCreator ?? runCreator)(call, dependencies);
  if (result?.code !== "context") throw new Error("The workspace settings reader is unavailable.");
  const answer = workspaceContextAnswer.parse(result.context);
  // The settings error is display text, not a path, so it is redacted like the bridge's refusal.
  if (answer.status === "invalid") return { status: "invalid", message: redactCredentials(answer.message) };
  const privacy = { policy: answer.privacy_policy, private: answer.private,
    privateFiles: answer.private_files, ignoreFiles: answer.ignore_files,
    privateCandidates: answer.private_candidates, checkedFiles: answer.checked_files,
    ...(answer.privacy_limited ? { limited: true } : {}) };
  return answer.status === "thin"
    ? { status: "thin", roles: answer.roles, state: answer.state, memory: answer.memory,
      memoryAssigned: answer.memory_assigned, protected: answer.protected, privacy }
    : { status: "plain", memory: answer.memory, protected: answer.protected, privacy };
}

// Paths are relative to the project folder. An unknown dirty state stays unknown.
const projectObservation = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plain") }),
  z.strictObject({ kind: z.literal("unknown") }),
  z.strictObject({ kind: z.literal("git"), head: z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),
    ref: z.string().min(1).max(1_024).nullable(),
    entries: z.array(z.strictObject({ path: z.string().min(1).max(4_096), state: z.string().min(1).max(2) }))
      .max(10_000).nullable() }),
]);

/**
 * The project's Git version from the engine's hardened read-only checkout
 * observer, for handoff freshness. Like readWorkspaceContext, it does not
 * authorize, and it throws when the bridge is unavailable.
 */
export async function observeProjectVersion(workspace, dependencies = {}) {
  const result = await (dependencies.runCreator ?? runCreator)(
    { operation: "observe", projectId: workspace.projectId, target: workspace.root }, dependencies);
  if (result?.code !== "observe") throw new Error("The project version reader is unavailable.");
  return projectObservation.parse(result.observation);
}

export async function previewManagedProject(context, input, dependencies = {}) {
  const { target } = await managedTarget(context, input.name, false, dependencies);
  return runCreator({ operation: "plan", target,
    patternChoices: input.patternChoices ?? [],
    preset: input.preset ?? "coding" }, dependencies);
}

export async function createManagedProject(context, input, dependencies = {}) {
  const acceptedPlanSha256 = digest.parse(input.acceptedPlanSha256);
  const { childName, parent, target } = await managedTarget(context, input.name, true, dependencies);
  const targetKey = target.toLocaleLowerCase("en-US");
  if (activeTargets.has(targetKey)) {
    throw Object.assign(new Error("This project is already being created. Retry when it finishes."), {
      statusCode: 409,
    });
  }
  activeTargets.add(targetKey);
  try {
    const execute = dependencies.runCreator ?? runCreator;
    const result = await execute({
      operation: "apply",
      target,
      acceptedPlanSha256,
      patternChoices: input.patternChoices ?? [],
      preset: input.preset ?? "coding",
    }, dependencies);
    if (!["created", "already-created"].includes(result.code)) return result;
    const canonicalTarget = await (dependencies.realpath ?? realpath)(target);
    const info = await (dependencies.lstat ?? lstat)(target);
    if (!info.isDirectory() || info.isSymbolicLink() || canonicalTarget !== target
      || path.dirname(canonicalTarget) !== parent) {
      throw new Error("The created project left the managed Projects directory.");
    }
    const connectFolder = dependencies.connectFolder ?? connectLocalProjectFolder;
    const registration = await connectFolder(
      context,
      target,
      input.displayName ?? childName,
    );
    // The kind chosen before the form opened belongs to the registered project, not to its files.
    // The files and registration already exist, so a failed kind save must not report the creation as failed.
    // The project opens with kind Not set and the owner can set it in Project details.
    if (input.workspaceKind && ["registered", "already-registered"].includes(registration.code)) {
      try {
        await (dependencies.setProjectKind ?? setLocalProjectKind)(context, registration.projectId, input.workspaceKind);
      } catch {
        return { ...result, registration, kindSaved: false };
      }
      return { ...result, registration, kindSaved: true };
    }
    return { ...result, registration };
  } finally {
    activeTargets.delete(targetKey);
  }
}
