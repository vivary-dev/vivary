import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { act } from "react";

// The sidebar header shows the approved Vivary mark. The Sidebar component and its router link are real. Project
// navigation, history and the command menu are stubbed. The PNG is bundled as a data URL so its bytes can be compared
// with the site mark that the Windows icon is made from.
const workbench = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const coreRequire = createRequire(require.resolve("@agent-native/core/client/agent-chat"));
const { window } = coreRequire("linkedom").parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement,
  Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const stubs = new Map([
  ["@agent-native/core/client/navigation", "export const openCommandMenu = () => {};"],
  ["../projects/ProjectContext", "export const useProjects = () => ({ activeProject: null });"],
  ["../projects/ProjectNavigation", "export const ProjectNavigation = () => null;"],
  ["./ProjectHistory", "export const ProjectHistory = () => null;"],
  ["./ConversationInbox", "export const ConversationInbox = () => null;"],
  ["./ChatHistory", "export const ChatHistory = () => null;"],
  ["./use-vivary-chat-identity", "export const useVivaryChatIdentity = () => ({ identity: null });"],
  ["@tabler/icons-react", "export const IconBook2 = () => null; export const IconLayoutSidebarLeftCollapse = () => null;"
    + " export const IconSearch = () => null; export const IconSettings = () => null;"],
]);
const bundle = await build({ stdin: { contents: `
  import { createElement } from "react";
  import { MemoryRouter } from "react-router";
  import { Sidebar } from "./app/components/layout/Sidebar";
  export const view = () => createElement(MemoryRouter, null, createElement(Sidebar, {}));`,
  loader: "tsx", resolveDir: workbench }, bundle: true, write: false, format: "cjs", platform: "node",
  jsx: "automatic", loader: { ".png": "dataurl" }, external: ["react", "react/*", "react-dom/*", "react-router"],
  plugins: [{ name: "host-services", setup(build) {
    build.onResolve({ filter: /.*/ }, args => stubs.has(args.path) ? { path: args.path, namespace: "host" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "host" }, args => ({ contents: stubs.get(args.path), loader: "tsx", resolveDir: workbench }));
  } }] });
const module = { exports: {} };
compileFunction(bundle.outputFiles[0].text, ["require", "module", "exports"])(require, module, module.exports);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

test("the sidebar header shows the approved Vivary mark with alt text instead of a letter", async () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(module.exports.view()));
    const link = host.querySelector(".vivary-sidebar-brand a");
    assert.equal(link.getAttribute("aria-label"), "Vivary home", "the link keeps its accessible name");
    const mark = link.querySelector("img.vivary-mark");
    assert.ok(mark, "the header renders an image");
    assert.equal(mark.getAttribute("alt"), "Vivary");
    assert.equal(mark.getAttribute("width"), "27");
    assert.equal(mark.getAttribute("height"), "27");
    assert.equal(link.textContent.trim(), "Vivary", "the letter placeholder is gone");
    const source = mark.getAttribute("src");
    assert.ok(source.startsWith("data:image/png;base64,"));
    const bundled = Buffer.from(source.slice("data:image/png;base64,".length), "base64");
    const siteMark = readFileSync(new URL("../../../site/src/assets/vivary-mark.png", import.meta.url));
    assert.equal(digest(bundled), digest(siteMark), "the app reuses the site mark, the source of the Windows icon");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
