// The parent starts this child in a disposable local-files workspace with
// Native's single-tenant bridge flag in its environment. Neither process
// changes its own environment or working directory. No provider or network.
import assert from "node:assert/strict";
const f = await import("./automation-approval-fixture.mjs");
const { resources, database, loadCore } = f;
try {
  const local = await loadCore("local-artifacts/index.js");
  const enabled = await local.isLocalWorkspaceResourcesEnabled();
  assert.equal(enabled, true);
  const cases = [];
  for (const kind of ["id", "path"]) {
    const resourcePath = `skills/helper-${kind}/SKILL.md`;
    const saved = await resources.resourcePut(resources.WORKSPACE_OWNER, resourcePath, "Local workspace control.");
    const localId = saved.id === local.localWorkspaceResourceId(resourcePath);
    assert.ok(localId, "the write took the local workspace branch");
    const storedBeforeDelete = Boolean(await local.readLocalWorkspaceResource({ path: resourcePath }));
    assert.ok(storedBeforeDelete, "the local file exists before deletion");
    const deleted = await (kind === "id" ? resources.resourceDelete(saved.id)
      : resources.resourceDeleteByPath(resources.WORKSPACE_OWNER, resourcePath));
    assert.equal(deleted, true);
    const readAfterDelete = await local.readLocalWorkspaceResource({ path: resourcePath });
    assert.equal(readAfterDelete, null);
    cases.push({ kind, resourcePath, localId, storedBeforeDelete, deleted, readAfterDelete });
  }
  console.log("APPROVAL_RESULT " + JSON.stringify({ cwd: process.cwd(), enabled, cases }));
} finally {
  await database.closeDbExec();
  f.restoreTimers();
}
// Deliberately no process.exit. The parent requires a natural exit.
