import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const workbench = dirname(dirname(fileURLToPath(import.meta.url)));
const core = dirname(realpathSync(join(workbench, "node_modules/@agent-native/core/package.json")));
const { parseHTML } = createRequire(join(core, "package.json"))("linkedom");
const { captureCommandMenuFocus, restoreCommandMenuFocus } = await import(pathToFileURL(join(core, "dist/client/command-menu-focus.js")).href);

function fixture() {
  const view = parseHTML("<!doctype html><html><body><button id='search'>Search Vivary</button><button id='keyboard'>Keyboard opener</button><input id='other'><div id='menu'><input id='query'></div></body></html>");
  view.location = new URL("http://127.0.0.1/?project=alpha");
  const document = view.document;
  let focused = document.body;
  const focusCalls = [];
  view.HTMLElement.prototype.focus = function focus(options) { focused = this; focusCalls.push({ element: this, options }); };
  Object.defineProperty(document, "activeElement", { get: () => focused?.isConnected ? focused : document.body });
  const element = id => document.getElementById(id);
  return { view, document, focusCalls, element,
    close(snapshot) {
      const content = element("menu");
      content.addEventListener("closeAutoFocus", event => restoreCommandMenuFocus(snapshot, event), { once: true });
      content.remove();
      const event = new view.Event("closeAutoFocus", { cancelable: true });
      content.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true, "the controlled menu replaces Radix's missing-trigger fallback");
    } };
}

for (const id of ["search", "keyboard"]) test("closing restores the connected " + id + " opener", () => {
  const f = fixture();
  const opener = f.element(id);
  opener.focus();
  const snapshot = captureCommandMenuFocus(f.element("menu"));
  f.element("query").focus();
  f.close(snapshot);
  assert.equal(f.document.activeElement === opener, true);
  assert.deepEqual(f.focusCalls.at(-1).options, { preventScroll: true });
});

test("closing leaves another control's focus in place", () => {
  const f = fixture();
  f.element("search").focus();
  const snapshot = captureCommandMenuFocus(f.element("menu"));
  f.element("query").focus();
  f.element("other").focus();
  f.close(snapshot);
  assert.equal(f.document.activeElement === f.element("other"), true);
  assert.equal(f.focusCalls.filter(call => call.element === f.element("search")).length, 1);
});

for (const change of ["path", "query", "removed"]) test("closing does not restore after " + change + " changes", () => {
  const f = fixture();
  const opener = f.element("search");
  opener.focus();
  const snapshot = captureCommandMenuFocus(f.element("menu"));
  f.element("query").focus();
  if (change === "path") f.view.location = new URL("http://127.0.0.1/settings");
  if (change === "query") f.view.location = new URL("http://127.0.0.1/?project=beta");
  if (change === "removed") opener.remove();
  f.close(snapshot);
  assert.equal(f.document.activeElement === f.document.body, true);
  assert.equal(f.focusCalls.filter(call => call.element === opener).length, 1);
});

test("a menu opened without an external focusable invoker does not focus the page", () => {
  const f = fixture();
  const snapshot = captureCommandMenuFocus(f.element("menu"));
  f.element("query").focus();
  f.close(snapshot);
  assert.equal(f.document.activeElement === f.document.body, true);
  assert.equal(f.focusCalls.length, 1);
});

test("a delayed close event from an earlier menu does not restore the current menu's opener", () => {
  const f = fixture();
  const oldContent = f.element("menu");
  f.element("search").focus();
  captureCommandMenuFocus(oldContent);
  const nextContent = f.document.createElement("div");
  const nextInput = f.document.createElement("input");
  nextContent.appendChild(nextInput);
  f.document.body.appendChild(nextContent);
  f.element("keyboard").focus();
  const current = captureCommandMenuFocus(nextContent);
  nextInput.focus();
  oldContent.addEventListener("closeAutoFocus", event => restoreCommandMenuFocus(current, event), { once: true });
  oldContent.remove();
  oldContent.dispatchEvent(new f.view.Event("closeAutoFocus", { cancelable: true }));
  assert.equal(f.document.activeElement === nextInput, true, "an older close callback cannot take focus from the reopened menu");
});
