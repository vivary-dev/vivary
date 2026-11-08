import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// PR #258 review. Execute the actual blocks from CodeConversation.tsx that decide where a runtime switch reply goes.
const source = await readFile(new URL("../app/components/workspace/CodeConversation.tsx", import.meta.url), "utf8");
function block(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `CodeConversation.tsx no longer has the block starting ${JSON.stringify(from)}`);
  // The only TypeScript in these blocks is generic arguments and parameter types, which plain JavaScript cannot parse.
  return source.slice(start, end).replace(/<VivaryCodeState>/g, "").replace(/\(key: string, choice: ModelChoice\)/, "(key, choice)");
}

test("a switch reply updates only the conversation that asked for it", () => {
  const compile = new Function("useCallback", "setSelection",
    block("  const onChoice = useCallback(", "\n\n") + "\nreturn onChoice;\n");
  let selection = { key: "conversation-b", runId: null, choice: { engine: "claude-cli", model: "claude-sonnet-5-5" } };
  const onChoice = compile(callback => callback, update => { selection = update(selection); });
  // Conversation A's reply arrives after the owner opened conversation B.
  onChoice("conversation-a", { engine: "codex-cli", model: "gpt-6-astra" });
  assert.deepEqual(selection.choice, { engine: "claude-cli", model: "claude-sonnet-5-5" }, "A's route overwrote B's choice");
  onChoice("conversation-b", { engine: "codex-cli", model: "gpt-6-astra" });
  assert.deepEqual(selection.choice, { engine: "codex-cli", model: "gpt-6-astra" }, "B's own choice is still saved");
  // The parent passes the conversation's own key with every choice.
  assert.match(source, /onChoice=\{choice => onChoice\(selection\.key, choice\)\}/);
});

test("a switch reply never replaces a saved-event replay's anchored transcript", () => {
  const compile = new Function("observed", "acceptedRun", "setAcceptedRun", "queryClient", "useEffect",
    block("  const stateQueryKeys = [", "  const chatRef = useRef") + "\nreturn props;\n");
  const anchored = { id: "run-1", events: [{ id: "older-matched-event" }] };
  const accepted = { id: "run-1", events: [{ id: "latest-after-switch" }] };
  const queryClient = { getQueryData: () => undefined };   // the replay query is anchored, so no unanchored cache holds it
  function render(viewingMatch) {
    const cleared = [];
    const observed = { projectId: "p1", selection: { key: "k", runId: "run-1" }, run: anchored, viewingMatch, matchedEventId: viewingMatch ? "older-matched-event" : null };
    const props = compile(observed, accepted, value => cleared.push(value), queryClient, effect => effect());
    return { props, cleared };
  }
  const replay = render(true);
  assert.equal(replay.props.run, anchored, "the replay showed the switch reply instead of its anchored transcript");
  assert.deepEqual(replay.cleared, [null], "entering the replay ends the accepted-reply override");
  // The latest view still keeps the accepted reply until polling catches up.
  const latest = render(false);
  assert.equal(latest.props.run, accepted);
  assert.deepEqual(latest.cleared, []);
});
