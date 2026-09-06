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
