import assert from "node:assert/strict";
import { test } from "node:test";
import { documentationLink, resolveDocumentationLinks } from "../app/lib/documentation-links.ts";

test("documentation links resolve to explicit online pages", () => {
  assert.equal(documentationLink("SEMANTIC-MEMORY.md"),
    "https://github.com/vivary-dev/vivary/blob/dev/docs/SEMANTIC-MEMORY.md");
  assert.equal(documentationLink("COMMANDS.md#vivary--the-front-door"),
    "https://github.com/vivary-dev/vivary/blob/dev/docs/COMMANDS.md#vivary--the-front-door");
  assert.equal(documentationLink("/concepts/"), "https://vivary.vercel.app/concepts/");
  assert.equal(documentationLink("../packages/workbench/server/local-access.ts"),
    "https://github.com/vivary-dev/vivary/blob/dev/packages/workbench/server/local-access.ts");
  assert.equal(documentationLink("../.agents/skills/maintain-hldd/SKILL.md"),
    "https://github.com/vivary-dev/vivary/blob/dev/.agents/skills/maintain-hldd/SKILL.md");
  assert.equal(documentationLink("../packages"),
    "https://github.com/vivary-dev/vivary/tree/dev/packages");
  assert.equal(documentationLink("https://github.com/vivary-dev/vivary/tree/dev/packages"),
    "https://github.com/vivary-dev/vivary/tree/dev/packages");
});

test("documentation links reject unsupported destinations", () => {
  for (const href of [
    "javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd",
    "https://user:pass@example.com", "//example.com/path",
    "/private", "../../README.md", "",
  ]) {
    assert.equal(documentationLink(href), null, href);
  }
});

test("Markdown anchors carry resolved destinations before rendering", () => {
  assert.equal(
    resolveDocumentationLinks("[catalog](product/multi-project/specification/modules.md) [section](#original-engine)"),
    "[catalog](https://github.com/vivary-dev/vivary/blob/dev/docs/product/multi-project/specification/modules.md) [section](#original-engine)",
  );
  assert.equal(resolveDocumentationLinks("[unsafe](javascript:alert(1))"), "[unsafe](#))");
});
