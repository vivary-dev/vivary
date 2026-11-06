import assert from "node:assert/strict";
import test from "node:test";
import { focusAfterRemoval } from "../app/lib/row-focus.ts";

// Issue #131. Archive removes its row and the menu trigger that focus would have returned to.
test("focus goes to the row that took the removed row's place", () => {
  assert.equal(focusAfterRemoval(["first", "third"], 1, "new"), "third");
});

test("focus goes to the row before when the last row was removed", () => {
  assert.equal(focusAfterRemoval(["first", "second"], 2, "new"), "second");
});

test("focus goes to the fallback when no row is left", () => {
  assert.equal(focusAfterRemoval([], 0, "new"), "new");
  assert.equal(focusAfterRemoval([], 0, null), null);
});
