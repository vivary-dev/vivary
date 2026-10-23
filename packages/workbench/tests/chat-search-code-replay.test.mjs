import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { compileFunction } from "node:vm";

// Use the existing codex-transcript test's pure-builder loading pattern; the full client entry imports CSS.
const core = new URL("../node_modules/@agent-native/core/dist/", import.meta.url);
const dependencies = await import(new URL("code-agents/transcript-normalizer.js", core));
const builderSource = (await readFile(new URL("agent/thread-data-builder.js", core), "utf8"))
  .replace(/^import [\s\S]*?;\n/gm, "").replace(/^export /gm, "");
const builder = compileFunction(builderSource + "\nreturn buildRepositoryFromCodeAgentTranscript;",
  ["normalizeCodeAgentTranscript", "isCredentialGapCodeAgentEvent"])(
  dependencies.normalizeCodeAgentTranscript, dependencies.isCredentialGapCodeAgentEvent);
const source = stripTypeScriptTypes((await readFile(new URL("../app/lib/code-match-repository.ts", import.meta.url), "utf8"))
  .replace(/^import .*;\n/gm, "")).replace(/^export /gm, "");
const { codeMatchRepository, codeMatchMessageId } = compileFunction(source + "\nreturn { codeMatchRepository, codeMatchMessageId };",
  ["buildRepositoryFromCodeAgentTranscript"])(builder);

test("a normally hidden Code lifecycle event gets an exact transient replay row without changing the transcript", () => {
  const events = [{ schemaVersion: 1, id: "evt-lifecycle", runId: "saved-run", kind: "status",
    message: "Saved lifecycle searchneedle", createdAt: "2026-01-01T00:00:00.000Z", metadata: { status: "completed" } }];
  const before = JSON.stringify(events);
  assert.equal(codeMatchMessageId(builder(events), events[0].id), null);
  const replay = codeMatchRepository(events, events[0].id);
  assert.equal(codeMatchMessageId(replay, events[0].id), "code-search-evt-lifecycle");
  assert.match(replay.messages.at(-1).message.content[0].text, /Saved lifecycle searchneedle/);
  assert.equal(JSON.stringify(events), before);
});

test("a normally visible Code user event retains its canonical row instead of adding a duplicate", () => {
  const events = [{ schemaVersion: 1, id: "evt-user", runId: "saved-run", kind: "user",
    message: "Saved user searchneedle", createdAt: "2026-01-01T00:00:00.000Z" }];
  const original = builder(events);
  const replay = codeMatchRepository(events, events[0].id);
  assert.equal(codeMatchMessageId(replay, events[0].id), original.messages[0].message.id);
  assert.deepEqual(replay, original);
});

for (const position of [0, 1, 2]) test(`hidden Code event at position ${position} keeps chronological context and the parent chain`, () => {
  const event = (id, kind, message) => ({ schemaVersion: 1, id, runId: "saved-run", kind, message,
    createdAt: "2026-01-01T00:00:00.000Z" });
  const events = [event("before", "user", "Earlier turn"), event("after", "user", "Later turn")];
  events.splice(position, 0, event("hidden", "status", "Saved status"));
  const before = JSON.stringify(events), original = builder(events);
  const replay = codeMatchRepository(events, "hidden");
  const ids = replay.messages.map(entry => entry.message.id);
  const expected = original.messages.map(entry => entry.message.id);
  expected.splice(position, 0, "code-search-hidden");
  assert.deepEqual(ids, expected);
  assert.deepEqual(replay.messages.map(entry => entry.parentId), [null, ...ids.slice(0, -1)]);
  assert.equal(replay.headId, ids.at(-1));
  assert.equal(JSON.stringify(events), before);
  assert.deepEqual(builder(events), original, "replay must not change the normal builder's repository");
});

test("a runtime switch note renders as its own divider row between the turns it separates", () => {
  const event = (id, kind, message, metadata) => ({ schemaVersion: 1, id, runId: "saved-run", kind, message,
    createdAt: "2026-01-01T00:00:00.000Z", ...(metadata ? { metadata } : {}) });
  const note = "Switched from Claude Code Sonnet 5.5 to Codex GPT_6 *Astra*. The next message starts a new Codex session.";
  const events = [event("first", "user", "Earlier turn"),
    event("reply", "system", "Earlier reply", { role: "assistant" }),
    event("switch", "note", note, { source: "vivary-runtime-switch", from: { engine: "claude-cli", model: "claude-sonnet-5-5" },
      to: { engine: "codex-cli", model: "gpt-6-astra" }, switchedAt: "2026-01-01T00:00:00.000Z" }),
    event("second", "user", "Later turn")];
  const before = JSON.stringify(events);
  // Core alone folds the note into the reply before it.
  const folded = builder(events);
  assert.match(JSON.stringify(folded.messages[1].message.content), /Earlier reply[\s\S]*Switched from/);
  const repository = codeMatchRepository(events);
  const ids = repository.messages.map(entry => entry.message.id);
  assert.equal(ids.length, 4);
  assert.equal(ids[2], "code-switch-switch");
  assert.deepEqual(repository.messages.map(entry => entry.parentId), [null, ...ids.slice(0, -1)]);
  assert.equal(repository.headId, ids.at(-1));
  assert.doesNotMatch(JSON.stringify(repository.messages[1].message.content), /Switched from/, "the reply keeps only its own text");
  const divider = repository.messages[2].message;
  assert.equal(divider.role, "assistant");
  assert.equal(divider.content[0].text,
    "---\n\n*Switched from Claude Code Sonnet 5.5 to Codex GPT\\_6 \\*Astra\\*. The next message starts a new Codex session.*");
  // A search hit on the switch opens that row. It is not added twice.
  assert.equal(codeMatchMessageId(repository, "switch"), "code-switch-switch");
  assert.deepEqual(codeMatchRepository(events, "switch"), repository);
  assert.equal(JSON.stringify(events), before);
});

test("a switch after the last turn becomes the head row", () => {
  const event = (id, kind, message, metadata) => ({ schemaVersion: 1, id, runId: "saved-run", kind, message,
    createdAt: "2026-01-01T00:00:00.000Z", ...(metadata ? { metadata } : {}) });
  const events = [event("first", "user", "Only turn"), event("reply", "system", "Only reply", { role: "assistant" }),
    event("switch", "note", "Switched.", { source: "vivary-runtime-switch" })];
  const repository = codeMatchRepository(events);
  assert.deepEqual(repository.messages.map(entry => entry.message.id).slice(-1), ["code-switch-switch"]);
  assert.equal(repository.headId, "code-switch-switch");
  // A project context note is its own muted status row too, never folded into the reply before it.
  const other = [events[0], events[1], event("context", "note", "Project context loaded.", { source: "vivary-project-context" })];
  const context = codeMatchRepository(other);
  assert.deepEqual(context.messages.map(entry => entry.message.id).slice(-1), ["code-context-context"]);
  assert.deepEqual(context.messages.at(-1).message.content, [{ type: "text", text: "Project context loaded." }]);
  assert.deepEqual(context.messages.at(-2).message.content, builder(other.slice(0, 2)).messages.at(-1).message.content,
    "the reply keeps only its own text");
  // Any other note keeps Core's rows.
  const plain = [events[0], events[1], event("plain", "note", "A plain note.")];
  assert.deepEqual(codeMatchRepository(plain), builder(plain));
});
