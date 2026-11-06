import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

/** Resolve the launcher-selected bundle without consulting a global Python installation. */
export async function resolveOriginalRuntime(directory) {
  if (!directory || !path.isAbsolute(directory)) {
    throw new Error("The original Vivary runtime is not bundled with this installation.");
  }
  const root = await realpath(directory);
  const bytes = await readFile(path.join(root, "manifest.json"));
  const manifest = JSON.parse(bytes.toString("utf8"));
  const relative = process.platform === "win32" ? "python/python.exe" : "python/bin/python3";
  if (manifest?.schemaVersion !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch
      || manifest.pythonExecutable !== relative || typeof manifest.pythonVersion !== "string") {
    throw new Error("The bundled Vivary runtime does not match this computer.");
  }
  const executable = await realpath(path.join(root, relative));
  const inside = path.relative(root, executable);
  if (inside.startsWith(`..${path.sep}`) || inside === ".." || path.isAbsolute(inside)) {
    throw new Error("The bundled Vivary runtime path is invalid.");
  }
  // The manifest records the source commit and the hash of every wheel, the bridge, and the interpreter,
  // so its digest changes whenever the bundle's Python files can.
  const build = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  return { root, executable, version: manifest.pythonVersion, build };
}
