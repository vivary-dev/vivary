import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { committedQuery, incompleteCoverage, isCurrentSearch, reduceSearchPages, summarize } from "../app/lib/project-search-state.ts";
import type { ProjectSearchResult } from "../app/lib/project-search-schema.ts";

const project = { projectId: "project_a", label: "Example", rootId: "root_a", bindingId: "binding_a", bindingRevision: 1, policyRevision: 1 };
const request = { projectId: "project_a", query: "needle", mode: "text" as const };
function page(overrides: Partial<Extract<ProjectSearchResult, { code: "results" }>> = {}): ProjectSearchResult {
  return { code: "results", project, query: "needle", mode: "text", files: [], matches: [], scannedEntries: 10,
    readFiles: 4, regexTimeouts: 0, truncated: null, continueAfter: null, elapsedMs: 5, ...overrides };
}
const match = (path: string, line = 1) => ({ path, line, column: 1, excerpt: "needle" });

describe("project search state", () => {
  it("commits only trimmed queries of at least two characters", () => {
    assert.equal(committedQuery("  needle  "), "needle");
    assert.equal(committedQuery(" n "), "");
    assert.equal(committedQuery(""), "");
    assert.equal(committedQuery("x".repeat(250)).length, 200);
  });

  it("treats a response as current only when it echoes project, query, and mode", () => {
    assert.equal(isCurrentSearch(page(), request), true);
    assert.equal(isCurrentSearch(page({ query: "other" }), request), false);
    assert.equal(isCurrentSearch(page({ mode: "regex" }), request), false);
    assert.equal(isCurrentSearch(page({ project: { ...project, projectId: "project_b" } }), request), false);
    assert.equal(isCurrentSearch(undefined, request), false);
  });

  it("replaces on a fresh page, appends only along the returned cursor, and ignores the rest", () => {
    const first = reduceSearchPages(null, page({ matches: [match("a.md")], truncated: "matches", continueAfter: "a.md" }), request, undefined);
    assert.ok(first);
    assert.deepEqual(first?.matches.map(m => m.path), ["a.md"]);
    const stale = reduceSearchPages(first, page({ query: "other", matches: [match("z.md")] }), request, undefined);
    assert.equal(stale, first);
    const skipped = reduceSearchPages(first, page({ matches: [match("c.md")] }), request, "b.md");
    assert.equal(skipped, first);
    const second = reduceSearchPages(first, page({ matches: [match("b.md")], scannedEntries: 3, elapsedMs: 2 }), request, "a.md");
    assert.deepEqual(second?.matches.map(m => m.path), ["a.md", "b.md"]);
    assert.equal(second?.truncated, null);
    assert.equal(second?.continueAfter, null);
    assert.equal(second?.scannedEntries, 13);
    assert.equal(second?.elapsedMs, 7);
    const replaced = reduceSearchPages(second, page({ matches: [match("q.md")] }), request, undefined);
    assert.deepEqual(replaced?.matches.map(m => m.path), ["q.md"]);
  });

  it("never continues pages across a rebound project", () => {
    const first = reduceSearchPages(null, page({ matches: [match("a.md")], truncated: "matches", continueAfter: "a.md" }), request, undefined);
    const rebound = reduceSearchPages(first, page({ matches: [match("b.md")], project: { ...project, bindingRevision: 2 } }), request, "a.md");
    assert.equal(rebound, null);
    const replaced = reduceSearchPages(first, page({ matches: [match("b.md")], project: { ...project, bindingRevision: 2 } }), request, undefined);
    assert.deepEqual(replaced?.matches.map(m => m.path), ["b.md"]);
    assert.equal(replaced?.identity.bindingRevision, 2);
  });

  it("knows when coverage was incomplete", () => {
    assert.equal(incompleteCoverage(reduceSearchPages(null, page(), request, undefined)!), false);
    assert.equal(incompleteCoverage(reduceSearchPages(null, page({ truncated: "entries", continueAfter: "x.md" }), request, undefined)!), true);
    assert.equal(incompleteCoverage(reduceSearchPages(null, page({ regexTimeouts: 1 }), request, undefined)!), true);
  });

  it("carries an invalid pattern as a message instead of results", () => {
    const invalid = reduceSearchPages(null, { code: "invalid-pattern", project, query: "needle", mode: "regex", reason: "Invalid regular expression: /needle(/u: Unterminated group" },
      { ...request, mode: "regex" }, undefined);
    assert.equal(invalid?.invalidPattern?.includes("Unterminated group"), true);
    assert.deepEqual(invalid?.matches, []);
    assert.equal(summarize(invalid!), "");
  });

  it("summarizes counts, scope, and the truncation reason", () => {
    const pages = reduceSearchPages(null, page({ matches: [match("a.md"), match("a.md", 2), match("b.md")], truncated: "time", continueAfter: "b.md" }), request, undefined);
    assert.equal(summarize(pages!), "3 matches in 2 files · 10 entries in 5 ms · stopped at the time budget");
    const one = reduceSearchPages(null, page({ matches: [match("a.md")] }), request, undefined);
    assert.equal(summarize(one!), "1 match in 1 file · 10 entries in 5 ms");
    const files = reduceSearchPages(null, page({ mode: "filename", files: [{ path: "a.md", name: "a.md" }] }), { ...request, mode: "filename" }, undefined);
    assert.equal(summarize(files!), "1 file · 10 entries in 5 ms");
    const slow = reduceSearchPages(null, page({ mode: "regex", regexTimeouts: 2 }), { ...request, mode: "regex" }, undefined);
    assert.equal(summarize(slow!), "0 matches in 0 files · 10 entries in 5 ms · 2 files skipped: pattern too slow");
  });
});
