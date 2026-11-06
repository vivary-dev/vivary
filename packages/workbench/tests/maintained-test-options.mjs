// Shared option resolution for the maintained Workbench checks (packet 06h).
//
// The registry and mutation suites keep their explicit, absolute
// VIVARY_*_PROOF_ROOT and VIVARY_TEST_CORE_PACKAGE_JSON contract, and their
// worker children still receive those values through the allowlisted env
// pass-through. When the parent process starts without them, supply the
// installed Core manifest and a disposable proof root so the documented
// package scripts run from a clean environment.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const INSTALLED_CORE_MANIFEST = fileURLToPath(
  new URL("../node_modules/@agent-native/core/package.json", import.meta.url));

export function ensureCorePackageJson() {
  const explicit = process.env.VIVARY_TEST_CORE_PACKAGE_JSON; // guard:allow-env-credential — Test dependency manifest path; no credential value.
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error("VIVARY_TEST_CORE_PACKAGE_JSON must be an absolute path");
    return explicit;
  }
  // guard:allow-env-mutation — Test-only default so worker children inherit the resolved manifest path; process-scoped by design.
  process.env.VIVARY_TEST_CORE_PACKAGE_JSON = INSTALLED_CORE_MANIFEST; // guard:allow-env-credential — Test dependency manifest path; no credential value.
  return INSTALLED_CORE_MANIFEST;
}

const proofRootReads = Object.freeze({
  VIVARY_REGISTRY_PROOF_ROOT: () => process.env.VIVARY_REGISTRY_PROOF_ROOT, // guard:allow-env-credential — Disposable test directory path; no credential value.
  VIVARY_12H_PROOF_ROOT: () => process.env.VIVARY_12H_PROOF_ROOT, // guard:allow-env-credential — Disposable test directory path; no credential value.
  VIVARY_17A_PROOF_ROOT: () => process.env.VIVARY_17A_PROOF_ROOT, // guard:allow-env-credential — Disposable test directory path; no credential value.
});

export function ensureProofRoot(variable) {
  const read = proofRootReads[variable];
  if (!read) throw new Error(`unknown proof root variable ${variable}`);
  const explicit = read();
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error(`${variable} must be an absolute path`);
    return explicit;
  }
  const created = mkdtempSync(path.join(os.tmpdir(), `vivary-${variable.toLowerCase()}-`));
  // guard:allow-env-mutation — Test-only default so worker children inherit the disposable proof root; process-scoped by design.
  process.env[variable] = created; // guard:allow-env-credential — Disposable test directory path; no credential value.
  process.once("exit", () => rmSync(created, { recursive: true, force: true }));
  return created;
}

// The native SQLite module is built for the Node major that ran pnpm install.
// Surface a load failure here, in one sentence, instead of as a failed child exit.
export function assertNativeSqliteMatchesNode(corePackageJson) {
  const requireFromCore = createRequire(realpathSync(corePackageJson));
  try {
    const Database = requireFromCore("better-sqlite3");
    new Database(":memory:").close();
  } catch (error) {
    if (error?.code === "ERR_DLOPEN_FAILED") {
      throw new Error(`better-sqlite3's native module failed to load under ${process.version}. `
        + "It is built for the Node major that ran pnpm install (CI pins Node 22), so a Node ABI "
        + "mismatch is the usual cause; see the original error.", { cause: error });
    }
    throw error;
  }
}
