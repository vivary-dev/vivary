// Test-only resolution to installed native HTTP, action, harness, org and database packages.
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

let requireCore;
const ACTIVITY_HARNESS_URL = "vivary-test:runtime-activity-harness";
const ACTIVITY_SERVER_URL = "vivary-test:runtime-activity-server";
export function initialize({ corePackageJson }) {
  if (!isAbsolute(corePackageJson)) throw new Error("test dependency root must be absolute");
  const manifestPath = realpathSync(corePackageJson);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "@agent-native/core" || manifest.version !== "0.176.5") {
    throw new Error("test requires the inspected Core 0.176.5 package");
  }
  requireCore = createRequire(manifestPath);
  if (requireCore("zod/package.json").version !== "4.6.7") {
    throw new Error("test requires the inspected Zod 4.6.7 package");
  }
}

export function resolve(specifier, context, nextResolve) {
  const activityOwner = context.parentURL?.endsWith("/server/project-runtime-activity.mjs");
  if (activityOwner && specifier === "@agent-native/core/agent/harness") {
    return { url: ACTIVITY_HARNESS_URL, shortCircuit: true };
  }
  if (activityOwner && specifier === "@agent-native/core/server") {
    return { url: ACTIVITY_SERVER_URL, shortCircuit: true };
  }
  if (specifier === "@vivary-test/core-harness") {
    return { url: pathToFileURL(requireCore.resolve("@agent-native/core/agent/harness")).href,
      shortCircuit: true };
  }
  if (specifier === "@vivary-test/core-server") {
    return { url: pathToFileURL(requireCore.resolve("@agent-native/core/server")).href,
      shortCircuit: true };
  }
  if (["@agent-native/core/server", "@agent-native/core/action", "@agent-native/core/agent/harness",
    "@agent-native/core/db", "@agent-native/core/db/schema", "@agent-native/core/org", "h3", "zod"]
    .includes(specifier)) {
    return { url: pathToFileURL(requireCore.resolve(specifier)).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (url === ACTIVITY_HARNESS_URL) return { format: "module", shortCircuit: true, source: `
    export * from "@vivary-test/core-harness";
    import { getAgentHarnessBackgroundRun as readRun,
      getAgentHarnessSession as readSession,
      listAgentHarnessBackgroundTranscriptEvents as readEvents } from "@vivary-test/core-harness";
    const mark = name => globalThis[Symbol.for("vivary.runtimeActivityNativeReads")]?.(name);
    export async function getAgentHarnessBackgroundRun(...args) { mark("run"); return readRun(...args); }
    export async function getAgentHarnessSession(...args) { mark("session"); return readSession(...args); }
    export async function listAgentHarnessBackgroundTranscriptEvents(...args) {
      mark("events"); return readEvents(...args);
    }
  ` };
  if (url === ACTIVITY_SERVER_URL) return { format: "module", shortCircuit: true, source: `
    export * from "@vivary-test/core-server";
    import { getThread as readThread } from "@vivary-test/core-server";
    const mark = name => globalThis[Symbol.for("vivary.runtimeActivityNativeReads")]?.(name);
    export async function getThread(...args) { mark("thread"); return readThread(...args); }
  ` };
  return nextLoad(url, context);
}
