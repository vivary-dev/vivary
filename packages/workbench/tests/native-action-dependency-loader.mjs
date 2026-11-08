// Test-only resolution to existing locked native dependencies, never an install.
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

let requireCore;
export function initialize({ corePackageJson }) {
  if (!isAbsolute(corePackageJson)) throw new Error("test dependency root must be absolute");
  const manifestPath = realpathSync(corePackageJson);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "@agent-native/core" || manifest.version !== "0.176.5") {
    throw new Error("test requires the inspected @agent-native/core 0.176.5 package");
  }
  requireCore = createRequire(manifestPath);
  if (requireCore("zod/package.json").version !== "4.6.7") {
    throw new Error("test requires the inspected Zod 4.6.7 package");
  }
}

export function resolve(specifier, context, nextResolve) {
  if (["@agent-native/core/action", "@agent-native/core/db", "@agent-native/core/db/schema", "zod"]
    .includes(specifier)) {
    return { url: pathToFileURL(requireCore.resolve(specifier)).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
