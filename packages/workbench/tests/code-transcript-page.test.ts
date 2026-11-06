import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { codeAgentRunTranscriptPath } from "@agent-native/core/code-agents";
import { readCodeTranscriptPage, readCodeTranscriptWindow } from "../server/code-transcript-page.ts";
const temporary = await mkdtemp(path.join(os.tmpdir(), "vivary-transcript-page-"));
// guard:allow-env-mutation - This process owns its disposable transcript fixture.
process.env.AGENT_NATIVE_CODE_AGENTS_HOME = temporary;
await mkdir(path.dirname(codeAgentRunTranscriptPath("partial")), { recursive: true });
test.after(async () => { await rm(temporary, { recursive: true, force: true }); });
test("unterminated final lines retain their offset until the active writer completes them", async () => {
  const line = JSON.stringify({ runId: "partial", id: "evt-partial", kind: "user", message: "still writing" });
  await writeFile(codeAgentRunTranscriptPath("partial"), line.slice(0, -2));
  const partial = await readCodeTranscriptPage("partial");
  assert.deepEqual(partial.entries, []); assert.equal(partial.nextOffset, 0); assert.equal(partial.done, true);
  assert.equal(partial.limited, false);
  await appendFile(codeAgentRunTranscriptPath("partial"), line.slice(-2));
  assert.deepEqual((await readCodeTranscriptPage("partial", partial.nextOffset)).entries, []);
  await appendFile(codeAgentRunTranscriptPath("partial"), "\n");
  assert.equal((await readCodeTranscriptPage("partial", partial.nextOffset)).entries[0]?.event.id, "evt-partial");
});
test("anchored transcript windows include earlier and later context within four hundred events", async () => {
  const lines = Array.from({ length: 800 }, (_, i) => JSON.stringify({ runId: "window", id: `evt-${i}`, kind: "user", message: `Saved ${i}` }) + "\n");
  await writeFile(codeAgentRunTranscriptPath("window"), lines.join(""));
  const offset = Buffer.byteLength(lines.slice(0, 300).join(""));
  const window = await readCodeTranscriptWindow("window", offset);
  assert.equal(window.anchor?.id, "evt-300"); assert.equal(window.entries[0].event.id, "evt-240");
  assert.equal(window.entries.at(-1)?.event.id, "evt-639"); assert.equal(window.entries.length, 400);
});
