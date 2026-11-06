import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";

const workbench = fileURLToPath(new URL("../", import.meta.url));
// guard:allow-env-credential - Disposable test paths and fixture behavior, not credentials.
const core = process.env.VIVARY_CORE_TEST_ROOT ?? path.join(workbench, "node_modules/@agent-native/core");
const renderer = await readFile(path.join(core, "dist/client/chat/message-components.js"), "utf8");
const start = renderer.indexOf("function parentMessageState(");
const helper = renderer.slice(start, renderer.indexOf("\n}\n", start) + 3);
const parentMessageState = compileFunction(`${helper}\nreturn parentMessageState;`)();

test("the parent walk stops at a parent the rendered thread no longer holds", () => {
  const lookups = [];
  const threadRuntime = { getMessageById: id => {
    lookups.push(id);
    return { getState: () => ({ id, role: "user" }) };
  } };
  const thread = { messages: [{ id: "user-1" }, { id: "assistant-1" }] };
  assert.deepEqual(parentMessageState(thread, threadRuntime, "user-1"), { id: "user-1", role: "user" });
  assert.equal(parentMessageState(thread, threadRuntime, "replaced-by-a-finished-run"), null);
  assert.deepEqual(lookups, ["user-1"], "a dropped parent is never looked up, so the store cannot throw");
});

test("both assistant message walks use the guard and recompute when the thread changes", () => {
  const body = renderer.slice(renderer.indexOf("export function AssistantMessage("));
  assert.equal(body.match(/parentMessageState\(thread, threadRuntime, parentId\)/g)?.length, 2);
  assert.equal(body.includes("getMessageById("), false);
  assert.ok(body.includes("}, [msg.parentId, thread.messages, threadRuntime]);"));
});
