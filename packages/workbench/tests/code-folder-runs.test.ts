import assert from "node:assert/strict";
import test from "node:test";
import { folderRunTargets } from "../app/lib/code-folder-runs.ts";

test("a personal-workspace run in the folder opens in the personal workspace, not the selected project", () => {
  const folderRuns = [
    { id: "personal-run", title: "Personal notes", turnId: "turn-1" },
    { id: "project-run", title: "Parser", turnId: "turn-2" },
    { id: "other-token", title: null, turnId: "token" },
    { id: "selected-run", title: "This one", turnId: "turn-3" },
  ];
  const activeRuns = [{ id: "personal-run", projectId: null }, { id: "project-run", projectId: "beta" },
    { id: "selected-run", projectId: "alpha" }];
  assert.deepEqual(folderRunTargets(folderRuns, activeRuns, "selected-run", "alpha").map(run => [run.id, run.projectId]), [
    ["personal-run", null], ["project-run", "beta"], ["other-token", "alpha"]]);
});
