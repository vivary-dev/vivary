import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Issue #145. A saved Native thread takes its fallback title from the first user message with text and its preview from
// the last. Vivary's composer appends the project's context to each message in a <context> block the owner never typed.
const WORKBENCH = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = dirname(realpathSync(join(WORKBENCH, "node_modules", "@agent-native", "core", "package.json")));
const { extractThreadMeta } = await import(pathToFileURL(join(CORE, "dist", "agent", "thread-data-builder.js")).href);
const { appendAgentChatContextToMessage } = await import(pathToFileURL(join(CORE, "dist", "shared", "agent-chat-context.js")).href);

const threadWith = (...texts) => ({ messages: texts.map((text, index) => ({
  message: { id: `user-${index}`, role: "user", content: [{ type: "text", text }] }, parentId: null })) });
const context = "## Field notes\nResource context: workspace-app:vivary-project-a (project notes)";

test("a thread's fallback title and preview leave out the context the composer appends", () => {
  const meta = extractThreadMeta(threadWith(appendAgentChatContextToMessage("Sea stars", context)));
  assert.deepEqual(meta, { title: "Sea stars", preview: "Sea stars" });
});

test("a message with only context gives no title, and a later message still sets the preview", () => {
  const meta = extractThreadMeta(threadWith(appendAgentChatContextToMessage("", context),
    appendAgentChatContextToMessage("Kelp forest", context)));
  assert.deepEqual(meta, { title: "Kelp forest", preview: "Kelp forest" });
});

test("context tags the owner typed stay in the title", () => {
  for (const typed of ['Explain "<context>" in XML', "Close it with </context> please", "<context>notes</context> are tags"]) {
    assert.deepEqual(extractThreadMeta(threadWith(appendAgentChatContextToMessage(typed, context))),
      { title: typed, preview: typed }, typed);
  }
});

test("the title comes from the first message with text and the preview from the last", () => {
  assert.deepEqual(extractThreadMeta(threadWith(appendAgentChatContextToMessage("Sea stars", context),
    appendAgentChatContextToMessage("Kelp forest", context))), { title: "Sea stars", preview: "Kelp forest" });
});

test("context that itself holds a context block stays out of the title", () => {
  const nested = `${context}\n\n<context>\nexample\n</context>`;
  assert.deepEqual(extractThreadMeta(threadWith(appendAgentChatContextToMessage("Sea stars", nested))),
    { title: "Sea stars", preview: "Sea stars" });
});

test("a title override wins, and the preview still leaves out the context", () => {
  const thread = { ...threadWith(appendAgentChatContextToMessage("Sea stars", context)), _titleOverride: "Rock pools" };
  assert.deepEqual(extractThreadMeta(thread), { title: "Rock pools", preview: "Sea stars" });
});

test("a message saved without appended context keeps its text, context tags included", () => {
  for (const typed of ["Sea stars", 'Explain "<context>" in XML', "Explain\n\n<context>\nexample\n</context>\nKeep this sentence."]) {
    assert.deepEqual(extractThreadMeta(threadWith(typed)), { title: typed, preview: typed }, typed);
  }
});

// Core records no boundary between the owner's text and the appended context, and an app may put any text in the
// context. Hidden context must not show, so text after a block the owner typed in the envelope's shape is left out too.
test("hidden context never shows, even after a block the owner typed in the same shape", () => {
  const typed = "Explain\n\n<context>\nexample\n</context>\nKeep this sentence.";
  assert.deepEqual(extractThreadMeta(threadWith(appendAgentChatContextToMessage(typed, context))),
    { title: "Explain", preview: "Explain" });
});
