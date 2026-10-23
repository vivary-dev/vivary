import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateRegistryOperation, deriveMutationKeys, LOCAL_ROOT_VERIFICATION } from "../../../scripts/registry_contract_model.mjs";

const fixtures = JSON.parse(await readFile(new URL("../../../docs/product/multi-project/fixtures/project-registry.json", import.meta.url)));
function localInput() {
  const input = structuredClone(fixtures.inputs.register);
  input.trusted.root = { ...input.trusted.root, verificationKind: LOCAL_ROOT_VERIFICATION, contentRevision: null,
    vcs: { kind: "unobserved", repositoryId: null, checkoutId: null, mutationOwner: null } };
  return input;
}

test("local registration records the verification kind without a fictional content revision", () => {
  const input = localInput();
  const result = evaluateRegistryOperation(input);
  assert.equal(result.output.code, "registered");
  assert.equal(result.recordChanges.insertBinding.verificationKind, LOCAL_ROOT_VERIFICATION);
  assert.equal(result.recordChanges.insertBinding.vcs.kind, "unobserved");
  assert.equal(deriveMutationKeys(input.trusted, null), null);
});

test("local mode rejects invented content/VCS proof and requires its explicit discriminator", () => {
  for (const patch of [{ contentRevision: "fake-snapshot" }, { verificationKind: undefined },
    { vcs: { kind: "none", repositoryId: null, checkoutId: null, mutationOwner: null } }]) {
    const input = localInput();
    Object.assign(input.trusted.root, patch);
    assert.equal(evaluateRegistryOperation(input).output.code, "invalid-input");
  }
});

test("the existing held-custody registration input retains its exact record shape", () => {
  const result = evaluateRegistryOperation(structuredClone(fixtures.inputs.register));
  assert.equal(result.output.code, "registered");
  assert.equal(Object.hasOwn(result.recordChanges.insertBinding, "verificationKind"), false);
});

test("registration carries no project kind, so a registered folder stays Not set until the owner chooses", () => {
  for (const input of [localInput(), structuredClone(fixtures.inputs.register)]) {
    const result = evaluateRegistryOperation(input);
    assert.equal(result.output.code, "registered");
    assert.deepEqual(Object.keys(result.recordChanges.insertPortable).sort(),
      ["contentIdentity", "displayName", "projectId", "schemaVersion"]);
    assert.ok(!JSON.stringify(result).includes("workspaceKind"));
  }
});
