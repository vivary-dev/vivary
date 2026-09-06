import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  StrictJsonError,
  canonicalJson,
  digestManifest,
  parseStrictJson,
  restoreSourcePreservation,
  runFixture,
} from "../prove_multi_project_source_preservation.mjs";

const fixturePath = process.env.SOURCE_PRESERVATION_FIXTURE ??
  path.resolve(process.cwd(), "docs/product/multi-project/fixtures/source-preservation.json");
const fixture = parseStrictJson(await readFile(fixturePath, "utf8"));
const baseManifest = () => structuredClone(fixture.manifests.base);
const fixtureWithOnlyCase = (id) => {
  const selected = structuredClone(fixture);
  selected.cases = [structuredClone(fixture.cases.find((fixtureCase) => fixtureCase.id === id))];
  return selected;
};

const makeSandbox = async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "vivary-restore-test-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const roots = Object.fromEntries(
    ["source", "target", "temp", "receipt"].map((name) => [name, path.join(root, name)]),
  );
  for (const directory of Object.values(roots)) await mkdir(directory);
  await mkdir(path.join(roots.source, "docs"));
  await mkdir(path.join(roots.source, "assets"));
  await mkdir(path.join(roots.source, "unselected"));
  await writeFile(path.join(roots.source, "docs", "note.txt"), Buffer.from("abc"));
  await writeFile(path.join(roots.source, "assets", "empty.bin"), Buffer.alloc(0));
  await writeFile(path.join(roots.source, "unselected", "keep.txt"), Buffer.from("keep"));
  return { root, roots };
};

const operation = (roots, manifest = baseManifest(), overrides = {}) => ({
  manifestText: canonicalJson(manifest),
  sourceRoot: roots.source,
  targetRoot: roots.target,
  tempRoot: roots.temp,
  receiptRoot: roots.receipt,
  ...overrides,
});

const missing = async (absolutePath) => {
  try {
    await stat(absolutePath);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
};

test("the generic DSL runs all 47 cases on real disposable filesystems", async () => {
  assert.equal(fixture.cases.length, 47);
  const results = await runFixture(fixture);
  assert.deepEqual(results.filter((result) => !result.pass), []);

  const covered = new Set(results.map((result) => result.id));
  for (const required of [
    "invalid-json",
    "duplicate-json-key",
    "duplicate-source-path",
    "case-collision",
    "ancestor-destination-collision",
    "source-symlink",
    "source-intermediate-symlink",
    "destination-symlink-escape",
    "stale-receipt-binding",
    "history-field-set",
    "history-wrong-type",
    "history-evidence-required",
    "attribution-field-set",
    "attribution-wrong-type",
    "attribution-not-reviewed",
    "exclusions-wrong-type",
    "exclusion-field-set",
    "exclusion-empty-class",
    "complete-receipt-selected-source-changed",
    "incomplete-receipt-selected-source-changed",
    "complete-receipt-unselected-source-changed",
    "incomplete-receipt-unselected-source-changed",
    "source-changed-same-size",
    "resume-changed-partial",
  ]) {
    assert.ok(covered.has(required), `fixture coverage is missing ${required}`);
  }
});

test("the fixture runner rejects duplicate case IDs before running cases", async () => {
  const duplicateFixture = structuredClone(fixture);
  duplicateFixture.cases[duplicateFixture.cases.length - 1] = structuredClone(
    duplicateFixture.cases[0],
  );

  await assert.rejects(
    runFixture(duplicateFixture),
    /duplicate fixture case id: restore-empty/u,
  );
});

test("fixture trees reject noncanonical base64 before creating a work directory", async (context) => {
  const validationRoot = await mkdtemp(path.join(tmpdir(), "vivary-fixture-validation-"));
  context.after(async () => rm(validationRoot, { recursive: true, force: true }));
  const missingWorkParent = path.join(validationRoot, "must-not-exist");

  for (const contentBase64 of ["!!!!", "YQ", "YQ===", "YR=="]) {
    const invalidFixture = fixtureWithOnlyCase("restore-empty");
    invalidFixture.trees["source-note-changed"][0].contentBase64 = contentBase64;
    await assert.rejects(
      runFixture(invalidFixture, { workParent: missingWorkParent }),
      /invalid fixture file/u,
      contentBase64,
    );
  }

  for (const mutation of [
    {
      op: "tree-add",
      tree: "source",
      path: "extra.bin",
      entry: { path: "extra.bin", kind: "file", contentBase64: "!!!!" },
    },
    {
      op: "tree-replace",
      tree: "source",
      path: "docs/note.txt",
      entry: { path: "docs/note.txt", kind: "file", contentBase64: "YR==" },
    },
  ]) {
    const invalidFixture = fixtureWithOnlyCase("restore-empty");
    invalidFixture.cases[0].mutations = [mutation];
    await assert.rejects(
      runFixture(invalidFixture, { workParent: missingWorkParent }),
      /invalid fixture file/u,
      `${mutation.op} contentBase64`,
    );
  }

  const emptyBase64Fixture = fixtureWithOnlyCase("restore-empty");
  const [emptyBase64Result] = await runFixture(emptyBase64Fixture, { workParent: validationRoot });
  assert.equal(emptyBase64Result.pass, true, JSON.stringify(emptyBase64Result));
});

test("fixture tree mutations reject malformed combined trees before creating a work directory", async (context) => {
  const validationRoot = await mkdtemp(path.join(tmpdir(), "vivary-fixture-mutation-validation-"));
  context.after(async () => rm(validationRoot, { recursive: true, force: true }));
  const missingWorkParent = path.join(validationRoot, "must-not-exist");
  const malformedMutations = [
    {
      mutation: {
        op: "tree-add",
        tree: "source",
        path: "extra.bin",
        entry: { path: "other.bin", kind: "file", contentBase64: "" },
      },
      error: /invalid tree-add mutation/u,
    },
    {
      mutation: {
        op: "tree-replace",
        tree: "source",
        path: "docs/note.txt",
        entry: { path: "other.txt", kind: "file", contentBase64: "" },
      },
      error: /invalid tree-replace mutation/u,
    },
    {
      mutation: {
        op: "tree-add",
        tree: "source",
        path: "docs/note.txt/child.bin",
        entry: { path: "docs/note.txt/child.bin", kind: "file", contentBase64: "" },
      },
      error: /fixture tree ancestor is not a directory/u,
    },
  ];

  for (const { mutation, error } of malformedMutations) {
    const invalidFixture = fixtureWithOnlyCase("restore-empty");
    invalidFixture.cases[0].mutations = [mutation];
    await assert.rejects(
      runFixture(invalidFixture, { workParent: missingWorkParent }),
      error,
      mutation.op,
    );
  }
});

test("fixture tree mutations reject transient invalid entries before creating a work directory", async (context) => {
  const validationRoot = await mkdtemp(path.join(tmpdir(), "vivary-fixture-mutation-step-validation-"));
  context.after(async () => rm(validationRoot, { recursive: true, force: true }));
  const invalidFixture = fixtureWithOnlyCase("restore-empty");
  invalidFixture.cases[0].mutations = [
    {
      op: "tree-add",
      tree: "source",
      path: "transient.bin",
      entry: { path: "transient.bin", kind: "file", contentBase64: "!!!!" },
    },
    { op: "tree-remove", tree: "source", path: "transient.bin" },
  ];

  await assert.rejects(
    runFixture(invalidFixture, { workParent: path.join(validationRoot, "must-not-exist") }),
    /invalid fixture file/u,
  );
});

test("fixture expectations reject unknown, mistyped, or incomplete assertions before work", async (context) => {
  const validationRoot = await mkdtemp(path.join(tmpdir(), "vivary-expect-validation-"));
  context.after(async () => rm(validationRoot, { recursive: true, force: true }));
  const missingWorkParent = path.join(validationRoot, "must-not-exist");
  const rejectsExpectation = async (invalidFixture, label) => assert.rejects(
    runFixture(invalidFixture, { workParent: missingWorkParent }),
    /invalid fixture expectation/u,
    label,
  );

  const typo = fixtureWithOnlyCase("source-symlink");
  typo.cases[0].expect.noWritez = typo.cases[0].expect.noWrites;
  delete typo.cases[0].expect.noWrites;
  await rejectsExpectation(typo, "unknown noWritez field");

  const missingAssertion = fixtureWithOnlyCase("source-symlink");
  delete missingAssertion.cases[0].expect.noWrites;
  await rejectsExpectation(missingAssertion, "missing noWrites or exact post-state");

  const unknownDefault = fixtureWithOnlyCase("source-symlink");
  unknownDefault.defaults.expect.noWritez = true;
  await rejectsExpectation(unknownDefault, "unknown default expectation field");

  const mistypedDefault = fixtureWithOnlyCase("source-symlink");
  mistypedDefault.defaults.expect.sourceUnchanged = "true";
  await rejectsExpectation(mistypedDefault, "mistyped default expectation field");

  for (const field of ["sourceUnchanged", "privacySafeError"]) {
    const disabledInvariant = fixtureWithOnlyCase("source-symlink");
    disabledInvariant.cases[0].expect[field] = false;
    await rejectsExpectation(disabledInvariant, `disabled ${field}`);
  }

  for (const field of [
    "targetTreeRef",
    "tempTreeRef",
    "receiptStatus",
    "receiptBinding",
    "verifiedPaths",
  ]) {
    const incompletePostState = fixtureWithOnlyCase("restore-empty");
    delete incompletePostState.cases[0].expect[field];
    await rejectsExpectation(incompletePostState, `missing ${field}`);
  }

  const incompleteReceiptPostState = fixtureWithOnlyCase("interrupted-after-one-output");
  delete incompleteReceiptPostState.cases[0].expect.ownedPaths;
  await rejectsExpectation(incompleteReceiptPostState, "missing ownedPaths");

  const invalidTypes = [
    ["source-symlink", "result", 1],
    ["invalid-field-set", "issues", [1]],
    ["source-symlink", "sourceUnchanged", "true"],
    ["source-symlink", "privacySafeError", "true"],
    ["source-symlink", "noWrites", "true"],
    ["restore-empty", "targetTreeRef", false],
    ["restore-empty", "tempTreeRef", false],
    ["restore-empty", "receiptStatus", false],
    ["restore-empty", "receiptBinding", false],
    ["restore-empty", "verifiedPaths", [1]],
    ["interrupted-after-one-output", "ownedPaths", [1]],
  ];
  for (const [caseId, field, value] of invalidTypes) {
    const invalidFixture = fixtureWithOnlyCase(caseId);
    invalidFixture.cases[0].expect[field] = value;
    await rejectsExpectation(invalidFixture, `${field} type`);
  }

  for (const [field, value] of [
    ["receiptStatus", "unknown"],
    ["receiptBinding", "not-current-manifest"],
    ["targetTreeRef", "missing-tree"],
    ["tempTreeRef", "missing-tree"],
  ]) {
    const invalidFixture = fixtureWithOnlyCase("restore-empty");
    invalidFixture.cases[0].expect[field] = value;
    await rejectsExpectation(invalidFixture, `${field} value`);
  }
});

test("fixture expectations reject unknown result and issue vocabulary before work", async (context) => {
  const validationRoot = await mkdtemp(path.join(tmpdir(), "vivary-expect-vocabulary-"));
  context.after(async () => rm(validationRoot, { recursive: true, force: true }));
  const missingWorkParent = path.join(validationRoot, "must-not-exist");

  const mistypedResult = fixtureWithOnlyCase("restore-empty");
  mistypedResult.cases[0].expect.result = "restord";
  await assert.rejects(
    runFixture(mistypedResult, { workParent: missingWorkParent }),
    /invalid fixture expectation/u,
  );

  const mistypedIssue = fixtureWithOnlyCase("invalid-field-set");
  mistypedIssue.cases[0].expect.issues = ["unknown-feild"];
  await assert.rejects(
    runFixture(mistypedIssue, { workParent: missingWorkParent }),
    /invalid fixture expectation/u,
  );
});

test("no-write cases honor exact target and temporary tree assertions", async () => {
  const contradictoryFixture = fixtureWithOnlyCase("repeat-identical");
  contradictoryFixture.cases[0].expect.targetTreeRef = "target-empty";
  contradictoryFixture.cases[0].expect.tempTreeRef = "target-restored";

  const [result] = await runFixture(contradictoryFixture);
  assert.equal(result.pass, false, "contradictory no-write tree assertions passed");
  assert.ok(result.failures.includes("target tree"));
  assert.ok(result.failures.includes("temporary tree"));
});

test("symbolic receipts and selected receipt references reject invalid fixture DSL before work", async (context) => {
  const validationRoot = await mkdtemp(path.join(tmpdir(), "vivary-fixture-receipt-validation-"));
  context.after(async () => rm(validationRoot, { recursive: true, force: true }));
  const missingWorkParent = path.join(validationRoot, "must-not-exist");
  const invalidFixtures = [];

  const missingSelectedReceipt = fixtureWithOnlyCase("restore-empty");
  missingSelectedReceipt.cases[0].setup = { receiptRef: "missing-receipt" };
  invalidFixtures.push([missingSelectedReceipt, "selected receipt reference"]);

  const mistypedSelectedReceipt = fixtureWithOnlyCase("restore-empty");
  mistypedSelectedReceipt.cases[0].setup = { receiptRef: 1 };
  invalidFixtures.push([mistypedSelectedReceipt, "selected receipt reference type"]);

  const invalidNoneSentinel = fixtureWithOnlyCase("restore-empty");
  invalidNoneSentinel.receipts.none = {};
  invalidFixtures.push([invalidNoneSentinel, "none sentinel"]);

  const unknownCompleteField = fixtureWithOnlyCase("restore-empty");
  unknownCompleteField.receipts.unused = {
    status: "complete",
    manifestRef: "base",
    verifiedTargetTreeRef: "target-restored",
    unexpected: true,
  };
  invalidFixtures.push([unknownCompleteField, "complete receipt field set"]);

  const incompleteCompleteShape = fixtureWithOnlyCase("restore-empty");
  incompleteCompleteShape.receipts.unused = {
    status: "complete",
    manifestRef: "base",
  };
  invalidFixtures.push([incompleteCompleteShape, "complete receipt missing field"]);

  const missingCompleteTree = fixtureWithOnlyCase("restore-empty");
  missingCompleteTree.receipts.unused = {
    status: "complete",
    manifestRef: "base",
    verifiedTargetTreeRef: "missing-tree",
  };
  invalidFixtures.push([missingCompleteTree, "complete receipt tree reference"]);

  const contradictoryCompleteTree = fixtureWithOnlyCase("restore-empty");
  contradictoryCompleteTree.receipts.unused = {
    status: "complete",
    manifestRef: "base",
    verifiedTargetTreeRef: "target-empty",
  };
  invalidFixtures.push([contradictoryCompleteTree, "complete receipt verified target"]);

  const invalidIncompleteReceipt = fixtureWithOnlyCase("restore-empty");
  invalidIncompleteReceipt.receipts.unused = {
    status: "incomplete",
    manifestRef: "base",
    ownedPaths: ["../outside"],
    observedTargetTreeRef: "missing-tree",
  };
  invalidFixtures.push([invalidIncompleteReceipt, "incomplete receipt schema and references"]);

  const invalidStatus = fixtureWithOnlyCase("restore-empty");
  invalidStatus.receipts.unused = {
    status: "unknown",
    manifestRef: "base",
  };
  invalidFixtures.push([invalidStatus, "receipt status"]);

  const invalidReferencedManifest = fixtureWithOnlyCase("restore-empty");
  invalidReferencedManifest.manifests.invalidReceiptManifest = {
    ...structuredClone(invalidReferencedManifest.manifests.base),
    schemaVersion: 2,
  };
  invalidReferencedManifest.receipts.unused = {
    status: "complete",
    manifestRef: "invalidReceiptManifest",
    verifiedTargetTreeRef: "target-restored",
  };
  invalidFixtures.push([invalidReferencedManifest, "receipt manifest"]);

  for (const [invalidFixture, label] of invalidFixtures) {
    await assert.rejects(
      runFixture(invalidFixture, { workParent: missingWorkParent }),
      /invalid symbolic receipt/u,
      label,
    );
  }
});

test("fixture envelope rejects empty suites and malformed descriptors before work", async (context) => {
  const validationRoot = await mkdtemp(path.join(tmpdir(), "vivary-fixture-envelope-validation-"));
  context.after(async () => rm(validationRoot, { recursive: true, force: true }));
  const missingWorkParent = path.join(validationRoot, "must-not-exist");
  const invalidFixtures = [];

  const emptySuite = structuredClone(fixture);
  emptySuite.cases = [];
  invalidFixtures.push([emptySuite, "empty case suite"]);

  const unknownTopLevel = fixtureWithOnlyCase("restore-empty");
  unknownTopLevel.casez = unknownTopLevel.cases;
  invalidFixtures.push([unknownTopLevel, "top-level field set"]);

  const unknownDefault = fixtureWithOnlyCase("restore-empty");
  unknownDefault.defaults.targetTreeReff = unknownDefault.defaults.targetTreeRef;
  invalidFixtures.push([unknownDefault, "defaults field set"]);

  const unknownCase = fixtureWithOnlyCase("restore-empty");
  unknownCase.cases[0].expectation = unknownCase.cases[0].expect;
  invalidFixtures.push([unknownCase, "case field set"]);

  const missingMutations = fixtureWithOnlyCase("restore-empty");
  delete missingMutations.cases[0].mutations;
  invalidFixtures.push([missingMutations, "case required fields"]);

  const unknownSetup = fixtureWithOnlyCase("restore-empty");
  unknownSetup.cases[0].setup = { targetTreeReff: "target-unexpected-bytes" };
  invalidFixtures.push([unknownSetup, "setup field set"]);

  const mistypedSetup = fixtureWithOnlyCase("restore-empty");
  mistypedSetup.cases[0].setup = { targetTreeRef: 1 };
  invalidFixtures.push([mistypedSetup, "setup reference type"]);

  const missingMutationValue = fixtureWithOnlyCase("restore-empty");
  missingMutationValue.cases[0].mutations = [{
    op: "set-json",
    pointer: "/owner",
    values: "fixture-writer",
  }];
  invalidFixtures.push([missingMutationValue, "mutation field set"]);

  const extraTreeMutationField = fixtureWithOnlyCase("restore-empty");
  extraTreeMutationField.cases[0].mutations = [{
    op: "tree-remove",
    tree: "source",
    path: "unselected/keep.txt",
    entry: null,
  }];
  invalidFixtures.push([extraTreeMutationField, "tree mutation field set"]);

  const mistypedRawManifest = fixtureWithOnlyCase("invalid-json");
  mistypedRawManifest.cases[0].rawManifestText = 1;
  invalidFixtures.push([mistypedRawManifest, "raw manifest text type"]);

  const shadowedMutation = fixtureWithOnlyCase("restore-empty");
  shadowedMutation.cases[0].rawManifestText = canonicalJson(shadowedMutation.manifests.base);
  shadowedMutation.cases[0].mutations = [{ op: "set-json", pointer: "/owner", value: "shadowed" }];
  invalidFixtures.push([shadowedMutation, "raw manifest text with mutations"]);

  const invalidSeedManifest = fixtureWithOnlyCase("restore-empty");
  invalidSeedManifest.manifests.unused = {};
  invalidFixtures.push([invalidSeedManifest, "invalid named manifest seed"]);

  for (const [invalidFixture, label] of invalidFixtures) {
    await assert.rejects(
      runFixture(invalidFixture, { workParent: missingWorkParent }),
      /invalid .*fixture|invalid fixture/u,
      label,
    );
  }
});

test("fixture faults reject malformed or ineffective configurations before work", async (context) => {
  const validationRoot = await mkdtemp(path.join(tmpdir(), "vivary-fixture-fault-validation-"));
  context.after(async () => rm(validationRoot, { recursive: true, force: true }));
  const missingWorkParent = path.join(validationRoot, "must-not-exist");
  const invalidFixtures = [];

  const unknownField = fixtureWithOnlyCase("interrupted-after-one-output");
  unknownField.cases[0].fault.unexpected = true;
  invalidFixtures.push([unknownField, "fault field set"]);

  const invalidCount = fixtureWithOnlyCase("interrupted-after-one-output");
  invalidCount.cases[0].fault.count = 0;
  invalidFixtures.push([invalidCount, "fault count"]);

  const unreachableCount = fixtureWithOnlyCase("restore-empty");
  unreachableCount.cases[0].fault = { op: "interrupt-after-output", count: 999 };
  invalidFixtures.push([unreachableCount, "unreachable fault"]);

  const completedReceipt = fixtureWithOnlyCase("repeat-identical");
  completedReceipt.cases[0].fault = { op: "interrupt-after-output", count: 2 };
  invalidFixtures.push([completedReceipt, "fault after complete receipt"]);

  for (const [invalidFixture, label] of invalidFixtures) {
    await assert.rejects(
      runFixture(invalidFixture, { workParent: missingWorkParent }),
      /invalid fixture fault/u,
      label,
    );
  }
});

test("fixture faults reject unreachable prepared filesystem states before work", async (context) => {
  const validationRoot = await mkdtemp(path.join(tmpdir(), "vivary-fixture-fault-state-validation-"));
  context.after(async () => rm(validationRoot, { recursive: true, force: true }));
  const missingWorkParent = path.join(validationRoot, "must-not-exist");
  const invalidFixtures = [];

  for (const [field, treeRef] of [
    ["sourceTreeRef", "source-note-changed"],
    ["targetTreeRef", "target-unexpected-bytes"],
    ["tempTreeRef", "target-unexpected-bytes"],
  ]) {
    const blocked = fixtureWithOnlyCase("interrupted-after-one-output");
    blocked.cases[0].setup = { [field]: treeRef };
    invalidFixtures.push([blocked, field]);
  }

  const invalidResume = fixtureWithOnlyCase("interrupted-after-one-output");
  invalidResume.cases[0].setup = {
    receiptRef: "incomplete-base",
    targetTreeRef: "target-empty",
  };
  invalidResume.cases[0].fault.count = 2;
  invalidFixtures.push([invalidResume, "incomplete receipt target"]);

  for (const [invalidFixture, label] of invalidFixtures) {
    await assert.rejects(
      runFixture(invalidFixture, { workParent: missingWorkParent }),
      /invalid fixture fault/u,
      label,
    );
  }
});

test("fixture pointers and link targets reject platform-ambiguous DSL before work", async (context) => {
  const validationRoot = await mkdtemp(path.join(tmpdir(), "vivary-fixture-path-validation-"));
  context.after(async () => rm(validationRoot, { recursive: true, force: true }));
  const missingWorkParent = path.join(validationRoot, "must-not-exist");
  const invalidFixtures = [];

  for (const pointer of ["/owner~2name", "/files/-", "/files/01"]) {
    const invalidPointer = fixtureWithOnlyCase("restore-empty");
    invalidPointer.cases[0].mutations = [{ op: "set-json", pointer, value: "ignored" }];
    invalidFixtures.push([invalidPointer, pointer]);
  }

  for (const target of ["/absolute", "C:/absolute", "bad\\target", "bad\0target"]) {
    const invalidLink = fixtureWithOnlyCase("restore-empty");
    invalidLink.trees["unused-invalid-link"] = [{ path: "link", kind: "link", target }];
    invalidFixtures.push([invalidLink, JSON.stringify(target)]);
  }

  for (const [invalidFixture, label] of invalidFixtures) {
    await assert.rejects(
      runFixture(invalidFixture, { workParent: missingWorkParent }),
      /invalid fixture JSON Pointer|invalid fixture link/u,
      label,
    );
  }
});

test("fixture seeds, policy mutations, and raw parser cases reject hidden no-ops before work", async (context) => {
  const validationRoot = await mkdtemp(path.join(tmpdir(), "vivary-fixture-hidden-noop-validation-"));
  context.after(async () => rm(validationRoot, { recursive: true, force: true }));
  const missingWorkParent = path.join(validationRoot, "must-not-exist");
  const invalidFixtures = [];

  const transientPolicy = fixtureWithOnlyCase("restore-empty");
  transientPolicy.cases[0].mutations = [
    { op: "set-policy", field: "caseSensitivity", value: "bogus" },
    { op: "set-policy", field: "caseSensitivity", value: "sensitive" },
  ];
  invalidFixtures.push([transientPolicy, "transient invalid policy"]);

  const unsafeSeed = fixtureWithOnlyCase("restore-empty");
  unsafeSeed.manifests.unused = structuredClone(unsafeSeed.manifests.base);
  unsafeSeed.manifests.unused.files[0].destination = "../outside";
  invalidFixtures.push([unsafeSeed, "unsafe named manifest seed"]);

  const positiveRawManifest = fixtureWithOnlyCase("restore-empty");
  positiveRawManifest.cases[0].rawManifestText = canonicalJson(positiveRawManifest.manifests.base);
  invalidFixtures.push([positiveRawManifest, "positive raw manifest"]);

  for (const [invalidFixture, label] of invalidFixtures) {
    await assert.rejects(
      runFixture(invalidFixture, { workParent: missingWorkParent }),
      /invalid fixture mutation|invalid fixture manifest|invalid fixture raw manifest text/u,
      label,
    );
  }
});

test("named manifest aliases use each case's selected policy", async (context) => {
  const validationRoot = await mkdtemp(path.join(tmpdir(), "vivary-fixture-selected-policy-"));
  context.after(async () => rm(validationRoot, { recursive: true, force: true }));
  const selectedPolicyFixture = fixtureWithOnlyCase("restore-empty");
  selectedPolicyFixture.defaults.policy.caseSensitivity = "insensitive";
  selectedPolicyFixture.manifests["case-sensitive-aliases"] = structuredClone(
    selectedPolicyFixture.manifests.base,
  );
  selectedPolicyFixture.manifests["case-sensitive-aliases"].files[0].path = "A";
  selectedPolicyFixture.manifests["case-sensitive-aliases"].files[0].destination = "A";
  selectedPolicyFixture.manifests["case-sensitive-aliases"].files[1].path = "a";
  selectedPolicyFixture.manifests["case-sensitive-aliases"].files[1].destination = "a";
  selectedPolicyFixture.trees["source-case-sensitive-aliases"] = [
    { path: "A", kind: "file", contentBase64: "YWJj" },
    { path: "a", kind: "file", contentBase64: "" },
  ];
  selectedPolicyFixture.trees["target-case-sensitive-aliases"] = structuredClone(
    selectedPolicyFixture.trees["source-case-sensitive-aliases"],
  );
  selectedPolicyFixture.cases[0].setup = {
    manifestRef: "case-sensitive-aliases",
    sourceTreeRef: "source-case-sensitive-aliases",
    policy: {
      ...selectedPolicyFixture.defaults.policy,
      caseSensitivity: "sensitive",
    },
  };
  selectedPolicyFixture.cases[0].expect.targetTreeRef = "target-case-sensitive-aliases";
  selectedPolicyFixture.cases[0].expect.verifiedPaths = ["A", "a"];

  await assert.rejects(
    runFixture(selectedPolicyFixture, { workParent: path.join(validationRoot, "must-not-exist") }),
    (error) => error?.code === "ENOENT",
  );
});

test("strict parsing rejects malformed and nested duplicate keys before filesystem access", async () => {
  for (const text of [
    '{"schemaVersion":1',
    '{"outer":{"key":1,"key":2}}',
    '{"array":[{"key":1,"key":2}]}',
    '{"text":"\\ud800"}',
  ]) {
    assert.throws(() => parseStrictJson(text), StrictJsonError, text);
  }
  let duplicateError = null;
  try {
    parseStrictJson('{"a":1,"a":2}');
  } catch (error) {
    duplicateError = error;
  }
  assert.equal(duplicateError?.code, "duplicate-json-key");

  const result = await restoreSourcePreservation({
    manifestText: '{"outer":{"key":1,"key":2}}',
    sourceRoot: "/path-that-must-not-be-read",
    targetRoot: "/path-that-must-not-be-read",
    tempRoot: "/path-that-must-not-be-read",
    receiptRoot: "/path-that-must-not-be-read",
  });
  assert.deepEqual(result, { result: "duplicate-json-key" });
});

test("restore, repeat, interruption, and resume preserve exact bytes and owned files", async (context) => {
  const first = await makeSandbox(context);
  const binaryBytes = Buffer.from([0x00, 0xff, 0x80, 0x0a, 0x0d, 0x41]);
  const crlfBytes = Buffer.from("first\r\nsecond\r\n", "utf8");
  await mkdir(path.join(first.roots.source, "binary"));
  await mkdir(path.join(first.roots.source, "text"));
  await writeFile(path.join(first.roots.source, "binary", "data.bin"), binaryBytes);
  await writeFile(path.join(first.roots.source, "text", "crlf.txt"), crlfBytes);
  const exactManifest = baseManifest();
  exactManifest.files.push(
    {
      path: "binary/data.bin",
      kind: "file",
      sha256: createHash("sha256").update(binaryBytes).digest("hex"),
      size: binaryBytes.length,
      class: "untracked",
      destination: "binary/data.bin",
    },
    {
      path: "text/crlf.txt",
      kind: "file",
      sha256: createHash("sha256").update(crlfBytes).digest("hex"),
      size: crlfBytes.length,
      class: "tracked-dirty",
      destination: "text/crlf.txt",
    },
  );
  const sourceBefore = await Promise.all([
    readFile(path.join(first.roots.source, "docs", "note.txt")),
    readFile(path.join(first.roots.source, "assets", "empty.bin")),
    readFile(path.join(first.roots.source, "unselected", "keep.txt")),
  ]);

  const restored = await restoreSourcePreservation(operation(first.roots, exactManifest));
  assert.equal(restored.result, "restored");
  assert.deepEqual(await readFile(path.join(first.roots.target, "docs", "note.txt")), Buffer.from("abc"));
  assert.deepEqual(await readFile(path.join(first.roots.target, "assets", "empty.bin")), Buffer.alloc(0));
  assert.deepEqual(await readFile(path.join(first.roots.target, "binary", "data.bin")), binaryBytes);
  assert.deepEqual(await readFile(path.join(first.roots.target, "text", "crlf.txt")), crlfBytes);
  assert.deepEqual(await Promise.all([
    readFile(path.join(first.roots.source, "docs", "note.txt")),
    readFile(path.join(first.roots.source, "assets", "empty.bin")),
    readFile(path.join(first.roots.source, "unselected", "keep.txt")),
  ]), sourceBefore);

  await mkdir(path.join(first.roots.target, "user"));
  await writeFile(path.join(first.roots.target, "user", "keep.txt"), Buffer.from("keep"));
  const selectedBefore = await stat(path.join(first.roots.target, "docs", "note.txt"), { bigint: true });
  const receiptPath = path.join(first.roots.receipt, "restore-receipt.json");
  const receiptBefore = await readFile(receiptPath);
  const receiptStatBefore = await stat(receiptPath, { bigint: true });
  const repeated = await restoreSourcePreservation(operation(first.roots, exactManifest));
  assert.equal(repeated.result, "already-restored");
  assert.deepEqual(await readFile(path.join(first.roots.target, "user", "keep.txt")), Buffer.from("keep"));
  assert.equal(
    (await stat(path.join(first.roots.target, "docs", "note.txt"), { bigint: true })).mtimeNs,
    selectedBefore.mtimeNs,
  );
  assert.deepEqual(await readFile(receiptPath), receiptBefore);
  assert.equal((await stat(receiptPath, { bigint: true })).mtimeNs, receiptStatBefore.mtimeNs);

  const second = await makeSandbox(context);
  const interrupted = await restoreSourcePreservation(operation(second.roots, baseManifest(), {
    fault: { op: "interrupt-after-output", count: 1 },
  }));
  assert.deepEqual(interrupted.ownedPaths, ["docs/note.txt"]);
  const incompleteReceipt = parseStrictJson(
    await readFile(path.join(second.roots.receipt, "restore-receipt.json"), "utf8"),
  );
  assert.equal(incompleteReceipt.status, "incomplete");
  assert.match(incompleteReceipt.sourceTreeDigest, /^[0-9a-f]{64}$/u);
  assert.match(incompleteReceipt.observedTargetDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(await readFile(path.join(second.roots.target, "docs", "note.txt")), Buffer.from("abc"));
  assert.equal(await missing(path.join(second.roots.target, "assets", "empty.bin")), true);
  assert.deepEqual(await readdir(second.roots.temp), []);

  const ownedBeforeResume = await stat(
    path.join(second.roots.target, "docs", "note.txt"),
    { bigint: true },
  );
  const resumed = await restoreSourcePreservation(operation(second.roots));
  assert.equal(resumed.result, "restored");
  assert.equal(
    (await stat(path.join(second.roots.target, "docs", "note.txt"), { bigint: true })).mtimeNs,
    ownedBeforeResume.mtimeNs,
  );
  assert.deepEqual(await readFile(path.join(second.roots.target, "assets", "empty.bin")), Buffer.alloc(0));
  assert.equal(
    parseStrictJson(await readFile(path.join(second.roots.receipt, "restore-receipt.json"), "utf8")).status,
    "complete",
  );
});

test("changed manifest, receipt, partial output, and source all refuse without another write", async (context) => {
  const completed = await makeSandbox(context);
  assert.equal((await restoreSourcePreservation(operation(completed.roots))).result, "restored");
  const receiptPath = path.join(completed.roots.receipt, "restore-receipt.json");
  const changedManifest = baseManifest();
  changedManifest.files[1].destination = "assets/empty-copy.bin";
  const targetBytesBefore = await readFile(path.join(completed.roots.target, "docs", "note.txt"));
  const originalReceiptBytes = await readFile(receiptPath);
  assert.equal(
    (await restoreSourcePreservation(operation(completed.roots, changedManifest))).result,
    "receipt-binding-mismatch",
  );
  assert.deepEqual(await readFile(receiptPath), originalReceiptBytes);
  assert.deepEqual(await readFile(path.join(completed.roots.target, "docs", "note.txt")), targetBytesBefore);
  assert.equal(await missing(path.join(completed.roots.target, "assets", "empty-copy.bin")), true);

  const changedReceipt = parseStrictJson(originalReceiptBytes.toString("utf8"));
  changedReceipt.manifestDigest = "0".repeat(64);
  await writeFile(receiptPath, `${canonicalJson(changedReceipt)}\n`);
  const changedReceiptBytes = await readFile(receiptPath);
  const changedReceiptStat = await stat(receiptPath, { bigint: true });
  assert.equal(
    (await restoreSourcePreservation(operation(completed.roots))).result,
    "receipt-binding-mismatch",
  );
  assert.deepEqual(await readFile(receiptPath), changedReceiptBytes);
  assert.equal((await stat(receiptPath, { bigint: true })).mtimeNs, changedReceiptStat.mtimeNs);

  const changedSource = await makeSandbox(context);
  await writeFile(path.join(changedSource.roots.source, "docs", "note.txt"), Buffer.from("abd"));
  assert.equal(
    (await restoreSourcePreservation(operation(changedSource.roots))).result,
    "source-hash-mismatch",
  );
  assert.deepEqual(await readdir(changedSource.roots.target), []);
  assert.deepEqual(await readdir(changedSource.roots.temp), []);
  assert.deepEqual(await readdir(changedSource.roots.receipt), []);

  const interrupted = await makeSandbox(context);
  assert.equal((await restoreSourcePreservation(operation(interrupted.roots, baseManifest(), {
    fault: { op: "interrupt-after-output", count: 1 },
  }))).result, "incomplete");
  await writeFile(path.join(interrupted.roots.target, "docs", "note.txt"), Buffer.from("bad"));
  const partialReceiptBefore = await readFile(
    path.join(interrupted.roots.receipt, "restore-receipt.json"),
  );
  assert.equal(
    (await restoreSourcePreservation(operation(interrupted.roots))).result,
    "target-conflict",
  );
  assert.deepEqual(await readFile(path.join(interrupted.roots.target, "docs", "note.txt")), Buffer.from("bad"));
  assert.deepEqual(
    await readFile(path.join(interrupted.roots.receipt, "restore-receipt.json")),
    partialReceiptBefore,
  );
  assert.equal(await missing(path.join(interrupted.roots.target, "assets", "empty.bin")), true);
});

test("source, target, temporary, and receipt roots reject symbolic links", async (context) => {
  for (const rootName of ["source", "target", "temp", "receipt"]) {
    await context.test(rootName, async (subtest) => {
      const sandbox = await makeSandbox(subtest);
      const realRoot = path.join(sandbox.root, `${rootName}-real`);
      await rm(sandbox.roots[rootName], { recursive: true });
      await mkdir(realRoot);
      if (rootName === "source") {
        await mkdir(path.join(realRoot, "docs"));
        await mkdir(path.join(realRoot, "assets"));
        await writeFile(path.join(realRoot, "docs", "note.txt"), Buffer.from("abc"));
        await writeFile(path.join(realRoot, "assets", "empty.bin"), Buffer.alloc(0));
      }
      await symlink(path.basename(realRoot), sandbox.roots[rootName], "dir");
      assert.equal(
        (await restoreSourcePreservation(operation(sandbox.roots))).result,
        "unsafe-link",
      );
    });
  }
});

test("a linked intermediate source parent is rejected without reading outside bytes", async (context) => {
  const sandbox = await makeSandbox(context);
  const outsideRoot = path.join(sandbox.root, "outside-source");
  const outsidePath = path.join(outsideRoot, "note.txt");
  const outsideBytes = Buffer.from("outside-sentinel");
  await mkdir(outsideRoot);
  await writeFile(outsidePath, outsideBytes);
  await rm(path.join(sandbox.roots.source, "docs"), { recursive: true });
  await symlink("../outside-source", path.join(sandbox.roots.source, "docs"), "dir");

  await chmod(outsidePath, 0o000);
  try {
    assert.equal(
      (await restoreSourcePreservation(operation(sandbox.roots))).result,
      "unsafe-link",
    );
    assert.deepEqual(await readdir(sandbox.roots.target), []);
    assert.deepEqual(await readdir(sandbox.roots.temp), []);
    assert.deepEqual(await readdir(sandbox.roots.receipt), []);
  } finally {
    await chmod(outsidePath, 0o600);
  }
  assert.deepEqual(await readFile(outsidePath), outsideBytes);
});

test("schema types and fixture prototype keys are rejected before writes", async () => {
  const wrongSize = baseManifest();
  wrongSize.files[0].size = "3";
  assert.deepEqual(await restoreSourcePreservation({
    manifestText: canonicalJson(wrongSize),
    sourceRoot: "/unused-source",
    targetRoot: "/unused-target",
    tempRoot: "/unused-temp",
    receiptRoot: "/unused-receipt",
  }), { result: "invalid-manifest", issues: ["invalid-type"] });

  const prototypeFixture = structuredClone(fixture);
  prototypeFixture.cases = [{
    id: "prototype-field",
    mutations: [{ op: "set-json", pointer: "/__proto__", value: { polluted: true } }],
    expect: {
      result: "invalid-manifest",
      issues: ["unknown-field"],
      noWrites: true,
    },
  }];
  const [result] = await runFixture(prototypeFixture);
  assert.equal(result.pass, true, JSON.stringify(result));
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
});

test("an unwritable receipt root refuses before creating target output", {
  skip: process.platform === "win32" || process.geteuid?.() === 0
    ? "POSIX mode proof requires an unprivileged POSIX process"
    : false,
}, async (context) => {
  const sandbox = await makeSandbox(context);
  await chmod(sandbox.roots.receipt, 0o500);
  try {
    assert.equal(
      (await restoreSourcePreservation(operation(sandbox.roots))).result,
      "filesystem-error",
    );
    assert.deepEqual(await readdir(sandbox.roots.target), []);
    assert.deepEqual(await readdir(sandbox.roots.temp), []);
    assert.deepEqual(await readdir(sandbox.roots.receipt), []);
  } finally {
    await chmod(sandbox.roots.receipt, 0o700);
  }
});

test("an intermediate parent creation failure rolls back only the new parent", {
  skip: process.platform !== "linux" ? "the Habitat proof uses Linux NAME_MAX" : false,
}, async (context) => {
  const sandbox = await makeSandbox(context);
  const manifest = baseManifest();
  manifest.files[0].destination = `qa/${"x".repeat(300)}/note.txt`;
  assert.equal(
    (await restoreSourcePreservation(operation(sandbox.roots, manifest))).result,
    "filesystem-error",
  );
  assert.deepEqual(await readdir(sandbox.roots.target), []);
  assert.deepEqual(await readdir(sandbox.roots.temp), []);
  assert.deepEqual(await readdir(sandbox.roots.receipt), []);
  assert.deepEqual(await readFile(path.join(sandbox.roots.source, "docs", "note.txt")), Buffer.from("abc"));
});

test("a destination write failure after exclusive creation removes the owned partial file", async (context) => {
  const sandbox = await makeSandbox(context);
  const probePath = path.join(sandbox.root, "file-handle-probe");
  const probe = await open(probePath, "wx");
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  const originalWriteFile = fileHandlePrototype.writeFile;
  await probe.close();
  await rm(probePath);

  let writeCalls = 0;
  context.mock.method(fileHandlePrototype, "writeFile", async function injectedWriteFailure(data, ...args) {
    writeCalls += 1;
    if (writeCalls === 2) {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      await originalWriteFile.call(this, bytes.subarray(0, 1), ...args);
      const error = new Error("injected destination write failure");
      error.code = "EIO";
      throw error;
    }
    return originalWriteFile.call(this, data, ...args);
  });

  assert.equal(
    (await restoreSourcePreservation(operation(sandbox.roots))).result,
    "filesystem-error",
  );
  assert.equal(writeCalls, 2);
  assert.deepEqual(await readdir(sandbox.roots.target), []);
  assert.deepEqual(await readdir(sandbox.roots.temp), []);
  assert.deepEqual(await readdir(sandbox.roots.receipt), []);
  assert.deepEqual(await readFile(path.join(sandbox.roots.source, "docs", "note.txt")), Buffer.from("abc"));
});

test("the fixture oracle kills a deliberate implementation mutation that accepts a wrong hash", async (context) => {
  const sourcePath = fileURLToPath(new URL("../prove_multi_project_source_preservation.mjs", import.meta.url));
  const source = await readFile(sourcePath, "utf8");
  const mutantSource = source.replace(
    "const sourceHashMatches = digestBytes(bytes) === file.sha256;",
    "const sourceHashMatches = true;",
  );
  assert.notEqual(mutantSource, source, "wrong-hash mutation did not alter the implementation");
  const directory = await mkdtemp(path.join(tmpdir(), "vivary-restore-mutant-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const mutantPath = path.join(directory, "wrong-hash-mutant.mjs");
  await writeFile(mutantPath, mutantSource, "utf8");
  const mutant = await import(`${pathToFileURL(mutantPath).href}?mutation=${Date.now()}`);
  const results = await mutant.runFixture(fixture, { workParent: directory });
  const changedSource = results.find((result) => result.id === "source-changed-same-size");
  assert.ok(changedSource);
  assert.equal(changedSource.pass, false, "wrong-hash mutation survived the fixture oracle");
  assert.notEqual(changedSource.actual.result, "source-hash-mismatch");
  assert.ok(changedSource.failures.includes("result"));
  assert.notEqual(digestManifest(baseManifest()), "0".repeat(64));
});

test("the fixture oracle rejects incorrect response path lists even when receipts are correct", async (context) => {
  const sourcePath = fileURLToPath(new URL("../prove_multi_project_source_preservation.mjs", import.meta.url));
  const source = await readFile(sourcePath, "utf8");
  const mutantSource = source
    .replaceAll("verifiedPaths: outputs.map((item) => item.path)", "verifiedPaths: []")
    .replace(
      "return { result: \"incomplete\", manifestDigest, ownedPaths };",
      "return { result: \"incomplete\", manifestDigest, ownedPaths: [] };",
    );
  assert.notEqual(mutantSource, source, "response-path mutation did not alter the implementation");
  assert.match(mutantSource, /ownedPaths: \[\]/u, "ownedPaths mutation did not alter the implementation");
  const directory = await mkdtemp(path.join(tmpdir(), "vivary-restore-path-mutant-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const mutantPath = path.join(directory, "response-path-mutant.mjs");
  await writeFile(mutantPath, mutantSource, "utf8");
  const mutant = await import(`${pathToFileURL(mutantPath).href}?mutation=${Date.now()}`);
  const selectedFixture = structuredClone(fixture);
  selectedFixture.cases = selectedFixture.cases.filter(({ id }) =>
    new Set(["restore-empty", "interrupted-after-one-output"]).has(id));
  const results = await mutant.runFixture(selectedFixture, { workParent: directory });
  const restored = results.find(({ id }) => id === "restore-empty");
  const interrupted = results.find(({ id }) => id === "interrupted-after-one-output");
  assert.equal(restored.pass, false, "incorrect verifiedPaths survived the fixture oracle");
  assert.ok(restored.failures.includes("verified paths response"));
  assert.equal(interrupted.pass, false, "incorrect ownedPaths survived the fixture oracle");
  assert.ok(interrupted.failures.includes("owned paths response"));
});

test("the fixture oracle checks response manifest and full receipt binding metadata", async (context) => {
  const sourcePath = fileURLToPath(new URL("../prove_multi_project_source_preservation.mjs", import.meta.url));
  const source = await readFile(sourcePath, "utf8");
  const mutantSource = source
    .replaceAll("sourceTreeDigest: source.sourceTreeDigest,", "sourceTreeDigest: \"0\".repeat(64),")
    .replace(
      "return { result: \"restored\", manifestDigest, verifiedPaths: outputs.map((item) => item.path) };",
      "return { result: \"restored\", manifestDigest: \"0\".repeat(64), verifiedPaths: outputs.map((item) => item.path) };",
    );
  assert.notEqual(mutantSource, source, "binding mutation did not alter the implementation");
  const directory = await mkdtemp(path.join(tmpdir(), "vivary-restore-binding-mutant-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const mutantPath = path.join(directory, "binding-mutant.mjs");
  await writeFile(mutantPath, mutantSource, "utf8");
  const mutant = await import(`${pathToFileURL(mutantPath).href}?mutation=${Date.now()}`);
  const [result] = await mutant.runFixture(fixtureWithOnlyCase("restore-empty"), { workParent: directory });
  assert.equal(result.pass, false, "incorrect response and receipt binding metadata passed");
  assert.ok(result.failures.includes("manifest digest response"));
  assert.ok(result.failures.includes("receipt source tree digest"));
});

test("the fixture oracle rejects a parsed null receipt", async (context) => {
  const sourcePath = fileURLToPath(new URL("../prove_multi_project_source_preservation.mjs", import.meta.url));
  const source = await readFile(sourcePath, "utf8");
  const mutantSource = source.replace(
    "const text = `${canonicalJson(receipt)}\\n`;",
    "const text = \"null\\n\";",
  );
  assert.notEqual(mutantSource, source, "null receipt mutation did not alter the implementation");
  const directory = await mkdtemp(path.join(tmpdir(), "vivary-restore-null-receipt-mutant-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const mutantPath = path.join(directory, "null-receipt-mutant.mjs");
  await writeFile(mutantPath, mutantSource, "utf8");
  const mutant = await import(`${pathToFileURL(mutantPath).href}?mutation=${Date.now()}`);
  const [result] = await mutant.runFixture(fixtureWithOnlyCase("restore-empty"), { workParent: directory });
  assert.equal(result.pass, false, "parsed null receipt survived the fixture oracle");
  assert.ok(result.failures.includes("receipt shape"));
});
