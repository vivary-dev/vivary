import assert from "node:assert/strict";
import test from "node:test";
import { summarizeAdoptionOutput } from "../app/lib/project-adoption.ts";
import { workspacePatternChoice, workspacePatternState } from "../shared/workspace-patterns.ts";

const hash = "sha256:" + "a".repeat(64);
const changed = { operation: "patch", path: "AGENTS.md", content: "\ufeff# Owner\r\n\nManaged block\n",
  content_hash: hash, before_hash: hash, bytes: 27 };
const report = (fields: Record<string, unknown> = {}) => ({
  mode: "dry-run", preset: "coding", preset_reason: "explicit", plan_hash: hash, conflicts: [],
  content_plan: { schema: "vivary.adopt-content-plan.v1", files: [changed],
    kept: [{ path: "STATE.md", content_hash: hash }] }, ...fields,
});
const output = (value: unknown, exitCode = 0) => ({ exitCode, stdout: JSON.stringify(value), stderr: "" });

test("setup preview preserves complete patch text and retained file identity", () => {
  assert.deepEqual(summarizeAdoptionOutput(output(report())), {
    kind: "report", preset: "coding", presetReason: "explicit", planHash: hash,
    files: [changed], kept: [{ path: "STATE.md", content_hash: hash }], conflicts: [],
    validationFindings: [], contentInventory: undefined,
  });
});

test("conflicts remain visible when the read-only CLI exits one", () => {
  const preview = summarizeAdoptionOutput(output(report({ conflicts: [{ path: ".gitignore", reason: ".gitignore is not UTF-8" }] }), 1));
  assert.equal(preview.kind, "report");
  if (preview.kind !== "report") assert.fail("Expected a readable conflict report");
  assert.deepEqual(preview.conflicts, [{ path: ".gitignore", reason: ".gitignore is not UTF-8" }]);
  assert.deepEqual(preview.files, [changed]);
});

test("configured validation findings and retained content counts survive the preview boundary", () => {
  const finding = { path: "decisions/invalid.md", line: 1, level: "error", code: "E101",
    message: "missing required field 'date' for type 'decision'" };
  const preview = summarizeAdoptionOutput(output(report({
    validation_findings: [finding],
    content_inventory: { existing_markdown: 400, existing_non_markdown: 12 },
    conflicts: [{ path: finding.path, reason: "E101: " + finding.message }],
  }), 1));
  assert.equal(preview.kind, "report");
  if (preview.kind !== "report") assert.fail("Expected a readable conflict report");
  assert.deepEqual(preview.validationFindings, [finding]);
  assert.deepEqual(preview.contentInventory, { existing_markdown: 400, existing_non_markdown: 12 });
});

test("an older runtime, applied report, or incomplete change is not presented as a full preview", () => {
  for (const value of [report({ content_plan: undefined }), report({ mode: "applied" }),
    report({ content_plan: { schema: "vivary.adopt-content-plan.v1", files: [{ ...changed, before_hash: undefined }], kept: [] } }),
    report({ content_plan: { schema: "vivary.adopt-content-plan.v1", files: [{ ...changed, path: "../foreign.md" }], kept: [] } })]) {
    assert.deepEqual(summarizeAdoptionOutput(output(value)), { kind: "unreadable",
      message: "The local runtime did not return a complete setup preview. Update the runtime and try again." });
  }
  assert.equal(summarizeAdoptionOutput(output(report(), 2)).kind, "unreadable");
});

test("creator refusals explain why the preview failed", () => {
  assert.deepEqual(summarizeAdoptionOutput(output({ ok: false, error: "adopt target does not exist" }, 1)), {
    kind: "unreadable", message: "Setup preview could not be prepared: adopt target does not exist",
  });
});

test("pattern limits count Unicode code points like the installed creator", () => {
  const choice = { id: "capture", name: "😀".repeat(41), path: "notes/" + "😀".repeat(115) + ".md" };
  assert.equal(workspacePatternChoice.safeParse(choice).success, true);
  assert.equal(workspacePatternChoice.safeParse({ ...choice, name: "😀".repeat(81) }).success, false);
  assert.equal(workspacePatternChoice.safeParse({ ...choice, path: "😀".repeat(238) + ".md" }).success, false);
  assert.equal(workspacePatternState.safeParse({ ok: true, catalog: [], choices: [choice] }).success, true);
});
