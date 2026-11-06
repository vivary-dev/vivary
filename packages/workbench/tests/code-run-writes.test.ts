import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Beta ticket 06. The workbench server writes a Code run's status and phase only through the transition table, so
// no other server file creates a run record or passes `status` or `phase` to an update.
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server");
const TABLE = "code-run-transitions.ts";

/** Returns the source of each call's arguments, from the opening parenthesis to its match. */
function callArguments(source: string, callee: string): string[] {
  const calls: string[] = [];
  for (let at = source.indexOf(`${callee}(`); at !== -1; at = source.indexOf(`${callee}(`, at + 1)) {
    let depth = 0;
    for (let end = at + callee.length; end < source.length; end++) {
      if (source[end] === "(") depth++;
      else if (source[end] === ")" && --depth === 0) { calls.push(source.slice(at + callee.length, end + 1)); break; }
    }
  }
  return calls;
}

test("no server file outside the table writes a Code run's status or phase", async () => {
  const offenders: string[] = [];
  for (const file of (await readdir(SERVER, { recursive: true })).filter(name => /\.(ts|mts|mjs|js)$/.test(name))) {
    if (path.basename(file) === TABLE) continue;
    const source = await readFile(path.join(SERVER, file), "utf8");
    if (callArguments(source, "createCodeAgentRunRecord").length) offenders.push(`${file}: createCodeAgentRunRecord`);
    for (const args of callArguments(source, "updateCodeAgentRunRecord")) {
      if (/(^|[\s{,])(status|phase)\s*[:,}]/.test(args)) offenders.push(`${file}: ${args.replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }
  assert.deepEqual(offenders, []);
});
