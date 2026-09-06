import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const OPERATIONS = new Set([
  "register",
  "export",
  "rebind",
  "admit-mutation",
  "authorize-write-back",
]);
const CAPABILITIES = new Set([
  "register-project",
  "export-project",
  "rebind-project",
  "mutate-project",
  "write-back-project",
]);
const TRUSTED_FIELDS = [
  "actorId",
  "collectionId",
  "deviceId",
  "member",
  "capabilities",
  "rootAccess",
  "policyRevision",
  "registryRevision",
  "root",
  "portable",
  "binding",
  "existingRootBindings",
  "receipt",
  "allocatedProjectId",
  "allocatedBindingId",
  "allocatedIdsInUse",
  "reservations",
  "nextFence",
  "execution",
  "patchVerified",
  "overlapSafe",
  "privateState",
];

export class RegistryInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "RegistryInputError";
  }
}

const invalid = (message) => {
  throw new RegistryInputError(message);
};

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

/** Parse JSON while rejecting duplicate object keys and unpaired surrogates. */
export function parseStrictJson(text) {
  if (typeof text !== "string") invalid("JSON input must be a string");
  let cursor = 0;

  const fail = (message) => invalid(`${message} at offset ${cursor}`);
  const whitespace = () => {
    while (/\s/u.test(text[cursor] ?? "") && /[\u0009\u000a\u000d\u0020]/u.test(text[cursor])) {
      cursor += 1;
    }
  };
  const string = () => {
    if (text[cursor] !== '"') fail("Expected string");
    cursor += 1;
    let result = "";
    while (cursor < text.length) {
      const character = text[cursor];
      cursor += 1;
      if (character === '"') {
        if (hasUnpairedSurrogate(result)) fail("Unpaired Unicode surrogate");
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
          if (!/^[0-9a-fA-F]{4}$/u.test(hex)) fail("Invalid Unicode escape");
          result += String.fromCharCode(Number.parseInt(hex, 16));
          cursor += 4;
        } else {
          fail("Invalid string escape");
        }
      } else {
        if (character.charCodeAt(0) < 0x20) fail("Unescaped control character");
        result += character;
      }
    }
    fail("Unterminated string");
  };
  const number = () => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(cursor));
    if (!match) fail("Invalid number");
    cursor += match[0].length;
    const result = Number(match[0]);
    if (!Number.isFinite(result)) fail("Non-finite number");
    return result;
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
        if (keys.has(key)) fail(`Duplicate JSON key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        if (text[cursor] !== ":") fail("Expected colon");
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
        if (text[cursor] !== ",") fail("Expected comma or object end");
        cursor += 1;
      }
      fail("Unterminated object");
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
        if (text[cursor] !== ",") fail("Expected comma or array end");
        cursor += 1;
      }
      fail("Unterminated array");
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

  const result = value();
  whitespace();
  if (cursor !== text.length) fail("Trailing JSON content");
  return result;
}

const exactKeys = (value, expected, label) => {
  if (!isObject(value)) invalid(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(`${label} has missing or unknown fields`);
  }
};

const id = (value, label) => {
  if (typeof value !== "string" || !ID.test(value)) invalid(`${label} must be an identifier`);
};

const boolean = (value, label) => {
  if (typeof value !== "boolean") invalid(`${label} must be a boolean`);
};

const safeInteger = (value, minimum, label) => {
  if (!Number.isSafeInteger(value) || value < minimum) invalid(`${label} must be a safe integer >= ${minimum}`);
};

const uniqueArray = (value, itemCheck, label) => {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  const seen = new Set();
  value.forEach((item, index) => {
    itemCheck(item, `${label}[${index}]`);
    const key = typeof item === "string" ? item : canonicalJson(item);
    if (seen.has(key)) invalid(`${label} must not contain duplicates`);
    seen.add(key);
  });
};

const contentIdentity = (value, label) => {
  if (value === null) return;
  exactKeys(value, ["algorithm", "manifestDigest"], label);
  if (value.algorithm !== "sha256" || typeof value.manifestDigest !== "string" || !HEX_64.test(value.manifestDigest)) {
    invalid(`${label} is not a sha256 content identity`);
  }
};

const vcs = (value, label) => {
  if (!isObject(value)) invalid(`${label} must be an object`);
  if (!["none", "git", "jj-git", "unsupported"].includes(value.kind)) invalid(`${label}.kind is unsupported`);
  const keys = ["kind", "repositoryId", "checkoutId", "mutationOwner"];
  if (value.kind === "jj-git") keys.splice(3, 0, "jjRepositoryId");
  exactKeys(value, keys, label);
  if (value.kind === "none" || value.kind === "unsupported") {
    if (value.repositoryId !== null || value.checkoutId !== null || value.mutationOwner !== null) {
      invalid(`${label} must not name VCS resources`);
    }
    return;
  }
  id(value.repositoryId, `${label}.repositoryId`);
  id(value.checkoutId, `${label}.checkoutId`);
  if (value.kind === "git" && value.mutationOwner !== "git") invalid(`${label} Git owner must be git`);
  if (value.kind === "jj-git") {
    id(value.jjRepositoryId, `${label}.jjRepositoryId`);
    if (value.mutationOwner !== "jj" && value.mutationOwner !== null) {
      invalid(`${label} Jujutsu owner must be jj or null`);
    }
  }
};

const portable = (value, label) => {
  exactKeys(value, ["schemaVersion", "projectId", "displayName", "contentIdentity"], label);
  if (value.schemaVersion !== 1) invalid(`${label}.schemaVersion is unsupported`);
  id(value.projectId, `${label}.projectId`);
  if (
    typeof value.displayName !== "string" ||
    hasUnpairedSurrogate(value.displayName) ||
    Array.from(value.displayName).length < 1 ||
    Array.from(value.displayName).length > 200
  ) {
    invalid(`${label}.displayName is invalid`);
  }
  contentIdentity(value.contentIdentity, `${label}.contentIdentity`);
};

const binding = (value, label) => {
  exactKeys(value, [
    "bindingId", "projectId", "collectionId", "actorId", "deviceId", "rootId",
    "locationRef", "bindingRevision", "policyRevision", "vcs",
  ], label);
  for (const field of ["bindingId", "projectId", "collectionId", "actorId", "deviceId", "rootId", "locationRef"]) {
    id(value[field], `${label}.${field}`);
  }
  safeInteger(value.bindingRevision, 1, `${label}.bindingRevision`);
  safeInteger(value.policyRevision, 1, `${label}.policyRevision`);
  vcs(value.vcs, `${label}.vcs`);
};

const root = (value, label) => {
  exactKeys(value, ["rootId", "locationRef", "exists", "isDirectory", "identityVerified", "contentRevision", "vcs"], label);
  for (const field of ["rootId", "locationRef", "contentRevision"]) id(value[field], `${label}.${field}`);
  for (const field of ["exists", "isDirectory", "identityVerified"]) boolean(value[field], `${label}.${field}`);
  vcs(value.vcs, `${label}.vcs`);
};

const resourceKey = (value, label) => {
  if (typeof value !== "string") invalid(`${label} must be a resource key`);
  const pieces = value.split(":");
  if (pieces.length !== 3 || !["repository", "checkout", "root"].includes(pieces[1])) invalid(`${label} is malformed`);
  id(pieces[0], `${label}.deviceId`);
  id(pieces[2], `${label}.resourceId`);
};

const reservation = (value, label) => {
  exactKeys(value, [
    "keys", "ownerActorId", "ownerCollectionId", "ownerDeviceId",
    "ownerOperationId", "state", "fence",
  ], label);
  uniqueArray(value.keys, resourceKey, `${label}.keys`);
  if (value.keys.length === 0 || value.keys.some((key, index) => index > 0 && value.keys[index - 1] >= key)) {
    invalid(`${label}.keys must be nonempty, unique, and sorted`);
  }
  for (const field of ["ownerActorId", "ownerCollectionId", "ownerDeviceId", "ownerOperationId"]) {
    id(value[field], `${label}.${field}`);
  }
  if (value.keys.some((key) => key.split(":")[0] !== value.ownerDeviceId)) {
    invalid(`${label}.keys must match the owner device`);
  }
  if (value.state !== "active" && value.state !== "uncertain") invalid(`${label}.state is invalid`);
  safeInteger(value.fence, 1, `${label}.fence`);
};

const admissionKeySetIsComplete = (keys, deviceId) => {
  const parts = keys.map((key) => key.split(":"));
  if (parts.some(([keyDeviceId]) => keyDeviceId !== deviceId)) return false;
  if (parts.length === 1) return parts[0][1] === "root";
  return parts.length === 2 && parts[0][1] === "checkout" && parts[1][1] === "repository";
};

const successOutput = (value, operation, operationId, deviceId, label) => {
  if (!isObject(value)) invalid(`${label} must be an object`);
  if (operation === "register") {
    exactKeys(value, ["code", "projectId", "bindingId", "bindingRevision", "replayed"], label);
    if (value.code !== "registered" && value.code !== "already-registered") invalid(`${label}.code is invalid`);
    id(value.projectId, `${label}.projectId`);
    id(value.bindingId, `${label}.bindingId`);
    safeInteger(value.bindingRevision, 1, `${label}.bindingRevision`);
    boolean(value.replayed, `${label}.replayed`);
  } else if (operation === "rebind") {
    exactKeys(value, ["code", "projectId", "bindingId", "bindingRevision", "replayed"], label);
    if (value.code !== "rebound") invalid(`${label}.code is invalid`);
    id(value.projectId, `${label}.projectId`);
    id(value.bindingId, `${label}.bindingId`);
    safeInteger(value.bindingRevision, 1, `${label}.bindingRevision`);
    boolean(value.replayed, `${label}.replayed`);
  } else if (operation === "admit-mutation") {
    exactKeys(value, ["code", "bindingId", "keys", "fence", "ownerOperationId"], label);
    if (value.code !== "admitted") invalid(`${label}.code is invalid`);
    id(value.bindingId, `${label}.bindingId`);
    uniqueArray(value.keys, resourceKey, `${label}.keys`);
    if (value.keys.length === 0 || value.keys.some((key, index) => index > 0 && value.keys[index - 1] >= key)) {
      invalid(`${label}.keys must be nonempty, unique, and sorted`);
    }
    if (!admissionKeySetIsComplete(value.keys, deviceId)) invalid(`${label}.keys must be a complete scoped resource set`);
    safeInteger(value.fence, 1, `${label}.fence`);
    id(value.ownerOperationId, `${label}.ownerOperationId`);
    if (value.ownerOperationId !== operationId) invalid(`${label}.ownerOperationId must match the receipt operation`);
  } else {
    invalid(`${label} is not valid for a receipt`);
  }
};

const receipt = (value, label) => {
  exactKeys(value, [
    "actorId", "collectionId", "deviceId", "operation", "operationId",
    "requestDigest", "status", "rootId", "vcs", "output",
  ], label);
  for (const field of ["actorId", "collectionId", "deviceId", "operationId", "rootId"]) id(value[field], `${label}.${field}`);
  if (!["register", "rebind", "admit-mutation"].includes(value.operation)) invalid(`${label}.operation is invalid`);
  if (typeof value.requestDigest !== "string" || !HEX_64.test(value.requestDigest)) invalid(`${label}.requestDigest is invalid`);
  if (!["complete", "pending", "uncertain"].includes(value.status)) invalid(`${label}.status is invalid`);
  vcs(value.vcs, `${label}.vcs`);
  successOutput(value.output, value.operation, value.operationId, value.deviceId, `${label}.output`);
};

const execution = (value, label) => {
  exactKeys(value, [
    "sessionId", "actorId", "projectId", "bindingId", "bindingRevision",
    "policyRevision", "executionCopyId", "baseContentRevision",
  ], label);
  for (const field of ["sessionId", "actorId", "projectId", "bindingId", "executionCopyId", "baseContentRevision"]) {
    id(value[field], `${label}.${field}`);
  }
  safeInteger(value.bindingRevision, 1, `${label}.bindingRevision`);
  safeInteger(value.policyRevision, 1, `${label}.policyRevision`);
};

const relativePath = (value, label) => {
  if (typeof value !== "string" || value.length === 0 || hasUnpairedSurrogate(value)) invalid(`${label} is invalid`);
  if (/^[A-Za-z]:/.test(value) || value.startsWith("/") || value.includes("\\") || value.includes("\0")) invalid(`${label} is unsafe`);
  const pieces = value.split("/");
  if (pieces.some((piece) => piece === "" || piece === "." || piece === "..")) invalid(`${label} is not normalized`);
};

const requestFields = {
  register: ["operationId", "expectedPolicyRevision", "expectedRegistryRevision", "locationRef", "displayName", "contentIdentity", "attachProjectId"],
  export: ["operationId", "expectedPolicyRevision", "projectId"],
  rebind: ["operationId", "expectedPolicyRevision", "expectedRegistryRevision", "bindingId", "expectedBindingRevision", "locationRef"],
  "admit-mutation": ["operationId", "expectedPolicyRevision", "expectedRegistryRevision", "bindingId", "expectedBindingRevision", "expectedContentRevision", "requestedVcsOwner"],
  "authorize-write-back": ["operationId", "expectedPolicyRevision", "bindingId", "expectedBindingRevision", "expectedContentRevision", "requestedVcsOwner", "executionCopyId", "patchDigest", "selectedPaths", "fence"],
};

const validateRequest = (operation, request) => {
  exactKeys(request, requestFields[operation], "request");
  id(request.operationId, "request.operationId");
  safeInteger(request.expectedPolicyRevision, 1, "request.expectedPolicyRevision");
  if (["register", "rebind", "admit-mutation"].includes(operation)) {
    safeInteger(request.expectedRegistryRevision, 0, "request.expectedRegistryRevision");
  }
  if (operation === "register") {
    id(request.locationRef, "request.locationRef");
    if (
      typeof request.displayName !== "string" ||
      hasUnpairedSurrogate(request.displayName) ||
      Array.from(request.displayName).length < 1 ||
      Array.from(request.displayName).length > 200
    ) invalid("request.displayName is invalid");
    contentIdentity(request.contentIdentity, "request.contentIdentity");
    if (request.attachProjectId !== null) id(request.attachProjectId, "request.attachProjectId");
  } else if (operation === "export") {
    id(request.projectId, "request.projectId");
  } else {
    id(request.bindingId, "request.bindingId");
    safeInteger(request.expectedBindingRevision, 1, "request.expectedBindingRevision");
    if (operation === "rebind") {
      id(request.locationRef, "request.locationRef");
    } else {
      id(request.expectedContentRevision, "request.expectedContentRevision");
      if (![null, "git", "jj"].includes(request.requestedVcsOwner)) invalid("request.requestedVcsOwner is invalid");
      if (operation === "authorize-write-back") {
        id(request.executionCopyId, "request.executionCopyId");
        if (typeof request.patchDigest !== "string" || !HEX_64.test(request.patchDigest)) invalid("request.patchDigest is invalid");
        uniqueArray(request.selectedPaths, relativePath, "request.selectedPaths");
        if (request.selectedPaths.length === 0) invalid("request.selectedPaths must not be empty");
        safeInteger(request.fence, 1, "request.fence");
      }
    }
  }
};

/** Validate the complete reference-model boundary. Returns the same input on success. */
export function validateRegistryInput(input) {
  exactKeys(input, ["operation", "request", "trusted"], "input");
  if (typeof input.operation !== "string" || !OPERATIONS.has(input.operation)) invalid("operation is unsupported");
  validateRequest(input.operation, input.request);
  const trusted = input.trusted;
  exactKeys(trusted, TRUSTED_FIELDS, "trusted");
  for (const field of ["actorId", "collectionId", "deviceId", "allocatedProjectId", "allocatedBindingId"]) id(trusted[field], `trusted.${field}`);
  for (const field of ["member", "allocatedIdsInUse", "patchVerified", "overlapSafe"]) boolean(trusted[field], `trusted.${field}`);
  uniqueArray(trusted.capabilities, (value, label) => {
    if (typeof value !== "string" || !CAPABILITIES.has(value)) invalid(`${label} is unsupported`);
  }, "trusted.capabilities");
  uniqueArray(trusted.rootAccess, id, "trusted.rootAccess");
  safeInteger(trusted.policyRevision, 1, "trusted.policyRevision");
  safeInteger(trusted.registryRevision, 0, "trusted.registryRevision");
  root(trusted.root, "trusted.root");
  if (trusted.portable !== null) portable(trusted.portable, "trusted.portable");
  if (trusted.binding !== null) binding(trusted.binding, "trusted.binding");
  uniqueArray(trusted.existingRootBindings, binding, "trusted.existingRootBindings");
  if (trusted.receipt !== null) receipt(trusted.receipt, "trusted.receipt");
  uniqueArray(trusted.reservations, reservation, "trusted.reservations");
  safeInteger(trusted.nextFence, 1, "trusted.nextFence");
  if (trusted.execution !== null) execution(trusted.execution, "trusted.execution");
  exactKeys(trusted.privateState, ["locator", "credentialRef", "remoteRef"], "trusted.privateState");
  for (const field of ["locator", "credentialRef", "remoteRef"]) id(trusted.privateState[field], `trusted.privateState.${field}`);
  if ((input.operation === "register" || input.operation === "rebind") && trusted.root.locationRef !== input.request.locationRef) {
    invalid("trusted root does not match requested location");
  }
  return input;
}

function canonicalJson(value) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    if (hasUnpairedSurrogate(value)) invalid("Canonical JSON cannot contain unpaired surrogates");
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) invalid("Canonical request JSON numbers must be safe integers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  invalid("Canonical JSON received an unsupported value");
}

/** Compute the contract's canonical SHA-256 digest for a caller request. */
export function digestRequest(request) {
  return createHash("sha256").update(canonicalJson(request), "utf8").digest("hex");
}

const same = (left, right) => canonicalJson(left) === canonicalJson(right);
const refusal = (code) => ({ output: { code }, effects: [], recordChanges: {} });
const accepted = (output, effects, recordChanges) => ({ output, effects, recordChanges });
const portableProjection = (value) => ({
  schemaVersion: value.schemaVersion,
  projectId: value.projectId,
  displayName: value.displayName,
  contentIdentity: value.contentIdentity === null ? null : { ...value.contentIdentity },
});
const inScope = (value, trusted) =>
  value.actorId === trusted.actorId &&
  value.collectionId === trusted.collectionId &&
  value.deviceId === trusted.deviceId;
const requiredCapability = {
  register: ["register-project"],
  export: ["export-project"],
  rebind: ["rebind-project"],
  "admit-mutation": ["mutate-project"],
  "authorize-write-back": ["mutate-project", "write-back-project"],
};

const mutationKeys = (trusted, requestedOwner) => {
  const observed = trusted.root.vcs;
  if (observed.kind === "none") {
    return requestedOwner === null ? [`${trusted.deviceId}:root:${trusted.root.rootId}`] : null;
  }
  if (observed.kind === "unsupported") return null;
  if (observed.kind === "git" && requestedOwner !== "git") return null;
  if (observed.kind === "jj-git" && (observed.mutationOwner !== "jj" || requestedOwner !== "jj")) return null;
  return [
    `${trusted.deviceId}:checkout:${observed.checkoutId}`,
    `${trusted.deviceId}:repository:${observed.repositoryId}`,
  ].sort();
};

const intersects = (left, right) => left.some((key) => right.includes(key));
const receiptRecord = (operation, request, trusted, output, status) => ({
  actorId: trusted.actorId,
  collectionId: trusted.collectionId,
  deviceId: trusted.deviceId,
  operation,
  operationId: request.operationId,
  requestDigest: digestRequest(request),
  status,
  rootId: trusted.root.rootId,
  vcs: { ...trusted.root.vcs },
  output,
});

const authorize = (operation, trusted) => {
  if (!trusted.member) return false;
  return requiredCapability[operation].every((capability) => trusted.capabilities.includes(capability));
};

const scopedRecordsAreAuthorized = (operation, trusted) => {
  if (
    (
      ["export", "rebind", "admit-mutation", "authorize-write-back"].includes(operation) ||
      (operation === "register" && trusted.receipt !== null)
    ) &&
    trusted.binding !== null &&
    !inScope(trusted.binding, trusted)
  ) return false;
  if (
    ["register", "rebind"].includes(operation) &&
    trusted.existingRootBindings.some((item) => !inScope(item, trusted))
  ) return false;
  if (
    operation === "authorize-write-back" &&
    trusted.execution !== null &&
    trusted.execution.actorId !== trusted.actorId
  ) return false;
  return true;
};

const cannotIncrement = (value) => value === Number.MAX_SAFE_INTEGER;

const admissionReceiptMatchesRequest = (request, stored) => {
  if (stored.output.bindingId !== request.bindingId) return false;
  const observed = stored.vcs;
  let expectedKeys;
  if (observed.kind === "none") {
    if (request.requestedVcsOwner !== null) return false;
    expectedKeys = [`${stored.deviceId}:root:${stored.rootId}`];
  } else if (observed.kind === "git" && request.requestedVcsOwner === "git") {
    expectedKeys = [
      `${stored.deviceId}:checkout:${observed.checkoutId}`,
      `${stored.deviceId}:repository:${observed.repositoryId}`,
    ].sort();
  } else if (
    observed.kind === "jj-git" &&
    observed.mutationOwner === "jj" &&
    request.requestedVcsOwner === "jj"
  ) {
    expectedKeys = [
      `${stored.deviceId}:checkout:${observed.checkoutId}`,
      `${stored.deviceId}:repository:${observed.repositoryId}`,
    ].sort();
  } else {
    return false;
  }
  return same(stored.output.keys, expectedKeys);
};

const replay = (operation, request, trusted) => {
  const stored = trusted.receipt;
  if (stored === null) return null;
  if (
    stored.actorId !== trusted.actorId ||
    stored.collectionId !== trusted.collectionId ||
    stored.deviceId !== trusted.deviceId ||
    stored.operation !== operation ||
    stored.operationId !== request.operationId
  ) return refusal("invalid-input");
  if (stored.requestDigest !== digestRequest(request)) return refusal("operation-conflict");
  if (operation === "admit-mutation" && !admissionReceiptMatchesRequest(request, stored)) return refusal("invalid-input");
  if (stored.status !== "complete" || operation === "admit-mutation") return refusal("reconciliation-required");
  const currentBinding = trusted.binding;
  const currentPortable = trusted.portable;
  if (
    currentBinding === null ||
    currentPortable === null ||
    currentBinding.bindingId !== stored.output.bindingId ||
    currentBinding.projectId !== stored.output.projectId ||
    currentBinding.bindingRevision !== stored.output.bindingRevision ||
    currentBinding.rootId !== stored.rootId ||
    trusted.root.rootId !== stored.rootId ||
    currentPortable.projectId !== stored.output.projectId
  ) return refusal("superseded-operation");
  return accepted({ ...stored.output, replayed: true }, [], {});
};

/** Evaluate one validated synthetic operation without mutating external state. */
export function evaluateRegistryOperation(input) {
  try {
    validateRegistryInput(input);
  } catch (error) {
    if (error instanceof RegistryInputError) return refusal("invalid-input");
    throw error;
  }
  const { operation, request, trusted } = input;
  if (!authorize(operation, trusted) || !scopedRecordsAreAuthorized(operation, trusted)) return refusal("denied");
  if (request.expectedPolicyRevision !== trusted.policyRevision) return refusal("stale-policy");

  if (operation !== "export") {
    if (!trusted.rootAccess.includes(trusted.root.rootId)) return refusal("denied");
    if (!trusted.root.exists) return refusal("root-unavailable");
    if (!trusted.root.isDirectory) return refusal("not-directory");
    if (!trusted.root.identityVerified) return refusal("identity-unverified");
  }

  if (["register", "rebind", "admit-mutation"].includes(operation)) {
    const replayed = replay(operation, request, trusted);
    if (replayed !== null) return replayed;
  }

  if (operation === "export") {
    if (
      trusted.portable === null ||
      trusted.portable.projectId !== request.projectId ||
      trusted.binding === null ||
      trusted.binding.projectId !== request.projectId
    ) return refusal("binding-unavailable");
    return accepted({ code: "exported", project: portableProjection(trusted.portable) }, [], {});
  }

  if (operation === "register") {
    if (request.attachProjectId !== null) return refusal("attachment-required");
    if (!trusted.overlapSafe) return refusal("ambiguous-ownership");
    const matches = trusted.existingRootBindings.filter((item) =>
      item.collectionId === trusted.collectionId &&
      item.deviceId === trusted.deviceId &&
      item.rootId === trusted.root.rootId
    );
    if (new Set(matches.map((item) => item.bindingId)).size > 1) return refusal("ambiguous-ownership");
    if (matches.length === 1) {
      const existing = matches[0];
      const output = {
        code: "already-registered",
        projectId: existing.projectId,
        bindingId: existing.bindingId,
        bindingRevision: existing.bindingRevision,
        replayed: false,
      };
      if (request.expectedRegistryRevision !== trusted.registryRevision) return refusal("retry-state");
      if (cannotIncrement(trusted.registryRevision)) return refusal("invalid-input");
      return accepted(output, ["registry"], {
        registryRevision: trusted.registryRevision + 1,
        insertReceipt: receiptRecord(operation, request, trusted, output, "complete"),
      });
    }
    if (trusted.allocatedIdsInUse) return refusal("allocation-conflict");
    if (request.expectedRegistryRevision !== trusted.registryRevision) return refusal("retry-state");
    if (cannotIncrement(trusted.registryRevision)) return refusal("invalid-input");
    const output = {
      code: "registered",
      projectId: trusted.allocatedProjectId,
      bindingId: trusted.allocatedBindingId,
      bindingRevision: 1,
      replayed: false,
    };
    const insertPortable = {
      schemaVersion: 1,
      projectId: trusted.allocatedProjectId,
      displayName: request.displayName,
      contentIdentity: request.contentIdentity === null ? null : { ...request.contentIdentity },
    };
    const insertBinding = {
      bindingId: trusted.allocatedBindingId,
      projectId: trusted.allocatedProjectId,
      collectionId: trusted.collectionId,
      actorId: trusted.actorId,
      deviceId: trusted.deviceId,
      rootId: trusted.root.rootId,
      locationRef: request.locationRef,
      bindingRevision: 1,
      policyRevision: trusted.policyRevision,
      vcs: { ...trusted.root.vcs },
    };
    return accepted(output, ["registry"], {
      insertPortable,
      insertBinding,
      registryRevision: trusted.registryRevision + 1,
      insertReceipt: receiptRecord(operation, request, trusted, output, "complete"),
    });
  }

  const current = trusted.binding;
  if (current === null || current.bindingId !== request.bindingId) return refusal("binding-unavailable");
  if (current.bindingRevision !== request.expectedBindingRevision) return refusal("stale-binding");
  if ((operation === "admit-mutation" || operation === "authorize-write-back") && current.policyRevision !== trusted.policyRevision) {
    return refusal("stale-policy");
  }

  if (operation === "rebind") {
    if (trusted.root.rootId !== current.rootId) return refusal("root-replaced");
    if (trusted.existingRootBindings.some((item) =>
      item.bindingId !== current.bindingId &&
      (item.rootId === trusted.root.rootId || item.locationRef === request.locationRef)
    )) return refusal("root-conflict");
    if (request.expectedRegistryRevision !== trusted.registryRevision) return refusal("retry-state");
    if (cannotIncrement(trusted.registryRevision) || cannotIncrement(current.bindingRevision)) return refusal("invalid-input");
    const replaceBinding = {
      ...current,
      locationRef: request.locationRef,
      bindingRevision: current.bindingRevision + 1,
      policyRevision: trusted.policyRevision,
      vcs: { ...trusted.root.vcs },
    };
    const output = {
      code: "rebound",
      projectId: current.projectId,
      bindingId: current.bindingId,
      bindingRevision: replaceBinding.bindingRevision,
      replayed: false,
    };
    return accepted(output, ["registry"], {
      replaceBinding,
      registryRevision: trusted.registryRevision + 1,
      insertReceipt: receiptRecord(operation, request, trusted, output, "complete"),
    });
  }

  if (trusted.root.rootId !== current.rootId) {
    return refusal(operation === "authorize-write-back" ? "content-conflict" : "root-replaced");
  }
  if (trusted.root.locationRef !== current.locationRef) return refusal("stale-binding");
  if (!same(trusted.root.vcs, current.vcs)) return refusal("stale-binding");
  if (trusted.root.contentRevision !== request.expectedContentRevision) return refusal("content-conflict");
  const keys = mutationKeys(trusted, request.requestedVcsOwner);
  if (keys === null) return refusal("read-only");

  if (operation === "admit-mutation") {
    if (!trusted.overlapSafe) return refusal("ambiguous-ownership");
    const contenders = trusted.reservations.filter((item) => intersects(item.keys, keys));
    if (contenders.some((item) => item.state === "uncertain")) return refusal("reconciliation-required");
    if (contenders.length > 0) return refusal("busy");
    const highestFence = contenders.reduce((highest, item) => Math.max(highest, item.fence), 0);
    if (trusted.nextFence <= highestFence) return refusal("stale-fence");
    if (request.expectedRegistryRevision !== trusted.registryRevision) return refusal("retry-state");
    if (cannotIncrement(trusted.registryRevision)) return refusal("invalid-input");
    const output = {
      code: "admitted",
      bindingId: current.bindingId,
      keys,
      fence: trusted.nextFence,
      ownerOperationId: request.operationId,
    };
    const insertReservation = {
      keys,
      ownerActorId: trusted.actorId,
      ownerCollectionId: trusted.collectionId,
      ownerDeviceId: trusted.deviceId,
      ownerOperationId: request.operationId,
      state: "active",
      fence: trusted.nextFence,
    };
    return accepted(output, ["registry", "reservation"], {
      insertReservation,
      registryRevision: trusted.registryRevision + 1,
      insertReceipt: receiptRecord(operation, request, trusted, output, "pending"),
    });
  }

  const relevant = trusted.reservations.filter((item) => intersects(item.keys, keys));
  if (relevant.some((item) => item.state === "uncertain")) return refusal("reconciliation-required");
  if (relevant.some((item) =>
    item.ownerOperationId === request.operationId &&
    item.fence === request.fence &&
    (
      item.ownerActorId !== trusted.actorId ||
      item.ownerCollectionId !== trusted.collectionId ||
      item.ownerDeviceId !== trusted.deviceId
    )
  )) return refusal("denied");
  if (relevant.length !== 1) return refusal("stale-fence");
  const selectedReservation = relevant[0];
  if (!(
    selectedReservation.state === "active" &&
    selectedReservation.ownerActorId === trusted.actorId &&
    selectedReservation.ownerCollectionId === trusted.collectionId &&
    selectedReservation.ownerDeviceId === trusted.deviceId &&
    selectedReservation.ownerOperationId === request.operationId &&
    selectedReservation.fence === request.fence &&
    same(selectedReservation.keys, keys)
  )) return refusal("stale-fence");

  const run = trusted.execution;
  if (
    run === null ||
    run.projectId !== current.projectId ||
    run.bindingId !== current.bindingId ||
    run.executionCopyId !== request.executionCopyId
  ) return refusal("copy-mismatch");
  if (run.bindingRevision !== current.bindingRevision) return refusal("stale-binding");
  if (run.policyRevision !== trusted.policyRevision) return refusal("stale-policy");
  if (run.baseContentRevision !== request.expectedContentRevision) return refusal("content-conflict");
  if (!trusted.patchVerified) return refusal("patch-unverified");
  return accepted({
    code: "authorized",
    bindingId: current.bindingId,
    executionCopyId: request.executionCopyId,
    patchDigest: request.patchDigest,
    selectedPaths: [...request.selectedPaths],
    fence: request.fence,
  }, [], {});
}

const clone = (value) => structuredClone(value);
const receiptKey = (value) => [
  value.actorId, value.collectionId, value.deviceId, value.operation, value.operationId,
].join(":");

/**
 * Apply one immutable, compare-and-set transition to a plain in-memory state.
 * The state owns current records; caller-supplied trusted selections are refreshed
 * from it before evaluation.
 */
export function applyAtomicTransition(state, input) {
  exactKeys(state, ["registryRevision", "portables", "bindings", "receipts", "reservations"], "state");
  safeInteger(state.registryRevision, 0, "state.registryRevision");
  for (const field of ["portables", "bindings", "receipts", "reservations"]) {
    if (!Array.isArray(state[field])) invalid(`state.${field} must be an array`);
  }
  try {
    validateRegistryInput(input);
  } catch (error) {
    if (!(error instanceof RegistryInputError)) throw error;
    return { ...refusal("invalid-input"), state, committed: false };
  }
  const refreshed = clone(input);
  const trusted = refreshed.trusted;
  trusted.registryRevision = state.registryRevision;
  trusted.reservations = clone(state.reservations);
  trusted.receipt = clone(state.receipts.find((item) =>
    receiptKey(item) === receiptKey({
      actorId: trusted.actorId,
      collectionId: trusted.collectionId,
      deviceId: trusted.deviceId,
      operation: refreshed.operation,
      operationId: refreshed.request.operationId,
    })
  ) ?? null);

  if (refreshed.operation === "register") {
    trusted.existingRootBindings = clone(state.bindings.filter((item) =>
      item.collectionId === trusted.collectionId &&
      item.deviceId === trusted.deviceId &&
      item.rootId === trusted.root.rootId
    ));
    const selected = trusted.existingRootBindings.find((item) => item.actorId === trusted.actorId) ?? null;
    trusted.binding = clone(selected);
    trusted.portable = clone(selected === null ? null : state.portables.find((item) => item.projectId === selected.projectId) ?? null);
  } else if (refreshed.operation === "export") {
    trusted.portable = clone(state.portables.find((item) => item.projectId === refreshed.request.projectId) ?? null);
    const matchingBindings = state.bindings.filter((item) => item.projectId === refreshed.request.projectId);
    trusted.binding = clone(
      matchingBindings.find((item) => inScope(item, trusted)) ??
      matchingBindings[0] ??
      null
    );
  } else {
    trusted.binding = clone(state.bindings.find((item) => item.bindingId === refreshed.request.bindingId) ?? null);
    trusted.portable = clone(trusted.binding === null ? null : state.portables.find((item) => item.projectId === trusted.binding.projectId) ?? null);
    if (refreshed.operation === "rebind") {
      trusted.existingRootBindings = clone(state.bindings.filter((item) =>
        item.collectionId === trusted.collectionId &&
        item.deviceId === trusted.deviceId &&
        (item.rootId === trusted.root.rootId || item.locationRef === refreshed.request.locationRef)
      ));
    }
  }
  trusted.allocatedIdsInUse =
    state.portables.some((item) => item.projectId === trusted.allocatedProjectId) ||
    state.bindings.some((item) => item.bindingId === trusted.allocatedBindingId);

  const decision = evaluateRegistryOperation(refreshed);
  if (Object.keys(decision.recordChanges).length === 0) {
    return { ...decision, state, committed: false };
  }
  const next = clone(state);
  const changes = decision.recordChanges;
  if (changes.insertPortable) next.portables.push(clone(changes.insertPortable));
  if (changes.insertBinding) next.bindings.push(clone(changes.insertBinding));
  if (changes.replaceBinding) {
    const index = next.bindings.findIndex((item) => item.bindingId === changes.replaceBinding.bindingId);
    if (index < 0) invalid("Atomic replacement target disappeared");
    next.bindings[index] = clone(changes.replaceBinding);
  }
  if (changes.insertReceipt) next.receipts.push(clone(changes.insertReceipt));
  if (changes.insertReservation) next.reservations.push(clone(changes.insertReservation));
  if (changes.registryRevision !== undefined) next.registryRevision = changes.registryRevision;
  return { ...decision, state: next, committed: true };
}

const pointerParts = (pointer) => {
  if (typeof pointer !== "string" || !pointer.startsWith("/") || pointer === "/") invalid("Fixture JSON Pointer is invalid");
  return pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
};

/** Clone a fixture input and apply its generic JSON Pointer set/remove DSL. */
export function materializeFixtureCase(fixture, fixtureCase) {
  if (!isObject(fixture.inputs) || !Object.hasOwn(fixture.inputs, fixtureCase.inputRef)) invalid("Fixture inputRef is missing");
  const input = clone(fixture.inputs[fixtureCase.inputRef]);
  for (const mutation of fixtureCase.mutations ?? []) {
    exactKeys(mutation, mutation.op === "set" ? ["op", "pointer", "value"] : ["op", "pointer"], "fixture mutation");
    if (mutation.op !== "set" && mutation.op !== "remove") invalid("Fixture mutation operation is unsupported");
    const parts = pointerParts(mutation.pointer);
    const final = parts.pop();
    let parent = input;
    for (const part of parts) {
      if (!isObject(parent) || !Object.hasOwn(parent, part)) invalid("Fixture mutation parent is missing");
      parent = parent[part];
    }
    if (!isObject(parent)) invalid("Fixture mutation parent must be an object");
    if (mutation.op === "set") {
      Object.defineProperty(parent, final, {
        value: clone(mutation.value),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } else {
      if (!Object.hasOwn(parent, final)) invalid("Fixture remove target is missing");
      delete parent[final];
    }
  }
  return input;
}

const validateFixtureEnvelope = (fixture) => {
  exactKeys(fixture, ["fixtureVersion", "contract", "inputs", "cases"], "fixture");
  if (fixture.fixtureVersion !== 1 || fixture.contract !== "vivary.project-registry-contract.v1") invalid("Fixture version is unsupported");
  if (!isObject(fixture.inputs) || !Array.isArray(fixture.cases)) invalid("Fixture inputs or cases are invalid");
};

export function checkFixture(fixture) {
  validateFixtureEnvelope(fixture);
  const caseIds = new Set();
  for (const fixtureCase of fixture.cases) {
    exactKeys(fixtureCase, ["id", "rules", "inputRef", "mutations", "expect"], "fixture case");
    id(fixtureCase.id, "fixture case id");
    if (caseIds.has(fixtureCase.id)) invalid(`Duplicate fixture case ID ${fixtureCase.id}`);
    caseIds.add(fixtureCase.id);
  }
  return fixture.cases.map((fixtureCase) => {
    const actual = evaluateRegistryOperation(materializeFixtureCase(fixture, fixtureCase));
    return {
      id: fixtureCase.id,
      pass: same(actual.output, fixtureCase.expect.output) &&
        same(actual.effects, fixtureCase.expect.effects) &&
        same(actual.recordChanges, fixtureCase.expect.recordChanges),
    };
  });
}

async function cli(argv) {
  const fixtureIndex = argv.indexOf("--fixture");
  if (fixtureIndex < 0 || typeof argv[fixtureIndex + 1] !== "string" || !argv.includes("--check")) {
    console.error("usage: node registry_contract_model.mjs --fixture PATH --check");
    return 2;
  }
  const { readFile } = await import("node:fs/promises");
  let fixture;
  try {
    fixture = parseStrictJson(await readFile(argv[fixtureIndex + 1], "utf8"));
  } catch (error) {
    console.error(`fixture: FAIL (${error instanceof RegistryInputError ? "invalid JSON" : "unavailable"})`);
    return 1;
  }
  let results;
  try {
    results = checkFixture(fixture);
  } catch (error) {
    console.error(`fixture: FAIL (${error instanceof RegistryInputError ? "invalid fixture" : "evaluation error"})`);
    return 1;
  }
  for (const result of results) console.log(`${result.id}: ${result.pass ? "PASS" : "FAIL"}`);
  const passed = results.filter((result) => result.pass).length;
  console.log(`aggregate: ${passed}/${results.length} passed`);
  return passed === results.length ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await cli(process.argv.slice(2));
}
