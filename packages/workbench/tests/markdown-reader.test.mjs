import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

// Markdown files and the design document render through Toolkit's SharedRichEditor. The proof builds
// a TipTap editor from the extension list SharedRichEditor builds, with the read-only options the
// Files and Architecture routes pass, and checks the document, HTML, and Markdown read back.
const HERE = dirname(fileURLToPath(import.meta.url));
const WORKBENCH = resolve(HERE, "..");
const CORE = dirname(realpathSync(join(WORKBENCH, "node_modules", "@agent-native", "core", "package.json")));
const TOOLKIT = dirname(realpathSync(join(WORKBENCH, "node_modules", "@agent-native", "toolkit", "package.json")));
const EDITOR = join(TOOLKIT, "dist", "editor");

const markdown = [
  "# Release notes",
  "",
  "Intro with **bold**, *italic*, `code` and a [link](https://example.test/docs).",
  "",
  "## Checklist",
  "",
  "- [x] shipped",
  "- [ ] pending",
  "",
  "1. first",
  "2. second",
  "",
  "> quoted",
  "",
  "```js",
  "const answer = 42;",
  "```",
  "",
  "| Name | Value |",
  "| --- | --- |",
  "| alpha | 1 |",
].join("\n");

const proofSource = `
import { Editor } from "@tiptap/core";
import { createSharedEditorExtensions } from "./extensions.js";
import { getEditorMarkdown } from "./useCollabReconcile.js";

export function readMarkdown(value) {
  const editor = new Editor({
    extensions: createSharedEditorExtensions({ dialect: "gfm", preset: "plan",
      features: { image: false, tables: true, tasks: true, link: true }, extraExtensions: [], collab: null }),
    content: value,
    editable: false,
  });
  try {
    return { json: editor.getJSON(), html: editor.getHTML(), markdown: getEditorMarkdown(editor) };
  } finally {
    editor.destroy();
  }
}
`;

async function buildProof() {
  const result = await esbuild.build({
    stdin: { contents: proofSource, resolveDir: EDITOR, sourcefile: "markdown-reader-proof.js", loader: "js" },
    absWorkingDir: WORKBENCH,
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"development"' },
  });
  return result.outputFiles[0].text;
}

function installDom() {
  // Core declares linkedom. Toolkit does not, so resolving it there relies on pnpm's hoisting.
  const linkedom = createRequire(join(CORE, "package.json"))("linkedom");
  const view = linkedom.parseHTML("<!doctype html><html><head></head><body></body></html>");
  // TipTap parses rendered Markdown as `<body>…</body>`, which linkedom drops unless the markup is a
  // whole document. linkedom's window ignores assignments, so a proxy supplies the parser.
  class DOMParser {
    parseFromString(markup, type) {
      return new view.DOMParser().parseFromString(`<!doctype html><html>${markup}</html>`, type);
    }
  }
  // ProseMirror's view also reads the selection, styles, frames, and window size. linkedom has none.
  const selection = { rangeCount: 0, anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, isCollapsed: true,
    removeAllRanges() {}, addRange() {}, collapse() {}, extend() {} };
  view.document.getSelection = () => selection;
  const blankDocument = () => linkedom.parseHTML("<!doctype html><html><head></head><body></body></html>").document;
  Object.defineProperty(view.document, "implementation", { configurable: true, value: { createHTMLDocument: blankDocument } });
  // tiptap-markdown reads each task checkbox's `checked`, which linkedom does not reflect from the attribute.
  Object.defineProperty(view.HTMLInputElement.prototype, "checked", { configurable: true,
    get() { return this.hasAttribute("checked"); },
    set(checked) { if (checked) this.setAttribute("checked", ""); else this.removeAttribute("checked"); } });
  class MutationObserver { observe() {} disconnect() {} takeRecords() { return []; } }
  const shims = { DOMParser, MutationObserver, getSelection: () => selection, innerHeight: 800, innerWidth: 1200,
    getComputedStyle: () => new Proxy({ getPropertyValue: () => "" }, { get: (style, name) => style[name] ?? "" }),
    requestAnimationFrame: callback => setTimeout(() => callback(Date.now()), 0), cancelAnimationFrame: id => clearTimeout(id) };
  const window = new Proxy(view, { get: (target, name) => (name in shims ? shims[name] : Reflect.get(target, name)) });
  const values = { window, self: window, document: view.document, navigator: view.navigator, ...shims,
    HTMLElement: view.HTMLElement, Element: view.Element, Node: view.Node, Event: view.Event };
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
}

test("a Markdown file keeps its GFM structure through the shared TipTap editor", async (t) => {
  installDom();
  // A file keeps failure stacks readable, which a data: URL of the whole bundle does not.
  const folder = mkdtempSync(join(tmpdir(), "vivary-markdown-reader-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const bundle = join(folder, "proof.mjs");
  writeFileSync(bundle, await buildProof());
  const proof = await import(pathToFileURL(bundle).href);
  const { json, html, markdown: readBack } = proof.readMarkdown(markdown);

  assert.deepEqual(json.content.map((block) => block.type),
    ["heading", "paragraph", "heading", "taskList", "orderedList", "blockquote", "codeBlock", "table"]);
  assert.deepEqual(json.content.filter((block) => block.type === "heading").map((block) => block.attrs.level), [1, 2]);
  assert.deepEqual(json.content[3].content.map((item) => item.attrs.checked), [true, false]);
  assert.equal(json.content[6].attrs.language, "js");
  assert.deepEqual(json.content[1].content.flatMap((text) => (text.marks ?? []).map((mark) => mark.type)),
    ["bold", "italic", "code", "link"]);
  assert.equal(html, [
    "<h1>Release notes</h1>",
    "<p>Intro with <strong>bold</strong>, <em>italic</em>, <code>code</code> and a ",
    '<a href="https://example.test/docs" class="an-rich-md-link" rel="noopener noreferrer nofollow" target="_blank">link</a>.</p>',
    "<h2>Checklist</h2>",
    '<ul data-type="taskList" class="an-rich-md-task-list">',
    '<li data-type="taskItem" data-checked="true"><label><input checked="checked" type="checkbox"><span></span></label><div><p>shipped</p></div></li>',
    '<li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>pending</p></div></li>',
    "</ul>",
    '<ol data-tight="true" class="tight"><li><p>first</p></li><li><p>second</p></li></ol>',
    "<blockquote><p>quoted</p></blockquote>",
    '<pre><code class="language-js">const answer = 42;</code></pre>',
    '<table style="min-width: 50px" class="an-rich-md-table"><colgroup><col style="min-width: 25px"><col style="min-width: 25px"></colgroup>',
    '<tbody><tr><th rowspan="1" colspan="1"><p>Name</p></th><th rowspan="1" colspan="1"><p>Value</p></th></tr>',
    '<tr><td rowspan="1" colspan="1"><p>alpha</p></td><td rowspan="1" colspan="1"><p>1</p></td></tr></tbody></table>',
  ].join(""));
  // The read-back matches the source except that the task list serializes loose.
  assert.equal(readBack, `${markdown.replace("- [x] shipped\n", "- [x] shipped\n\n")}\n`);
});

test.after(() => esbuild.stop());
