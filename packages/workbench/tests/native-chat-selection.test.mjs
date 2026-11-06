import assert from "node:assert/strict";
import test from "node:test";
import { nativeChatSelectionKey, savedNativeThreadIsAvailable } from "../app/lib/native-chat-selection.ts";

const identity = {
  storageKey: "project-owner-one",
  kind: "project",
  projectId: "project-one",
  scope: { type: "workspace-app", id: "scope-one" },
};

test("saved Native selection uses its owner scope and keeps optimistic draft IDs", async () => {
  const requests = [];
  const call = async (name, input) => {
    requests.push({ name, input });
    return { record: { status: "cleared", text: "" } };
  };
  const absent = async (url, options) => {
    assert.match(url, /scopeType=workspace-app&scopeId=scope-one/);
    assert.equal(options.credentials, "same-origin");
    return new Response(null, { status: 404 });
  };
  assert.equal(await savedNativeThreadIsAvailable(identity, "new-thread", call, undefined, absent), true);
  assert.deepEqual(requests, [{ name: "vivary-chat-draft",
    input: { operation: "read", kind: "project", projectId: "project-one", threadId: "new-thread" } }]);
  assert.equal(await savedNativeThreadIsAvailable(identity, "missing", async () => ({ record: null }), undefined, absent), false);
  assert.notEqual(nativeChatSelectionKey(identity.storageKey), nativeChatSelectionKey("another-project"));
});

test("an archived owned thread cannot be restored even when it has a draft", async () => {
  let draftReads = 0;
  const call = async () => { draftReads++; return { record: { status: "draft", text: "retained" } }; };
  const archived = async () => Response.json({ id: "saved-thread", archivedAt: Date.now() });
  const active = async () => Response.json({ id: "saved-thread", archivedAt: null });
  assert.equal(await savedNativeThreadIsAvailable(identity, "saved-thread", call, undefined, archived), false);
  assert.equal(await savedNativeThreadIsAvailable(identity, "saved-thread", call, undefined, active), true);
  assert.equal(draftReads, 0);
});

test("a failed Native ownership check is not mistaken for an archived thread", async () => {
  await assert.rejects(
    savedNativeThreadIsAvailable(identity, "saved-thread", async () => ({ record: null }),
      undefined, async () => new Response(null, { status: 503 })),
    /could not be verified/,
  );
});
