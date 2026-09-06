import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  rmdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/u;
const FILE_CLASSES = new Set([
  "tracked-clean",
  "tracked-dirty",
  "untracked",
  "selected-ignored",
]);
const HISTORY_KINDS = new Set(["none", "commit", "ref", "bundle"]);
const MANIFEST_FIELDS = [
  "schemaVersion",
  "sourceId",
  "owner",
  "files",
  "history",
  "attribution",
  "exclusions",
];
const FILE_FIELDS = ["path", "kind", "sha256", "size", "class", "destination"];
const HISTORY_FIELDS = ["kind", "evidenceRef", "reason"];
const ATTRIBUTION_FIELDS = ["sourceOwner", "licenseDisposition", "reviewed"];
const EXCLUSION_FIELDS = ["class", "reason"];
const FIXTURE_EXPECTATION_FIELDS = new Set([
  "issues",
  "noWrites",
  "ownedPaths",
  "privacySafeError",
  "receiptBinding",
  "receiptStatus",
  "result",
  "sourceUnchanged",
  "targetTreeRef",
  "tempTreeRef",
  "verifiedPaths",
]);
const RECEIPT_FILE = "restore-receipt.json";

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasUnpairedSurrogate = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
};

export class StrictJsonError extends Error {
  constructor(code) {
    super(code);
    this.name = "StrictJsonError";
    this.code = code;
  }
}

/** Parse JSON without silently accepting duplicate object keys at any depth. */
export function parseStrictJson(text) {
  if (typeof text !== "string") throw new StrictJsonError("invalid-json");
  let cursor = 0;

  const fail = (code = "invalid-json") => {
    throw new StrictJsonError(code);
  };
  const whitespace = () => {
    while (/^[\u0009\u000a\u000d\u0020]$/u.test(text[cursor] ?? "")) cursor += 1;
  };
  const string = () => {
    if (text[cursor] !== '"') fail();
    cursor += 1;
    let result = "";
    while (cursor < text.length) {
      const character = text[cursor];
      cursor += 1;
      if (character === '"') {
        if (hasUnpairedSurrogate(result)) fail();
        return result;
      }
      if (character === "\\") {
        const escape = text[cursor];
        cursor += 1;
        const short = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (Object.hasOwn(short, escape)) {
          result += short[escape];
        } else if (escape === "u") {
          const hex = text.slice(cursor, cursor + 4);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) fail();
          result += String.fromCharCode(Number.parseInt(hex, 16));
          cursor += 4;
        } else {
          fail();
        }
      } else {
        if (character.charCodeAt(0) < 0x20) fail();
        result += character;
      }
    }
    fail();
  };
  const number = () => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(cursor));
    if (!match) fail();
    cursor += match[0].length;
    const parsed = Number(match[0]);
    if (!Number.isFinite(parsed)) fail();
    return parsed;
  };
  const value = () => {
    whitespace();
    const character = text[cursor];
    if (character === '"') return string();
    if (character === "{") {
      cursor += 1;
      whitespace();
      const result = {};
      const keys = new Set();
      if (text[cursor] === "}") {
        cursor += 1;
        return result;
      }
      while (cursor < text.length) {
        whitespace();
        const key = string();
        if (keys.has(key)) fail("duplicate-json-key");
        keys.add(key);
        whitespace();
        if (text[cursor] !== ":") fail();
        cursor += 1;
        Object.defineProperty(result, key, {
          value: value(),
          enumerable: true,
          configurable: true,
          writable: true,
        });
        whitespace();
        if (text[cursor] === "}") {
          cursor += 1;
          return result;
        }
        if (text[cursor] !== ",") fail();
        cursor += 1;
      }
      fail();
    }
    if (character === "[") {
      cursor += 1;
      whitespace();
      const result = [];
      if (text[cursor] === "]") {
        cursor += 1;
        return result;
      }
      while (cursor < text.length) {
        result.push(value());
        whitespace();
        if (text[cursor] === "]") {
          cursor += 1;
          return result;
        }
        if (text[cursor] !== ",") fail();
        cursor += 1;
      }
      fail();
    }
    if (text.startsWith("true", cursor)) {
      cursor += 4;
      return true;
    }
    if (text.startsWith("false", cursor)) {
      cursor += 5;
      return false;
    }
    if (text.startsWith("null", cursor)) {
      cursor += 4;
      return null;
    }
    return number();
  };

  const parsed = value();
  whitespace();
  if (cursor !== text.length) fail();
  return parsed;
}

const canonicalValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
};

export const canonicalJson = (value) => JSON.stringify(canonicalValue(value));
const digestBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const digestManifest = (manifest) => digestBytes(Buffer.from(canonicalJson(manifest), "utf8"));

const addFieldIssues = (value, expected, issues) => {
  if (!isObject(value)) {
    issues.add("invalid-type");
    return false;
  }
  const expectedSet = new Set(expected);
  if (expected.some((key) => !Object.hasOwn(value, key))) issues.add("missing-field");
  if (Object.keys(value).some((key) => !expectedSet.has(key))) issues.add("unknown-field");
  return true;
};

const nonEmptyString = (value, issues) => {
  if (typeof value !== "string") issues.add("invalid-type");
  else if (value.length === 0) issues.add("invalid-value");
};

/** Validate all version-one schema fields without touching the filesystem. */
export function validateManifest(manifest) {
  if (!isObject(manifest)) return { result: "invalid-manifest-root" };
  const issues = new Set();
  addFieldIssues(manifest, MANIFEST_FIELDS, issues);
  if (Object.hasOwn(manifest, "schemaVersion")) {
    if (!Number.isInteger(manifest.schemaVersion)) issues.add("invalid-type");
    else if (manifest.schemaVersion !== 1) return { result: "unsupported-schema-version" };
  }
  if (Object.hasOwn(manifest, "sourceId")) nonEmptyString(manifest.sourceId, issues);
  if (Object.hasOwn(manifest, "owner")) nonEmptyString(manifest.owner, issues);
  let unsupportedKind = false;

  if (Object.hasOwn(manifest, "files") && !Array.isArray(manifest.files)) {
    issues.add("invalid-type");
  } else if (Array.isArray(manifest.files) && manifest.files.length === 0) {
    issues.add("invalid-value");
  } else if (Array.isArray(manifest.files)) {
    for (const file of manifest.files) {
      if (!addFieldIssues(file, FILE_FIELDS, issues)) continue;
      if (Object.hasOwn(file, "path")) nonEmptyString(file.path, issues);
      if (Object.hasOwn(file, "destination")) nonEmptyString(file.destination, issues);
      if (Object.hasOwn(file, "kind")) {
        if (typeof file.kind !== "string") issues.add("invalid-type");
        else if (file.kind !== "file") unsupportedKind = true;
      }
      if (Object.hasOwn(file, "sha256")) {
        if (typeof file.sha256 !== "string") issues.add("invalid-type");
        else if (!SHA256.test(file.sha256)) issues.add("invalid-sha256");
      }
      if (Object.hasOwn(file, "size")) {
        if (typeof file.size !== "number") issues.add("invalid-type");
        else if (!Number.isSafeInteger(file.size) || file.size < 0) issues.add("invalid-size");
      }
      if (Object.hasOwn(file, "class")) {
        if (typeof file.class !== "string") issues.add("invalid-type");
        else if (!FILE_CLASSES.has(file.class)) issues.add("invalid-enum");
      }
    }
  }

  if (Object.hasOwn(manifest, "history") && addFieldIssues(manifest.history, HISTORY_FIELDS, issues)) {
    const history = manifest.history;
    if (Object.hasOwn(history, "kind")) {
      if (typeof history.kind !== "string") issues.add("invalid-type");
      else if (!HISTORY_KINDS.has(history.kind)) issues.add("invalid-enum");
    }
    if (Object.hasOwn(history, "evidenceRef") && Object.hasOwn(history, "kind")) {
      if (history.kind === "none") {
        if (history.evidenceRef !== null) issues.add("invalid-value");
      } else {
        nonEmptyString(history.evidenceRef, issues);
      }
    }
    if (Object.hasOwn(history, "reason")) nonEmptyString(history.reason, issues);
  }

  if (Object.hasOwn(manifest, "attribution") &&
      addFieldIssues(manifest.attribution, ATTRIBUTION_FIELDS, issues)) {
    if (Object.hasOwn(manifest.attribution, "sourceOwner")) {
      nonEmptyString(manifest.attribution.sourceOwner, issues);
    }
    if (Object.hasOwn(manifest.attribution, "licenseDisposition")) {
      nonEmptyString(manifest.attribution.licenseDisposition, issues);
    }
    if (Object.hasOwn(manifest.attribution, "reviewed")) {
      if (typeof manifest.attribution.reviewed !== "boolean") issues.add("invalid-type");
      else if (manifest.attribution.reviewed !== true) issues.add("invalid-value");
    }
  }

  if (Object.hasOwn(manifest, "exclusions") && !Array.isArray(manifest.exclusions)) {
    issues.add("invalid-type");
  } else if (Array.isArray(manifest.exclusions)) {
    for (const exclusion of manifest.exclusions) {
      if (!addFieldIssues(exclusion, EXCLUSION_FIELDS, issues)) continue;
      if (Object.hasOwn(exclusion, "class")) nonEmptyString(exclusion.class, issues);
      if (Object.hasOwn(exclusion, "reason")) nonEmptyString(exclusion.reason, issues);
    }
  }

  if (issues.size > 0) return { result: "invalid-manifest", issues: [...issues].sort() };
  if (unsupportedKind) return { result: "unsupported-kind" };
  return null;
}

const pathParts = (relativePath) => relativePath.split("/");

const isSafeRelativePosixPath = (value) => {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("/") || value.startsWith("//") || /^[A-Za-z]:/u.test(value)) return false;
  if (value.includes("\\") || value.includes("\0")) return false;
  const parts = pathParts(value);
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
};

const alias = (value, caseSensitivity) =>
  caseSensitivity === "insensitive" ? value.toLowerCase() : value;

const validatePathsAndAliases = (manifest, policy) => {
  if (!isObject(policy) || policy.pathStyle !== "posix-relative" || policy.noFollow !== true ||
      policy.rejectUnknownFields !== true ||
      !new Set(["sensitive", "insensitive"]).has(policy.caseSensitivity)) {
    return { result: "invalid-policy" };
  }
  for (const file of manifest.files) {
    if (!isSafeRelativePosixPath(file.path) || !isSafeRelativePosixPath(file.destination)) {
      return { result: "unsafe-path" };
    }
  }
  const sources = manifest.files.map((file) => alias(file.path, policy.caseSensitivity));
  if (new Set(sources).size !== sources.length) return { result: "source-collision" };
  const destinations = manifest.files.map((file) => alias(file.destination, policy.caseSensitivity));
  if (new Set(destinations).size !== destinations.length) return { result: "destination-collision" };
  for (let left = 0; left < destinations.length; left += 1) {
    for (let right = left + 1; right < destinations.length; right += 1) {
      const a = destinations[left];
      const b = destinations[right];
      if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) {
        return { result: "destination-collision" };
      }
    }
  }
  return null;
};

class OperationRefusal extends Error {
  constructor(result) {
    super(result);
    this.name = "OperationRefusal";
    this.result = result;
  }
}

const refuse = (result) => {
  throw new OperationRefusal(result);
};

const lstatOptional = async (absolutePath, options) => {
  try {
    return await lstat(absolutePath, options);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
};

const assertDirectoryRoot = async (rootPath) => {
  const absolute = path.resolve(rootPath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const components = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const component of components) {
    current = path.join(current, component);
    const info = await lstatOptional(current);
    if (info === null) refuse("filesystem-error");
    if (info.isSymbolicLink()) refuse("unsafe-link");
    if (!info.isDirectory()) refuse("filesystem-error");
  }
  const rootInfo = await lstatOptional(absolute);
  if (rootInfo === null || !rootInfo.isDirectory()) refuse("filesystem-error");
  return absolute;
};

const inspectRelativePath = async (root, relativePath) => {
  let current = root;
  const parts = pathParts(relativePath);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const info = await lstatOptional(current);
    if (info === null) return { state: "missing", index, absolutePath: current };
    if (info.isSymbolicLink()) refuse("unsafe-link");
    if (index < parts.length - 1 && !info.isDirectory()) {
      return { state: "blocked", index, absolutePath: current, info };
    }
    if (index === parts.length - 1) return { state: "present", absolutePath: current, info };
  }
  throw new Error("validated paths always contain a component");
};

const readRegularFileNoFollow = async (absolutePath) => {
  const handle = await open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

const scanTree = async (root, { includeContent = false } = {}) => {
  const records = [];
  const visit = async (absoluteDirectory, relativeDirectory) => {
    const names = await readdir(absoluteDirectory);
    names.sort();
    for (const name of names) {
      const absolutePath = path.join(absoluteDirectory, name);
      const relativePath = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        records.push({ path: relativePath, kind: "link", target: await readlink(absolutePath) });
      } else if (info.isDirectory()) {
        records.push({ path: relativePath, kind: "directory" });
        await visit(absolutePath, relativePath);
      } else if (info.isFile()) {
        const bytes = await readRegularFileNoFollow(absolutePath);
        if (bytes === null) refuse("unsafe-link");
        const record = {
          path: relativePath,
          kind: "file",
          size: bytes.length,
          sha256: digestBytes(bytes),
        };
        if (includeContent) record.contentBase64 = bytes.toString("base64");
        records.push(record);
      } else {
        records.push({ path: relativePath, kind: "special" });
      }
    }
  };
  await visit(root, "");
  records.sort((left, right) => left.path.localeCompare(right.path));
  return records;
};

const digestTree = (records) => digestBytes(Buffer.from(canonicalJson(
  records.map(({ contentBase64: _content, ...record }) => record),
), "utf8"));

const inventorySource = async (sourceRoot, manifest) => {
  const tree = await scanTree(sourceRoot);
  const sourceTreeDigest = digestTree(tree);
  const bytesByPath = new Map();
  for (const file of manifest.files) {
    const inspected = await inspectRelativePath(sourceRoot, file.path);
    if (inspected.state !== "present") refuse("source-missing");
    if (!inspected.info.isFile()) refuse("source-not-file");
    const bytes = await readRegularFileNoFollow(inspected.absolutePath);
    if (bytes === null) refuse("unsafe-link");
    if (bytes.length !== file.size) refuse("source-size-mismatch");
    const sourceHashMatches = digestBytes(bytes) === file.sha256;
    if (!sourceHashMatches) refuse("source-hash-mismatch");
    bytesByPath.set(file.path, bytes);
  }
  return { sourceTreeDigest, bytesByPath };
};

const outputsForManifest = (manifest) => manifest.files.map((file) => ({
  path: file.destination,
  size: file.size,
  sha256: file.sha256,
}));

const same = (left, right) => canonicalJson(left) === canonicalJson(right);

const validateReceiptShape = (receipt) => {
  if (!isObject(receipt) || receipt.schemaVersion !== 1 ||
      !new Set(["complete", "incomplete"]).has(receipt.status)) refuse("receipt-invalid");
  const expectedFields = receipt.status === "complete"
    ? ["schemaVersion", "status", "manifestDigest", "sourceTreeDigest", "outputs"]
    : [
        "schemaVersion",
        "status",
        "manifestDigest",
        "sourceTreeDigest",
        "outputs",
        "ownedPaths",
        "observedTargetDigest",
      ];
  if (!same(Object.keys(receipt).sort(), [...expectedFields].sort())) refuse("receipt-invalid");
  if (!SHA256.test(receipt.manifestDigest ?? "") || !SHA256.test(receipt.sourceTreeDigest ?? "")) {
    refuse("receipt-invalid");
  }
  if (!Array.isArray(receipt.outputs)) refuse("receipt-invalid");
  for (const output of receipt.outputs) {
    if (!isObject(output) || !same(Object.keys(output).sort(), ["path", "sha256", "size"]) ||
        !isSafeRelativePosixPath(output.path) || !SHA256.test(output.sha256 ?? "") ||
        !Number.isSafeInteger(output.size) || output.size < 0) {
      refuse("receipt-invalid");
    }
  }
  if (receipt.status === "incomplete") {
    if (!Array.isArray(receipt.ownedPaths) || !SHA256.test(receipt.observedTargetDigest ?? "") ||
        receipt.ownedPaths.some((ownedPath) => !isSafeRelativePosixPath(ownedPath)) ||
        new Set(receipt.ownedPaths).size !== receipt.ownedPaths.length) {
      refuse("receipt-invalid");
    }
  }
};

const readReceipt = async (receiptPath) => {
  const inspected = await inspectRelativePath(path.dirname(receiptPath), path.basename(receiptPath));
  if (inspected.state === "missing") return { receipt: null, text: null };
  if (inspected.state !== "present" || !inspected.info.isFile()) refuse("receipt-invalid");
  const bytes = await readRegularFileNoFollow(receiptPath);
  if (bytes === null) refuse("unsafe-link");
  let receipt;
  try {
    receipt = parseStrictJson(bytes.toString("utf8"));
  } catch {
    refuse("receipt-invalid");
  }
  validateReceiptShape(receipt);
  return { receipt, text: bytes };
};

const validateReceiptBinding = (receipt, manifestDigest, sourceTreeDigest, outputs) => {
  if (receipt.manifestDigest !== manifestDigest || receipt.sourceTreeDigest !== sourceTreeDigest ||
      !same(receipt.outputs, outputs)) {
    refuse("receipt-binding-mismatch");
  }
};

const verifyOutput = async (targetRoot, output) => {
  const inspected = await inspectRelativePath(targetRoot, output.path);
  if (inspected.state !== "present" || !inspected.info.isFile()) refuse("target-conflict");
  const bytes = await readRegularFileNoFollow(inspected.absolutePath);
  if (bytes === null || bytes.length !== output.size || digestBytes(bytes) !== output.sha256) {
    refuse("target-conflict");
  }
};

const ensureDestinationComponentsHaveNoLinks = async (targetRoot, outputs) => {
  for (const output of outputs) await inspectRelativePath(targetRoot, output.path);
};

const allowedPartialRecords = (ownedPaths) => {
  const files = new Set(ownedPaths);
  const directories = new Set();
  for (const ownedPath of ownedPaths) {
    const parts = pathParts(ownedPath);
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return { files, directories };
};

const validateIncompleteTarget = async (targetRoot, targetTree, receipt, manifest) => {
  const expectedPrefix = manifest.files.slice(0, receipt.ownedPaths.length)
    .map((file) => file.destination);
  if (!same(receipt.ownedPaths, expectedPrefix)) refuse("receipt-invalid");
  if (digestTree(targetTree) !== receipt.observedTargetDigest) refuse("target-conflict");
  const allowed = allowedPartialRecords(receipt.ownedPaths);
  for (const record of targetTree) {
    if (record.kind === "file" && allowed.files.has(record.path)) continue;
    if (record.kind === "directory" && allowed.directories.has(record.path)) continue;
    refuse("target-conflict");
  }
  for (const output of outputsForManifest(manifest).slice(0, receipt.ownedPaths.length)) {
    await verifyOutput(targetRoot, output);
  }
};

const ensureParentDirectories = async (targetRoot, relativePath, createdDirectories) => {
  let current = targetRoot;
  const parts = pathParts(relativePath).slice(0, -1);
  for (const component of parts) {
    current = path.join(current, component);
    const info = await lstatOptional(current);
    if (info === null) {
      await mkdir(current);
      createdDirectories.push(current);
      continue;
    }
    if (info.isSymbolicLink()) refuse("unsafe-link");
    if (!info.isDirectory()) refuse("target-conflict");
  }
};

const assertWritableDirectory = async (directory) => {
  try {
    await access(directory, constants.W_OK | constants.X_OK);
  } catch {
    refuse("filesystem-error");
  }
};

const preflightDestinationWrites = async (targetRoot, destinations) => {
  for (const destination of destinations) {
    let current = targetRoot;
    for (const component of pathParts(destination).slice(0, -1)) {
      const next = path.join(current, component);
      const info = await lstatOptional(next);
      if (info === null) break;
      if (info.isSymbolicLink()) refuse("unsafe-link");
      if (!info.isDirectory()) refuse("target-conflict");
      current = next;
    }
    await assertWritableDirectory(current);
  }
};

const rollbackCreatedOutputs = async (createdFiles, createdDirectories) => {
  let complete = true;
  for (const createdFile of [...createdFiles].reverse()) {
    try {
      await unlink(createdFile);
    } catch (error) {
      if (error?.code !== "ENOENT") complete = false;
    }
  }
  for (const createdDirectory of [...createdDirectories].reverse()) {
    try {
      await rmdir(createdDirectory);
    } catch (error) {
      if (error?.code !== "ENOENT") complete = false;
    }
  }
  return complete;
};

const writeReceiptAtomically = async (receiptPath, receipt) => {
  const temporaryPath = path.join(
    path.dirname(receiptPath),
    `.${RECEIPT_FILE}.${randomUUID()}.tmp`,
  );
  const text = `${canonicalJson(receipt)}\n`;
  try {
    await writeFile(temporaryPath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporaryPath, receiptPath);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
};

const writeOneOutput = async ({
  file,
  bytes,
  targetRoot,
  tempRoot,
  createdFiles,
  createdDirectories,
}) => {
  await ensureParentDirectories(targetRoot, file.destination, createdDirectories);
  const destinationPath = path.join(targetRoot, ...pathParts(file.destination));
  const temporaryPath = path.join(tempRoot, `${randomUUID()}.output`);
  try {
    const handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    const staged = await readRegularFileNoFollow(temporaryPath);
    if (staged === null || staged.length !== file.size || digestBytes(staged) !== file.sha256) {
      refuse("write-verification-failed");
    }
    const destinationHandle = await open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    createdFiles.push(destinationPath);
    try {
      await destinationHandle.writeFile(staged);
    } finally {
      await destinationHandle.close();
    }
    await verifyOutput(targetRoot, { path: file.destination, size: file.size, sha256: file.sha256 });
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
};

const rootsOverlap = (left, right) => {
  const relative = path.relative(left, right);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
};

const validateRootSeparation = (roots) => {
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (rootsOverlap(roots[left], roots[right]) || rootsOverlap(roots[right], roots[left])) {
        return false;
      }
    }
  }
  return true;
};

/**
 * Restore one validated manifest between caller-owned roots.
 *
 * This operation is intentionally local and single-process. It makes no claim
 * about crash durability, concurrent writers, or platform-specific aliases.
 */
export async function restoreSourcePreservation({
  manifestText,
  sourceRoot,
  targetRoot,
  tempRoot,
  receiptRoot,
  policy = {
    pathStyle: "posix-relative",
    caseSensitivity: "sensitive",
    noFollow: true,
    rejectUnknownFields: true,
  },
  fault = null,
}) {
  const createdFiles = [];
  const createdDirectories = [];
  let writePhaseStarted = false;
  let manifest;
  try {
    manifest = parseStrictJson(manifestText);
  } catch (error) {
    return { result: error instanceof StrictJsonError ? error.code : "invalid-json" };
  }
  const schemaFailure = validateManifest(manifest);
  if (schemaFailure !== null) return schemaFailure;
  const pathFailure = validatePathsAndAliases(manifest, policy);
  if (pathFailure !== null) return pathFailure;
  if (fault !== null && (!isObject(fault) || fault.op !== "interrupt-after-output" ||
      !Number.isSafeInteger(fault.count) || fault.count < 1 ||
      !same(Object.keys(fault).sort(), ["count", "op"]))) {
    return { result: "invalid-fault" };
  }

  const absoluteSourceRoot = path.resolve(sourceRoot);
  const absoluteTargetRoot = path.resolve(targetRoot);
  const absoluteTempRoot = path.resolve(tempRoot);
  const absoluteReceiptRoot = path.resolve(receiptRoot);
  if (!validateRootSeparation([
    absoluteSourceRoot,
    absoluteTargetRoot,
    absoluteTempRoot,
    absoluteReceiptRoot,
  ])) return { result: "unsafe-path" };

  try {
    await assertDirectoryRoot(absoluteSourceRoot);
    const source = await inventorySource(absoluteSourceRoot, manifest);
    const manifestDigest = digestManifest(manifest);
    const outputs = outputsForManifest(manifest);

    await assertDirectoryRoot(absoluteTargetRoot);
    await assertDirectoryRoot(absoluteTempRoot);
    await assertDirectoryRoot(absoluteReceiptRoot);
    const receiptPath = path.join(absoluteReceiptRoot, RECEIPT_FILE);
    const { receipt } = await readReceipt(receiptPath);
    if (receipt !== null) {
      validateReceiptBinding(receipt, manifestDigest, source.sourceTreeDigest, outputs);
    }

    await ensureDestinationComponentsHaveNoLinks(absoluteTargetRoot, outputs);
    const targetTree = await scanTree(absoluteTargetRoot);
    const tempTree = await scanTree(absoluteTempRoot);
    if (tempTree.some((record) => record.kind === "link")) refuse("unsafe-link");
    if (tempTree.length > 0) refuse("target-conflict");

    if (receipt?.status === "complete") {
      for (const output of outputs) await verifyOutput(absoluteTargetRoot, output);
      return { result: "already-restored", manifestDigest, verifiedPaths: outputs.map((item) => item.path) };
    }

    let ownedPaths = [];
    if (receipt?.status === "incomplete") {
      await validateIncompleteTarget(absoluteTargetRoot, targetTree, receipt, manifest);
      ownedPaths = [...receipt.ownedPaths];
    } else if (targetTree.length > 0) {
      refuse("target-conflict");
    }

    const remainingDestinations = manifest.files.slice(ownedPaths.length)
      .map((file) => file.destination);
    await preflightDestinationWrites(absoluteTargetRoot, remainingDestinations);
    await assertWritableDirectory(absoluteTempRoot);
    await assertWritableDirectory(absoluteReceiptRoot);

    const sourceBeforeWrite = await scanTree(absoluteSourceRoot);
    if (digestTree(sourceBeforeWrite) !== source.sourceTreeDigest) refuse("source-changed");

    writePhaseStarted = true;
    for (let index = ownedPaths.length; index < manifest.files.length; index += 1) {
      const file = manifest.files[index];
      await writeOneOutput({
        file,
        bytes: source.bytesByPath.get(file.path),
        targetRoot: absoluteTargetRoot,
        tempRoot: absoluteTempRoot,
        createdFiles,
        createdDirectories,
      });
      ownedPaths.push(file.destination);
      if (fault?.count === ownedPaths.length) {
        const interruptedTarget = await scanTree(absoluteTargetRoot);
        const sourceAfterInterrupt = await scanTree(absoluteSourceRoot);
        if (digestTree(sourceAfterInterrupt) !== source.sourceTreeDigest) refuse("source-changed");
        await writeReceiptAtomically(receiptPath, {
          schemaVersion: 1,
          status: "incomplete",
          manifestDigest,
          sourceTreeDigest: source.sourceTreeDigest,
          outputs,
          ownedPaths,
          observedTargetDigest: digestTree(interruptedTarget),
        });
        return { result: "incomplete", manifestDigest, ownedPaths };
      }
    }

    for (const output of outputs) await verifyOutput(absoluteTargetRoot, output);
    const sourceAfterWrite = await scanTree(absoluteSourceRoot);
    if (digestTree(sourceAfterWrite) !== source.sourceTreeDigest) refuse("source-changed");
    await writeReceiptAtomically(receiptPath, {
      schemaVersion: 1,
      status: "complete",
      manifestDigest,
      sourceTreeDigest: source.sourceTreeDigest,
      outputs,
    });
    return { result: "restored", manifestDigest, verifiedPaths: outputs.map((item) => item.path) };
  } catch (error) {
    if (writePhaseStarted) {
      const rolledBack = await rollbackCreatedOutputs(createdFiles, createdDirectories);
      if (!rolledBack) return { result: "rollback-failed" };
    }
    if (error instanceof OperationRefusal) return { result: error.result };
    return { result: "filesystem-error" };
  }
}

const pointerParts = (pointer) => {
  if (typeof pointer !== "string" || !pointer.startsWith("/") || pointer === "/") {
    throw new Error("invalid fixture JSON Pointer");
  }
  return pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
};

const pointerParent = (root, pointer) => {
  const parts = pointerParts(pointer);
  const final = parts.pop();
  let parent = root;
  for (const part of parts) {
    if ((!isObject(parent) && !Array.isArray(parent)) || !Object.hasOwn(parent, part)) {
      throw new Error("fixture mutation parent is missing");
    }
    parent = parent[part];
  }
  if (!isObject(parent) && !Array.isArray(parent)) throw new Error("fixture mutation parent is invalid");
  return { parent, final };
};

const applyJsonMutation = (manifest, mutation) => {
  if (mutation.op === "append-json") {
    const parts = pointerParts(mutation.pointer);
    let selected = manifest;
    for (const part of parts) {
      if ((!isObject(selected) && !Array.isArray(selected)) || !Object.hasOwn(selected, part)) {
        throw new Error("fixture append target is missing");
      }
      selected = selected[part];
    }
    if (!Array.isArray(selected)) throw new Error("fixture append target is not an array");
    selected.push(structuredClone(mutation.value));
    return;
  }
  const { parent, final } = pointerParent(manifest, mutation.pointer);
  if (mutation.op === "set-json") {
    Object.defineProperty(parent, final, {
      value: structuredClone(mutation.value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  } else if (mutation.op === "remove-json") {
    if (!Object.hasOwn(parent, final)) throw new Error("fixture remove target is missing");
    delete parent[final];
  } else {
    throw new Error("unsupported fixture JSON mutation");
  }
};

const mutateTree = (trees, mutation) => {
  if (!new Set(["source", "target", "temp"]).has(mutation.tree)) {
    throw new Error("unsupported fixture tree");
  }
  const tree = trees[mutation.tree];
  const index = tree.findIndex((entry) => entry.path === mutation.path);
  if (mutation.op === "tree-add") {
    if (index !== -1 || mutation.entry?.path !== mutation.path) throw new Error("invalid tree-add mutation");
    tree.push(structuredClone(mutation.entry));
  } else if (mutation.op === "tree-replace") {
    if (index === -1 || mutation.entry?.path !== mutation.path) throw new Error("invalid tree-replace mutation");
    tree[index] = structuredClone(mutation.entry);
  } else if (mutation.op === "tree-remove") {
    if (index === -1) throw new Error("invalid tree-remove mutation");
    tree.splice(index, 1);
  } else {
    throw new Error("unsupported fixture tree mutation");
  }
};

const validateFixtureTree = (entries) => {
  if (!Array.isArray(entries)) throw new Error("fixture tree must be an array");
  const paths = new Set();
  for (const entry of entries) {
    if (!isObject(entry) || !isSafeRelativePosixPath(entry.path) || paths.has(entry.path)) {
      throw new Error("invalid fixture tree entry");
    }
    paths.add(entry.path);
    if (entry.kind === "file") {
      if (!same(Object.keys(entry).sort(), ["contentBase64", "kind", "path"]) ||
          typeof entry.contentBase64 !== "string" ||
          Buffer.from(entry.contentBase64, "base64").toString("base64") !== entry.contentBase64) {
        throw new Error("invalid fixture file");
      }
    } else if (entry.kind === "directory") {
      if (!same(Object.keys(entry).sort(), ["kind", "path"])) throw new Error("invalid fixture directory");
    } else if (entry.kind === "link") {
      if (!same(Object.keys(entry).sort(), ["kind", "path", "target"]) ||
          typeof entry.target !== "string" || entry.target.length === 0) throw new Error("invalid fixture link");
    } else {
      throw new Error("unsupported fixture tree entry");
    }
  }
  for (const entry of entries) {
    const parts = pathParts(entry.path);
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = entries.find((candidate) => candidate.path === parts.slice(0, index).join("/"));
      if (ancestor && ancestor.kind !== "directory") throw new Error("fixture tree ancestor is not a directory");
    }
  }
};

const materializeTree = async (root, entries) => {
  validateFixtureTree(entries);
  const ordered = [...entries].sort((left, right) => {
    const depth = pathParts(left.path).length - pathParts(right.path).length;
    if (depth !== 0) return depth;
    if (left.kind === "directory" && right.kind !== "directory") return -1;
    if (right.kind === "directory" && left.kind !== "directory") return 1;
    return left.path.localeCompare(right.path);
  });
  for (const entry of ordered) {
    const absolutePath = path.join(root, ...pathParts(entry.path));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    if (entry.kind === "directory") await mkdir(absolutePath);
    else if (entry.kind === "file") await writeFile(absolutePath, Buffer.from(entry.contentBase64, "base64"), { flag: "wx" });
    else await symlink(entry.target, absolutePath);
  }
};

const snapshotRoot = async (root) => {
  const rootInfo = await lstat(root, { bigint: true });
  const entries = await scanTree(root, { includeContent: true });
  const withMetadata = [];
  for (const entry of entries) {
    const info = await lstat(path.join(root, ...pathParts(entry.path)), { bigint: true });
    withMetadata.push({ ...entry, mode: info.mode.toString(), mtimeNs: info.mtimeNs.toString() });
  }
  return {
    root: { mode: rootInfo.mode.toString(), mtimeNs: rootInfo.mtimeNs.toString() },
    entries: withMetadata,
  };
};

const snapshotReceipt = async (receiptRoot) => {
  const rootInfo = await lstat(receiptRoot, { bigint: true });
  const receiptPath = path.join(receiptRoot, RECEIPT_FILE);
  const info = await lstatOptional(receiptPath, { bigint: true });
  return {
    root: { mode: rootInfo.mode.toString(), mtimeNs: rootInfo.mtimeNs.toString() },
    file: info === null ? null : {
      mode: info.mode.toString(),
      mtimeNs: info.mtimeNs.toString(),
      contentBase64: (await readFile(receiptPath)).toString("base64"),
    },
  };
};

const comparableTree = async (root, explicitExpected) => {
  const actual = await scanTree(root, { includeContent: true });
  const explicitDirectories = new Set(
    explicitExpected.filter((entry) => entry.kind === "directory").map((entry) => entry.path),
  );
  const hasDescendant = (directory) => actual.some((entry) => entry.path.startsWith(`${directory.path}/`));
  return actual
    .filter((entry) => entry.kind !== "directory" || explicitDirectories.has(entry.path) || !hasDescendant(entry))
    .map((entry) => {
      if (entry.kind === "file") {
        return { path: entry.path, kind: "file", contentBase64: entry.contentBase64 };
      }
      if (entry.kind === "link") return { path: entry.path, kind: "link", target: entry.target };
      return { path: entry.path, kind: entry.kind };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
};

const normalizedFixtureTree = (entries) => [...entries]
  .map((entry) => structuredClone(entry))
  .sort((left, right) => left.path.localeCompare(right.path));

const materializeReferencedTreeDigest = async (caseRoot, entries, label) => {
  const root = path.join(caseRoot, label);
  await mkdir(root);
  await materializeTree(root, entries);
  const digest = digestTree(await scanTree(root));
  await rm(root, { recursive: true });
  return digest;
};

const materializeReceipt = async ({ fixture, receiptRef, caseRoot, sourceEntries, receiptRoot }) => {
  if (receiptRef === "none") return;
  const symbolic = fixture.receipts[receiptRef];
  if (!isObject(symbolic) || !Object.hasOwn(fixture.manifests, symbolic.manifestRef)) {
    throw new Error("invalid symbolic receipt");
  }
  const referencedManifest = structuredClone(fixture.manifests[symbolic.manifestRef]);
  const schemaFailure = validateManifest(referencedManifest);
  if (schemaFailure !== null) throw new Error("symbolic receipt manifest is invalid");
  const receipt = {
    schemaVersion: 1,
    status: symbolic.status,
    manifestDigest: digestManifest(referencedManifest),
    sourceTreeDigest: await materializeReferencedTreeDigest(
      caseRoot,
      sourceEntries,
      "receipt-source-reference",
    ),
    outputs: outputsForManifest(referencedManifest),
  };
  if (symbolic.status === "incomplete") {
    receipt.ownedPaths = structuredClone(symbolic.ownedPaths);
    if (!Object.hasOwn(fixture.trees, symbolic.observedTargetTreeRef)) {
      throw new Error("symbolic incomplete receipt target is missing");
    }
    receipt.observedTargetDigest = await materializeReferencedTreeDigest(
      caseRoot,
      fixture.trees[symbolic.observedTargetTreeRef],
      "receipt-target-reference",
    );
  } else if (symbolic.status !== "complete") {
    throw new Error("unsupported symbolic receipt status");
  }
  await writeFile(path.join(receiptRoot, RECEIPT_FILE), `${canonicalJson(receipt)}\n`, { flag: "wx" });
};

const selectRef = (fixture, collection, reference) => {
  if (!isObject(fixture[collection]) || !Object.hasOwn(fixture[collection], reference)) {
    throw new Error(`fixture ${collection} reference is missing`);
  }
  return structuredClone(fixture[collection][reference]);
};

const prepareFixtureCase = (fixture, fixtureCase) => {
  const setup = { ...fixture.defaults, ...(fixtureCase.setup ?? {}) };
  const manifest = selectRef(fixture, "manifests", setup.manifestRef);
  const trees = {
    source: selectRef(fixture, "trees", setup.sourceTreeRef),
    target: selectRef(fixture, "trees", setup.targetTreeRef),
    temp: selectRef(fixture, "trees", setup.tempTreeRef),
  };
  const receiptSourceEntries = structuredClone(trees.source);
  const policy = structuredClone(setup.policy);
  for (const mutation of fixtureCase.mutations ?? []) {
    if (new Set(["set-json", "remove-json", "append-json"]).has(mutation.op)) {
      applyJsonMutation(manifest, mutation);
    } else if (new Set(["tree-add", "tree-remove", "tree-replace"]).has(mutation.op)) {
      mutateTree(trees, mutation);
    } else if (mutation.op === "set-policy") {
      if (mutation.field !== "caseSensitivity") throw new Error("unsupported fixture policy mutation");
      policy[mutation.field] = structuredClone(mutation.value);
    } else {
      throw new Error("unsupported fixture mutation");
    }
  }
  return {
    setup,
    manifest,
    manifestText: fixtureCase.rawManifestText ?? canonicalJson(manifest),
    trees,
    receiptSourceEntries,
    policy,
  };
};

const compareSet = (left, right) => same([...left].sort(), [...right].sort());

const runOneFixtureCase = async (fixture, fixtureCase, caseRoot) => {
  const prepared = prepareFixtureCase(fixture, fixtureCase);
  const roots = Object.fromEntries(
    ["source", "target", "temp", "receipt"].map((name) => [name, path.join(caseRoot, name)]),
  );
  for (const root of Object.values(roots)) await mkdir(root);
  await materializeTree(roots.source, prepared.trees.source);
  await materializeTree(roots.target, prepared.trees.target);
  await materializeTree(roots.temp, prepared.trees.temp);
  await materializeReceipt({
    fixture,
    receiptRef: prepared.setup.receiptRef,
    caseRoot,
    sourceEntries: prepared.receiptSourceEntries,
    receiptRoot: roots.receipt,
  });

  const before = {
    source: await snapshotRoot(roots.source),
    target: await snapshotRoot(roots.target),
    temp: await snapshotRoot(roots.temp),
    receipt: await snapshotReceipt(roots.receipt),
  };
  const actual = await restoreSourcePreservation({
    manifestText: prepared.manifestText,
    sourceRoot: roots.source,
    targetRoot: roots.target,
    tempRoot: roots.temp,
    receiptRoot: roots.receipt,
    policy: prepared.policy,
    fault: fixtureCase.fault ?? null,
  });
  const after = {
    source: await snapshotRoot(roots.source),
    target: await snapshotRoot(roots.target),
    temp: await snapshotRoot(roots.temp),
    receipt: await snapshotReceipt(roots.receipt),
  };
  const expect = { ...(fixture.defaults.expect ?? {}), ...fixtureCase.expect };
  const failures = [];
  if (actual.result !== expect.result) failures.push("result");
  if (expect.issues && !compareSet(actual.issues ?? [], expect.issues)) failures.push("issues");
  if (expect.sourceUnchanged && !same(before.source, after.source)) failures.push("source changed");
  if (expect.noWrites === true) {
    if (!same(before.target, after.target)) failures.push("target changed on refusal/recheck");
    if (!same(before.temp, after.temp)) failures.push("temporary tree changed on refusal/recheck");
    if (!same(before.receipt, after.receipt)) failures.push("receipt changed on refusal/recheck");
  } else {
    if (expect.targetTreeRef) {
      const expectedTarget = selectRef(fixture, "trees", expect.targetTreeRef);
      if (!same(await comparableTree(roots.target, expectedTarget), normalizedFixtureTree(expectedTarget))) {
        failures.push("target tree");
      }
    }
    if (expect.tempTreeRef) {
      const expectedTemp = selectRef(fixture, "trees", expect.tempTreeRef);
      if (!same(await comparableTree(roots.temp, expectedTemp), normalizedFixtureTree(expectedTemp))) {
        failures.push("temporary tree");
      }
    }
  }

  if (expect.receiptStatus || expect.receiptBinding || expect.verifiedPaths || expect.ownedPaths) {
    let receipt = null;
    try {
      receipt = parseStrictJson(await readFile(path.join(roots.receipt, RECEIPT_FILE), "utf8"));
    } catch {
      failures.push("receipt unavailable");
    }
    if (receipt !== null) {
      if (expect.receiptStatus && receipt.status !== expect.receiptStatus) failures.push("receipt status");
      if (expect.receiptBinding === "current-manifest" &&
          receipt.manifestDigest !== digestManifest(prepared.manifest)) failures.push("receipt binding");
      if (expect.verifiedPaths && !same(receipt.outputs?.map((item) => item.path), expect.verifiedPaths)) {
        failures.push("verified paths");
      }
      if (expect.ownedPaths && !same(receipt.ownedPaths, expect.ownedPaths)) failures.push("owned paths");
    }
  }
  if (expect.privacySafeError && !new Set(["restored", "already-restored", "incomplete"]).has(actual.result)) {
    const keys = Object.keys(actual).sort();
    if (!same(keys, expect.issues ? ["issues", "result"] : ["result"])) failures.push("unsafe error detail");
  }
  return { id: fixtureCase.id, pass: failures.length === 0, failures, actual };
};

const invalidFixtureExpectation = () => {
  throw new Error("invalid fixture expectation");
};

const validateFixtureExpectation = (expect, fixture, requireAssertions = false) => {
  if (!isObject(expect) || Object.keys(expect).some((key) => !FIXTURE_EXPECTATION_FIELDS.has(key))) {
    invalidFixtureExpectation();
  }
  for (const field of ["sourceUnchanged", "privacySafeError", "noWrites"]) {
    if (Object.hasOwn(expect, field) && typeof expect[field] !== "boolean") invalidFixtureExpectation();
  }
  for (const field of ["result", "targetTreeRef", "tempTreeRef"]) {
    if (Object.hasOwn(expect, field) &&
        (typeof expect[field] !== "string" || expect[field].length === 0)) {
      invalidFixtureExpectation();
    }
  }
  if (Object.hasOwn(expect, "receiptStatus") &&
      !new Set(["complete", "incomplete"]).has(expect.receiptStatus)) {
    invalidFixtureExpectation();
  }
  if (Object.hasOwn(expect, "receiptBinding") && expect.receiptBinding !== "current-manifest") {
    invalidFixtureExpectation();
  }
  if (Object.hasOwn(expect, "issues") &&
      (!Array.isArray(expect.issues) ||
       !expect.issues.every((issue) => typeof issue === "string" && issue.length > 0))) {
    invalidFixtureExpectation();
  }
  for (const field of ["verifiedPaths", "ownedPaths"]) {
    if (Object.hasOwn(expect, field) &&
        (!Array.isArray(expect[field]) || !expect[field].every(isSafeRelativePosixPath))) {
      invalidFixtureExpectation();
    }
  }
  for (const field of ["targetTreeRef", "tempTreeRef"]) {
    if (Object.hasOwn(expect, field) && !Object.hasOwn(fixture.trees, expect[field])) {
      invalidFixtureExpectation();
    }
  }
  if (!requireAssertions) return;
  if (expect.sourceUnchanged !== true || expect.privacySafeError !== true ||
      typeof expect.result !== "string" || typeof expect.noWrites !== "boolean") {
    invalidFixtureExpectation();
  }
  if (expect.noWrites === false) {
    for (const field of ["targetTreeRef", "tempTreeRef", "receiptStatus", "receiptBinding"]) {
      if (!Object.hasOwn(expect, field)) invalidFixtureExpectation();
    }
    const pathsField = expect.receiptStatus === "complete" ? "verifiedPaths" : "ownedPaths";
    if (!Object.hasOwn(expect, pathsField)) invalidFixtureExpectation();
  }
};

const validateFixtureEnvelope = (fixture) => {
  if (!isObject(fixture) || fixture.fixtureSchemaVersion !== 1 || !isObject(fixture.defaults) ||
      !isObject(fixture.manifests) || !isObject(fixture.trees) || !isObject(fixture.receipts) ||
      !Array.isArray(fixture.cases)) throw new Error("invalid source-preservation fixture");
  for (const tree of Object.values(fixture.trees)) validateFixtureTree(tree);
  validateFixtureExpectation(fixture.defaults.expect, fixture);
  const caseIds = new Set();
  for (const fixtureCase of fixture.cases) {
    const id = fixtureCase?.id;
    if (typeof id !== "string" || id.length === 0) throw new Error("invalid fixture case id");
    if (caseIds.has(id)) throw new Error(`duplicate fixture case id: ${id}`);
    caseIds.add(id);
    validateFixtureExpectation(fixtureCase.expect, fixture);
    validateFixtureExpectation(
      { ...fixture.defaults.expect, ...fixtureCase.expect },
      fixture,
      true,
    );
    const prepared = prepareFixtureCase(fixture, fixtureCase);
    for (const tree of Object.values(prepared.trees)) validateFixtureTree(tree);
  }
};

/** Run every fixture case against fresh real directories. Case IDs are labels only. */
export async function runFixture(fixture, { workParent = tmpdir() } = {}) {
  validateFixtureEnvelope(fixture);
  const workRoot = await mkdtemp(path.join(path.resolve(workParent), "vivary-source-preservation-"));
  const results = [];
  try {
    for (let index = 0; index < fixture.cases.length; index += 1) {
      const caseRoot = path.join(workRoot, `case-${String(index + 1).padStart(3, "0")}`);
      await mkdir(caseRoot);
      results.push(await runOneFixtureCase(fixture, fixture.cases[index], caseRoot));
    }
  } finally {
    await rm(workRoot, { recursive: true });
  }
  return results;
}

export const checkFixture = runFixture;

async function cli(argv) {
  const fixtureIndex = argv.indexOf("--fixture");
  if (fixtureIndex < 0 || typeof argv[fixtureIndex + 1] !== "string" || !argv.includes("--check")) {
    console.error("usage: node prove_multi_project_source_preservation.mjs --fixture PATH --check");
    return 2;
  }
  let fixture;
  try {
    fixture = parseStrictJson(await readFile(argv[fixtureIndex + 1], "utf8"));
  } catch {
    console.error("fixture: FAIL (unavailable or invalid JSON)");
    return 1;
  }
  let results;
  try {
    results = await runFixture(fixture);
  } catch {
    console.error("fixture: FAIL (invalid fixture or filesystem proof failure)");
    return 1;
  }
  for (const result of results) {
    console.log(`${result.id}: ${result.pass ? "PASS" : `FAIL (${result.failures.join(", ")})`}`);
  }
  const passed = results.filter((result) => result.pass).length;
  console.log(`aggregate: ${passed}/${results.length} passed`);
  return passed === results.length ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await cli(process.argv.slice(2));
}
