import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  RegistryInputError,
  applyAtomicTransition,
  checkFixture,
  digestRequest,
  evaluateRegistryOperation,
  materializeFixtureCase,
  parseStrictJson,
  validateRegistryInput,
} from "../registry_contract_model.mjs";

const fixturePath = process.env.PROJECT_REGISTRY_FIXTURE ??
  path.resolve(process.cwd(), "docs/product/multi-project/fixtures/project-registry.json");
const fixture = parseStrictJson(await readFile(fixturePath, "utf8"));
const base = (name) => structuredClone(fixture.inputs[name]);
const decision = (input) => evaluateRegistryOperation(structuredClone(input));

test("the generic fixture DSL evaluates all 61 exact outputs, effects, and record changes", () => {
  assert.equal(fixture.cases.length, 61);
  const results = checkFixture(fixture);
  assert.deepEqual(results.filter((result) => !result.pass), []);
  for (const fixtureCase of fixture.cases) {
    const input = materializeFixtureCase(fixture, fixtureCase);
    const before = structuredClone(input);
    assert.deepEqual(decision(input), fixtureCase.expect, fixtureCase.id);
    assert.deepEqual(input, before, `${fixtureCase.id} mutated its input`);
  }
});

test("strict JSON parsing rejects malformed text, duplicate keys, and unpaired surrogates", () => {
  for (const text of [
    '{"operation":"register",}',
    '{"operation":"register","operation":"export"}',
    '{"outer":{"key":1,"key":2}}',
    '{"text":"\\ud800"}',
    '{"text":"\\udc00"}',
    '{"number":01}',
    '{"unterminated":true',
  ]) {
    assert.throws(() => parseStrictJson(text), RegistryInputError, text);
  }
  assert.deepEqual(parseStrictJson('{"emoji":"\\ud83d\\ude80","array":[true,null,-2.5e2]}'), {
    emoji: "🚀",
    array: [true, null, -250],
  });
});

test("boundary validation rejects unknown fields, missing fields, types, versions, IDs, and revisions", () => {
  const mutations = [
    (input) => { input.extra = true; },
    (input) => { delete input.request.operationId; },
    (input) => { input.request.expectedRegistryRevision = "7"; },
    (input) => { input.request.operationId = "contains:separator"; },
    (input) => { input.request.expectedPolicyRevision = 0; },
    (input) => { input.trusted.extra = true; },
    (input) => { input.trusted.portable = { schemaVersion: 2, projectId: "project-a", displayName: "x", contentIdentity: null }; },
    (input) => { input.trusted.root.vcs.repositoryId = "repository-a"; },
    (input) => { input.trusted.capabilities.push("invented-capability"); },
  ];
  for (const mutate of mutations) {
    const input = base("register");
    mutate(input);
    assert.deepEqual(decision(input), { output: { code: "invalid-input" }, effects: [], recordChanges: {} });
    assert.throws(() => validateRegistryInput(input), RegistryInputError);
  }
});

test("jj-git requires valid private Jujutsu identities and other kinds reject them", () => {
  const jjVcs = {
    kind: "jj-git",
    repositoryId: "repository-a",
    checkoutId: "checkout-a",
    jjRepositoryId: "jj-repository-a",
    jjWorkspaceId: "jj-workspace-a",
    mutationOwner: "jj",
  };
  for (const field of ["jjRepositoryId", "jjWorkspaceId"]) {
    for (const mutate of [
      (input) => { delete input.trusted.root.vcs[field]; },
      (input) => { input.trusted.root.vcs[field] = null; },
      (input) => { input.trusted.root.vcs[field] = "contains:separator"; },
    ]) {
      const input = base("admit");
      input.request.requestedVcsOwner = "jj";
      input.trusted.root.vcs = structuredClone(jjVcs);
      input.trusted.binding.vcs = structuredClone(jjVcs);
      mutate(input);
      assert.equal(decision(input).output.code, "invalid-input", field);
      assert.throws(() => validateRegistryInput(input), RegistryInputError, field);
    }
  }

  const nonJjShapes = [
    { kind: "none", repositoryId: null, checkoutId: null, mutationOwner: null },
    { kind: "git", repositoryId: "repository-a", checkoutId: "checkout-a", mutationOwner: "git" },
    { kind: "unsupported", repositoryId: null, checkoutId: null, mutationOwner: null },
  ];
  for (const vcs of nonJjShapes) {
    for (const field of ["jjRepositoryId", "jjWorkspaceId"]) {
      const input = base("admit");
      input.trusted.root.vcs = { ...vcs, [field]: "private-jj-id" };
      assert.equal(decision(input).output.code, "invalid-input", vcs.kind + ":" + field);
      assert.throws(() => validateRegistryInput(input), RegistryInputError, vcs.kind + ":" + field);
    }
  }
});

test("direct object validation rejects an unpaired surrogate display name", () => {
  const input = base("register");
  input.request.displayName = "\uD800";
  assert.equal(decision(input).output.code, "invalid-input");
  assert.throws(() => validateRegistryInput(input), RegistryInputError);
});

test("write-back paths are normalized, relative, POSIX, safe, and duplicate-free", () => {
  const unsafeSets = [
    [],
    ["/absolute.txt"],
    ["../outside.txt"],
    ["docs/../outside.txt"],
    ["docs/./note.txt"],
    ["docs\\note.txt"],
    ["docs//note.txt"],
    ["docs/note.txt", "docs/note.txt"],
    ["docs/\0note.txt"],
    ["docs/\ud800.txt"],
  ];
  for (const selectedPaths of unsafeSets) {
    const input = base("writeback");
    input.request.selectedPaths = selectedPaths;
    assert.equal(decision(input).output.code, "invalid-input", JSON.stringify(selectedPaths));
  }
  const valid = base("writeback");
  valid.request.selectedPaths = ["docs/notes/東京.txt", "README.md"];
  assert.equal(decision(valid).output.code, "authorized");
});

for (const selectedPath of ["C:/escape.txt", "C:escape.txt"]) {
  test(`write-back rejects Windows drive path ${selectedPath}`, () => {
    const input = base("writeback");
    input.request.selectedPaths = [selectedPath];
    assert.equal(decision(input).output.code, "invalid-input");
  });
}

test("canonical request digests are recursively ordered and cover Unicode and JSON escapes", () => {
  const request = base("register").request;
  assert.equal(
    digestRequest(request),
    "b05fdc667476ebd3787e5779e2dc0b2156abf0649a2417de4d263a6e7f0f01bc",
  );
  request.displayName = 'Café 東京\n"quoted"\\path\tend';
  const reversed = Object.fromEntries(Object.entries(request).reverse());
  assert.equal(digestRequest(request), digestRequest(reversed));
  assert.notEqual(digestRequest(request), digestRequest(base("register").request));
  const contentFirst = {
    ...request,
    contentIdentity: {
      manifestDigest: "b".repeat(64),
      algorithm: "sha256",
    },
  };
  const algorithmFirst = {
    ...request,
    contentIdentity: {
      algorithm: "sha256",
      manifestDigest: "b".repeat(64),
    },
  };
  assert.equal(digestRequest(contentFirst), digestRequest(algorithmFirst));
});

test("export constructs a fresh portable allowlist and omits all local sentinels", () => {
  const input = base("export");
  const result = decision(input);
  assert.deepEqual(result.output.project, {
    schemaVersion: 1,
    projectId: "project-a",
    displayName: "Example project",
    contentIdentity: null,
  });
  assert.notEqual(result.output.project, input.trusted.portable);
  const serialized = JSON.stringify(result.output);
  for (const sentinel of Object.values(input.trusted.privateState)) {
    assert.equal(serialized.includes(sentinel), false);
  }
  result.output.project.displayName = "changed export";
  assert.equal(input.trusted.portable.displayName, "Example project");
});

test("export requires a matching local binding", () => {
  const missing = base("export");
  missing.trusted.binding = null;
  assert.equal(decision(missing).output.code, "binding-unavailable");

  const mismatched = base("export");
  mismatched.trusted.binding.projectId = "project-other";
  assert.equal(decision(mismatched).output.code, "binding-unavailable");
});

test("export ignores operation-irrelevant foreign observations", () => {
  const input = base("export");
  input.trusted.existingRootBindings = [{
    ...structuredClone(input.trusted.binding),
    bindingId: "binding-foreign",
    actorId: "actor-foreign",
  }];
  input.trusted.execution = {
    sessionId: "session-foreign",
    actorId: "actor-foreign",
    projectId: "project-foreign",
    bindingId: "binding-foreign",
    bindingRevision: 1,
    policyRevision: 1,
    executionCopyId: "copy-foreign",
    baseContentRevision: "content-a",
  };
  assert.equal(decision(input).output.code, "exported");
});

test("strict JSON preserves unknown __proto__ keys so boundary validation rejects them", () => {
  const json = JSON.stringify(base("register"));
  for (const injected of [
    json.replace("{", '{"__proto__":{"polluted":true},'),
    json.replace('"request":{', '"request":{"__proto__":{"polluted":true},'),
  ]) {
    const parsed = parseStrictJson(injected);
    const target = Object.hasOwn(parsed, "__proto__") ? parsed : parsed.request;
    assert.equal(Object.hasOwn(target, "__proto__"), true);
    assert.equal(decision(parsed).output.code, "invalid-input");
  }
});

const pendingAdmissionReceipt = (input, overrides = {}) => ({
  actorId: input.trusted.actorId,
  collectionId: input.trusted.collectionId,
  deviceId: input.trusted.deviceId,
  operation: "admit-mutation",
  operationId: input.request.operationId,
  requestDigest: digestRequest(input.request),
  status: "pending",
  rootId: overrides.rootId ?? input.trusted.root.rootId,
  vcs: structuredClone(overrides.vcs ?? input.trusted.root.vcs),
  output: {
    code: "admitted",
    bindingId: overrides.bindingId ?? input.request.bindingId,
    keys: overrides.keys ?? ["device-a:checkout:checkout-a", "device-a:repository:repository-a"],
    fence: 8,
    ownerOperationId: overrides.ownerOperationId ?? input.request.operationId,
  },
});

test("admission receipts require complete sorted keys and their own operation owner", () => {
  const variants = [
    { keys: [], ownerOperationId: "op-mutate" },
    { keys: ["device-a:checkout:checkout-a"], ownerOperationId: "op-mutate" },
    { keys: ["device-b:checkout:checkout-a", "device-b:repository:repository-a"], ownerOperationId: "op-mutate" },
    { keys: ["device-a:repository:repository-a", "device-a:checkout:checkout-a"], ownerOperationId: "op-mutate" },
    { keys: ["device-a:checkout:checkout-a", "device-a:repository:repository-a"], ownerOperationId: "other-operation" },
    { keys: ["device-a:checkout:checkout-other", "device-a:repository:repository-other"], ownerOperationId: "op-mutate" },
  ];
  for (const variant of variants) {
    const input = base("admit");
    input.trusted.receipt = pendingAdmissionReceipt(input, variant);
    assert.equal(decision(input).output.code, "invalid-input");
  }
});

test("fixture set creates prototype-named fields as own properties", () => {
  const input = materializeFixtureCase(fixture, {
    inputRef: "register",
    mutations: [{
      op: "set",
      pointer: "/request/__proto__",
      value: { polluted: true },
    }],
  });
  assert.equal(Object.hasOwn(input.request, "__proto__"), true);
  assert.equal(decision(input).output.code, "invalid-input");
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
});

test("fixture validation rejects duplicate case IDs", () => {
  const duplicated = structuredClone(fixture);
  duplicated.cases[1].id = duplicated.cases[0].id;
  duplicated.cases[0].inputRef = "missing-input";
  assert.throws(
    () => checkFixture(duplicated),
    (error) => error instanceof RegistryInputError && /Duplicate fixture case ID/.test(error.message),
  );
});

test("admission receipt semantics bind to its digested request, not later root observations", () => {
  const ownerForm = base("admit");
  ownerForm.trusted.receipt = pendingAdmissionReceipt(ownerForm, { keys: ["device-a:root:root-a"] });
  assert.equal(decision(ownerForm).output.code, "invalid-input");

  const wrongRoot = base("admit");
  wrongRoot.request.requestedVcsOwner = null;
  wrongRoot.trusted.receipt = pendingAdmissionReceipt(wrongRoot, { keys: ["device-a:root:root-other"] });
  assert.equal(decision(wrongRoot).output.code, "invalid-input");

  const wrongBinding = base("admit");
  wrongBinding.trusted.receipt = pendingAdmissionReceipt(wrongBinding, { bindingId: "binding-other" });
  assert.equal(decision(wrongBinding).output.code, "invalid-input");

  const changedRequest = base("admit");
  changedRequest.trusted.receipt = pendingAdmissionReceipt(changedRequest);
  changedRequest.request.requestedVcsOwner = null;
  assert.equal(decision(changedRequest).output.code, "operation-conflict");

  const historical = base("admit");
  historical.request.requestedVcsOwner = null;
  historical.trusted.receipt = pendingAdmissionReceipt(historical, {
    keys: ["device-a:root:root-a"],
    vcs: {
      kind: "none",
      repositoryId: null,
      checkoutId: null,
      mutationOwner: null,
    },
  });
  historical.trusted.root.rootId = "root-current";
  historical.trusted.root.contentRevision = "content-current";
  historical.trusted.root.vcs = {
    kind: "none",
    repositoryId: null,
    checkoutId: null,
    mutationOwner: null,
  };
  historical.trusted.rootAccess.push("root-current");
  assert.equal(decision(historical).output.code, "reconciliation-required");

  const historicalGit = base("admit");
  historicalGit.trusted.receipt = pendingAdmissionReceipt(historicalGit);
  historicalGit.trusted.root.vcs.repositoryId = "repository-current";
  historicalGit.trusted.root.vcs.checkoutId = "checkout-current";
  assert.equal(decision(historicalGit).output.code, "reconciliation-required");
});

test("write-back requires one complete reservation", () => {
  const split = base("writeback");
  split.trusted.reservations = [
    {
      keys: ["device-a:checkout:checkout-a"],
      ownerActorId: "actor-a",
      ownerCollectionId: "collection-a",
      ownerDeviceId: "device-a",
      ownerOperationId: "op-mutate",
      state: "active",
      fence: 8,
    },
    {
      keys: ["device-a:repository:repository-a"],
      ownerActorId: "actor-a",
      ownerCollectionId: "collection-a",
      ownerDeviceId: "device-a",
      ownerOperationId: "op-mutate",
      state: "active",
      fence: 8,
    },
  ];
  assert.equal(decision(split).output.code, "stale-fence");
});

test("write-back refuses conflicting active ownership and permits disjoint reservations", () => {
  const conflict = base("writeback");
  const newerOwner = structuredClone(conflict.trusted.reservations[0]);
  newerOwner.ownerOperationId = "operation-new-owner";
  newerOwner.fence += 1;
  conflict.trusted.reservations.push(newerOwner);
  assert.equal(decision(conflict).output.code, "stale-fence");

  const disjoint = base("writeback");
  const otherRoot = structuredClone(disjoint.trusted.reservations[0]);
  otherRoot.keys = [
    "device-a:checkout:checkout-other",
    "device-a:repository:repository-other",
  ];
  otherRoot.ownerOperationId = "operation-other-root";
  otherRoot.fence += 1;
  disjoint.trusted.reservations.push(otherRoot);
  assert.equal(decision(disjoint).output.code, "authorized");
});

test("write-back reservation ownership is bound to the authenticated scope", () => {
  const foreignActor = base("writeback");
  foreignActor.trusted.actorId = "actor-b";
  foreignActor.trusted.binding.actorId = "actor-b";
  foreignActor.trusted.execution.actorId = "actor-b";
  assert.equal(decision(foreignActor).output.code, "denied");
});

for (const name of ["admit", "writeback"]) {
  test(`${name} is invalid after relocation until the binding is rebound`, () => {
    const input = base(name);
    input.trusted.root.locationRef = "location-moved";
    assert.equal(decision(input).output.code, "stale-binding", name);
  });
}

test("nonincrementable revisions refuse new writes while reads and safe increments remain valid", () => {
  const noChanges = { output: { code: "invalid-input" }, effects: [], recordChanges: {} };
  const registerMax = base("register");
  registerMax.request.expectedRegistryRevision = Number.MAX_SAFE_INTEGER;
  registerMax.trusted.registryRevision = Number.MAX_SAFE_INTEGER;
  assert.equal(decision(registerMax).output.code, "invalid-input");

  const duplicateMax = base("register");
  duplicateMax.request.expectedRegistryRevision = Number.MAX_SAFE_INTEGER;
  duplicateMax.trusted.registryRevision = Number.MAX_SAFE_INTEGER;
  duplicateMax.trusted.existingRootBindings = [structuredClone(base("export").trusted.binding)];
  assert.deepEqual(decision(duplicateMax), noChanges);

  const registerSafe = base("register");
  registerSafe.request.expectedRegistryRevision = Number.MAX_SAFE_INTEGER - 1;
  registerSafe.trusted.registryRevision = Number.MAX_SAFE_INTEGER - 1;
  assert.equal(decision(registerSafe).recordChanges.registryRevision, Number.MAX_SAFE_INTEGER);

  const rebindRegistryMax = base("rebind");
  rebindRegistryMax.request.expectedRegistryRevision = Number.MAX_SAFE_INTEGER;
  rebindRegistryMax.trusted.registryRevision = Number.MAX_SAFE_INTEGER;
  assert.equal(decision(rebindRegistryMax).output.code, "invalid-input");

  const rebindBindingMax = base("rebind");
  rebindBindingMax.request.expectedBindingRevision = Number.MAX_SAFE_INTEGER;
  rebindBindingMax.trusted.binding.bindingRevision = Number.MAX_SAFE_INTEGER;
  assert.equal(decision(rebindBindingMax).output.code, "invalid-input");

  const admissionMax = base("admit");
  admissionMax.request.expectedRegistryRevision = Number.MAX_SAFE_INTEGER;
  admissionMax.trusted.registryRevision = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(decision(admissionMax), noChanges);

  const rebindSafe = base("rebind");
  rebindSafe.request.expectedRegistryRevision = Number.MAX_SAFE_INTEGER - 1;
  rebindSafe.trusted.registryRevision = Number.MAX_SAFE_INTEGER - 1;
  rebindSafe.request.expectedBindingRevision = Number.MAX_SAFE_INTEGER - 1;
  rebindSafe.trusted.binding.bindingRevision = Number.MAX_SAFE_INTEGER - 1;
  assert.equal(decision(rebindSafe).recordChanges.registryRevision, Number.MAX_SAFE_INTEGER);
  assert.equal(decision(rebindSafe).recordChanges.replaceBinding.bindingRevision, Number.MAX_SAFE_INTEGER);

  const read = base("export");
  read.trusted.registryRevision = Number.MAX_SAFE_INTEGER;
  assert.equal(decision(read).output.code, "exported");
});

test("registration replay reauthorizes its selected binding scope while a fresh register ignores that field", () => {
  const fixtureCase = fixture.cases.find((item) => item.id === "same-operation-replayed");
  assert.ok(fixtureCase, "same-operation-replayed fixture case is required");
  for (const field of ["actorId", "collectionId", "deviceId"]) {
    const replayInput = materializeFixtureCase(fixture, fixtureCase);
    replayInput.trusted.binding[field] = `${field}-foreign`;
    replayInput.trusted.existingRootBindings = [];
    assert.equal(decision(replayInput).output.code, "denied", field);
  }

  const fresh = base("register");
  fresh.trusted.binding = structuredClone(base("export").trusted.binding);
  fresh.trusted.binding.actorId = "actor-foreign";
  assert.equal(decision(fresh).output.code, "registered");
});

const emptyState = (registryRevision = 7) => ({
  registryRevision,
  portables: [],
  bindings: [],
  receipts: [],
  reservations: [],
});

for (const [name, input] of [
  ["null", null],
  ["empty object", {}],
  ["partial object", { operation: "register" }],
]) {
  test(`atomic transitions reject a ${name} operation envelope without changing state`, () => {
    const state = emptyState();
    assert.deepEqual(applyAtomicTransition(state, input), {
      output: { code: "invalid-input" },
      effects: [],
      recordChanges: {},
      state,
      committed: false,
    });
  });
}

const registration = ({ operationId, projectId, bindingId, expectedRegistryRevision = 7 }) => {
  const input = base("register");
  input.request.operationId = operationId;
  input.request.expectedRegistryRevision = expectedRegistryRevision;
  input.trusted.allocatedProjectId = projectId;
  input.trusted.allocatedBindingId = bindingId;
  return input;
};

test("same-root contenders converge in either order and a lost compare-and-set writes nothing", () => {
  const schedules = [
    [registration({ operationId: "op-a", projectId: "project-a", bindingId: "binding-a" }),
      registration({ operationId: "op-b", projectId: "project-b", bindingId: "binding-b" })],
    [registration({ operationId: "op-b", projectId: "project-b", bindingId: "binding-b" }),
      registration({ operationId: "op-a", projectId: "project-a", bindingId: "binding-a" })],
  ];
  for (const [winner, contender] of schedules) {
    const first = applyAtomicTransition(emptyState(), winner);
    assert.equal(first.output.code, "registered");
    assert.equal(first.committed, true);

    const stale = applyAtomicTransition(first.state, contender);
    assert.equal(stale.output.code, "retry-state");
    assert.equal(stale.committed, false);
    assert.equal(stale.state, first.state);

    const retry = structuredClone(contender);
    retry.request.expectedRegistryRevision = first.state.registryRevision;
    const converged = applyAtomicTransition(first.state, retry);
    assert.equal(converged.output.code, "already-registered");
    assert.equal(converged.output.projectId, first.output.projectId);
    assert.equal(converged.output.bindingId, first.output.bindingId);
    assert.equal(converged.state.portables.length, 1);
    assert.equal(converged.state.bindings.length, 1);
    assert.equal(converged.state.receipts.length, 2);
  }
});

const mutationInput = ({ suffix, repositoryId, checkoutId, expectedRegistryRevision, nextFence }) => {
  const input = base("admit");
  input.request.operationId = `op-${suffix}`;
  input.request.bindingId = `binding-${suffix}`;
  input.request.expectedRegistryRevision = expectedRegistryRevision;
  input.trusted.nextFence = nextFence;
  input.trusted.root.rootId = `root-${suffix}`;
  input.trusted.root.locationRef = `location-${suffix}`;
  input.trusted.root.vcs.repositoryId = repositoryId;
  input.trusted.root.vcs.checkoutId = checkoutId;
  input.trusted.binding.bindingId = `binding-${suffix}`;
  input.trusted.binding.projectId = `project-${suffix}`;
  input.trusted.binding.rootId = `root-${suffix}`;
  input.trusted.binding.locationRef = `location-${suffix}`;
  input.trusted.binding.vcs.repositoryId = repositoryId;
  input.trusted.binding.vcs.checkoutId = checkoutId;
  input.trusted.portable.projectId = `project-${suffix}`;
  if (!input.trusted.rootAccess.includes(`root-${suffix}`)) input.trusted.rootAccess.push(`root-${suffix}`);
  return input;
};

const stateForMutationInputs = (...inputs) => ({
  registryRevision: 7,
  portables: inputs.map((input) => structuredClone(input.trusted.portable)),
  bindings: inputs.map((input) => structuredClone(input.trusted.binding)),
  receipts: [],
  reservations: [],
});

test("repository contenders serialize in both orders, while disjoint repositories proceed", () => {
  for (const order of [["a", "b"], ["b", "a"]]) {
    const inputs = {
      a: mutationInput({ suffix: "a", repositoryId: "repository-common", checkoutId: "checkout-a", expectedRegistryRevision: 7, nextFence: 8 }),
      b: mutationInput({ suffix: "b", repositoryId: "repository-common", checkoutId: "checkout-b", expectedRegistryRevision: 7, nextFence: 9 }),
    };
    const initial = stateForMutationInputs(inputs.a, inputs.b);
    const winner = applyAtomicTransition(initial, inputs[order[0]]);
    assert.equal(winner.output.code, "admitted");
    const blocked = applyAtomicTransition(winner.state, inputs[order[1]]);
    assert.equal(blocked.output.code, "busy");
    assert.equal(blocked.committed, false);
    assert.equal(blocked.state, winner.state);
    assert.equal(winner.state.reservations.length, 1);
    assert.equal(winner.state.receipts.length, 1);
  }

  const common = mutationInput({ suffix: "a", repositoryId: "repository-common", checkoutId: "checkout-a", expectedRegistryRevision: 7, nextFence: 8 });
  const disjoint = mutationInput({ suffix: "c", repositoryId: "repository-c", checkoutId: "checkout-c", expectedRegistryRevision: 8, nextFence: 9 });
  const first = applyAtomicTransition(stateForMutationInputs(common, disjoint), common);
  const second = applyAtomicTransition(first.state, disjoint);
  assert.equal(second.output.code, "admitted");
  assert.equal(second.state.reservations.length, 2);
  assert.equal(second.state.receipts.length, 2);
});

test("uncertain ownership and a crash after intent preserve quarantine and require reconciliation", () => {
  const input = mutationInput({ suffix: "a", repositoryId: "repository-a", checkoutId: "checkout-a", expectedRegistryRevision: 7, nextFence: 8 });
  const uncertainState = stateForMutationInputs(input);
  uncertainState.reservations.push({
    keys: ["device-a:checkout:checkout-a", "device-a:repository:repository-a"],
    ownerActorId: "actor-other",
    ownerCollectionId: "collection-a",
    ownerDeviceId: "device-a",
    ownerOperationId: "other-operation",
    state: "uncertain",
    fence: 7,
  });
  const quarantined = applyAtomicTransition(uncertainState, input);
  assert.equal(quarantined.output.code, "reconciliation-required");
  assert.equal(quarantined.state, uncertainState);

  const admitted = applyAtomicTransition(stateForMutationInputs(input), input);
  assert.equal(admitted.output.code, "admitted");
  assert.equal(admitted.state.receipts[0].status, "pending");
  const retryAfterCrash = applyAtomicTransition(admitted.state, input);
  assert.equal(retryAfterCrash.output.code, "reconciliation-required");
  assert.equal(retryAfterCrash.state, admitted.state);
  assert.equal(retryAfterCrash.state.reservations.length, 1);
  assert.equal(retryAfterCrash.state.receipts.length, 1);
});

test("a rebind retry reauthorizes only its still-current bound result", () => {
  const input = base("rebind");
  const state = {
    registryRevision: 7,
    portables: [structuredClone(input.trusted.portable)],
    bindings: [structuredClone(input.trusted.binding)],
    receipts: [],
    reservations: [],
  };
  const moved = applyAtomicTransition(state, input);
  assert.equal(moved.output.code, "rebound");
  const replayed = applyAtomicTransition(moved.state, input);
  assert.deepEqual(replayed.output, { ...moved.output, replayed: true });
  assert.equal(replayed.state, moved.state);

  const later = structuredClone(moved.state);
  later.bindings[0].bindingRevision += 1;
  assert.equal(applyAtomicTransition(later, input).output.code, "superseded-operation");
  const removed = structuredClone(moved.state);
  removed.bindings = [];
  assert.equal(applyAtomicTransition(removed, input).output.code, "superseded-operation");
});

test("atomic rebind detects an occupied destination even when it has another root identity", () => {
  const input = base("rebind");
  const occupied = {
    ...structuredClone(input.trusted.binding),
    bindingId: "binding-occupied",
    projectId: "project-occupied",
    rootId: "root-occupied",
    locationRef: "location-new",
  };
  const state = {
    registryRevision: 7,
    portables: [
      structuredClone(input.trusted.portable),
      { schemaVersion: 1, projectId: "project-occupied", displayName: "Occupied", contentIdentity: null },
    ],
    bindings: [structuredClone(input.trusted.binding), occupied],
    receipts: [],
    reservations: [],
  };
  const result = applyAtomicTransition(state, input);
  assert.equal(result.output.code, "root-conflict");
  assert.equal(result.committed, false);
  assert.equal(result.state, state);
});

test("atomic export resolves an in-scope binding independent of record order", () => {
  const input = base("export");
  const own = structuredClone(input.trusted.binding);
  const foreign = { ...structuredClone(own), bindingId: "binding-foreign", actorId: "actor-foreign" };
  for (const bindings of [[foreign, own], [own, foreign]]) {
    const state = {
      registryRevision: 7,
      portables: [structuredClone(input.trusted.portable)],
      bindings,
      receipts: [],
      reservations: [],
    };
    assert.equal(applyAtomicTransition(state, input).output.code, "exported");
  }
  const foreignOnly = {
    registryRevision: 7,
    portables: [structuredClone(input.trusted.portable)],
    bindings: [foreign],
    receipts: [],
    reservations: [],
  };
  assert.equal(applyAtomicTransition(foreignOnly, input).output.code, "denied");
});

test("all refusals preserve atomic state, including overlap and stale fence cases", () => {
  const overlap = base("register");
  overlap.trusted.overlapSafe = false;
  const registrationState = emptyState();
  const refused = applyAtomicTransition(registrationState, overlap);
  assert.equal(refused.output.code, "ambiguous-ownership");
  assert.equal(refused.state, registrationState);

  const writeback = base("writeback");
  writeback.request.fence = 7;
  assert.equal(decision(writeback).output.code, "stale-fence");
});

const mutationDefinitions = {
  "path-dedup": (source) => source.replaceAll(
    "item.rootId === trusted.root.rootId",
    "item.locationRef === trusted.root.locationRef",
  ),
  "missing-repository-key": (source) => source.replace(
    "    `${trusted.deviceId}:repository:${observed.repositoryId}`,\n",
    "",
  ),
  "trusted-export": (source) => source.replace(
    "project: portableProjection(trusted.portable)",
    "project: structuredClone(trusted)",
  ),
  "accept-stale-fence": (source) => source
    .replaceAll("item.fence === request.fence", "item.fence >= request.fence")
    .replace("selectedReservation.fence === request.fence", "selectedReservation.fence >= request.fence"),
};

test("deliberate contract mutants are killed by the fixture oracle", async (context) => {
  const selected = process.env.REGISTRY_MODEL_MUTATION;
  if (selected && !Object.hasOwn(mutationDefinitions, selected)) {
    assert.fail(`Unknown REGISTRY_MODEL_MUTATION ${selected}`);
  }
  const definitions = Object.entries(mutationDefinitions).filter(([name]) => !selected || name === selected);
  const sourcePath = fileURLToPath(new URL("../registry_contract_model.mjs", import.meta.url));
  const source = await readFile(sourcePath, "utf8");
  const directory = await mkdtemp(path.join(tmpdir(), "registry-model-mutants-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));

  for (const [name, mutate] of definitions) {
    await context.test(name, async () => {
      const mutantSource = mutate(source);
      assert.notEqual(mutantSource, source, `${name} mutation did not alter the evaluator`);
      const mutantPath = path.join(directory, `${name}.mjs`);
      await writeFile(mutantPath, mutantSource, "utf8");
      const mutant = await import(`${pathToFileURL(mutantPath).href}?run=${Date.now()}-${name}`);
      const results = mutant.checkFixture(fixture);
      assert.ok(results.some((result) => !result.pass), `${name} survived all 61 fixture cases`);
    });
  }
});
