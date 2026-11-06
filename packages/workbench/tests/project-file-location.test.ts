import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectFileHref, requestedLine } from "../app/lib/project-file-location.ts";

describe("project file location", () => {
  it("builds a file href that keeps other params and only carries a valid line", () => {
    assert.equal(projectFileHref("project_a", "src/index.ts"), "/?panel=files&project=project_a&path=src%2Findex.ts");
    assert.equal(projectFileHref("project_a", "src/index.ts", "thread=t1&line=9", 42),
      "/?thread=t1&line=42&panel=files&project=project_a&path=src%2Findex.ts");
    assert.equal(projectFileHref("project_a", "a b/é.md", "line=7"), "/?panel=files&project=project_a&path=a+b%2F%C3%A9.md");
    for (const line of [0, -1, 1.5, Number.NaN, 10_000_001]) {
      assert.equal(new URLSearchParams(projectFileHref("p", "f", "", line).slice(2)).has("line"), false, String(line));
    }
  });

  it("parses only positive integer lines within bounds", () => {
    assert.equal(requestedLine("3"), 3);
    assert.equal(requestedLine("10000000"), 10_000_000);
    for (const value of [null, undefined, "", "0", "-1", "abc", "1e3", "01", "3.5", "10000001", "99999999999"]) {
      assert.equal(requestedLine(value), null, String(value));
    }
  });
});
