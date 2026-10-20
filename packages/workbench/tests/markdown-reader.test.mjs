import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

// The reader mounts the same editor in the page, where TipTap's table node view adds the wrapper.
export function mountedTable(value) {
  const element = document.createElement("div");
  const editor = new Editor({ element,
    extensions: createSharedEditorExtensions({ dialect: "gfm", preset: "plan",
      features: { image: false, tables: true, tasks: true, link: true }, extraExtensions: [], collab: null }),
    content: value,
    editable: false,
  });
  try {
    const table = element.querySelector("table.an-rich-md-table");
    return { wrapper: table?.parentElement?.className ?? null };
  } finally {
    editor.destroy();
  }
}

// The Files and Documentation readers pass footnotes: true. An editable document uses the
// factory's defaults, which leave footnotes off.
export function readMarkdown(value, { footnotes = false, editable = false } = {}) {
  const editor = new Editor({
    extensions: editable ? createSharedEditorExtensions({ dialect: "gfm" })
      : createSharedEditorExtensions({ dialect: "gfm", preset: "plan",
        features: { image: false, tables: true, tasks: true, link: true, footnotes }, extraExtensions: [], collab: null }),
    content: value,
    editable,
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

// Both tests share one bundle, because a second copy of Yjs in the process warns.
// A file keeps failure stacks readable, which a data: URL of the whole bundle does not.
const folder = mkdtempSync(join(tmpdir(), "vivary-markdown-reader-"));
let proofReady;
function loadProof() {
  proofReady ??= (async () => {
    installDom();
    const bundle = join(folder, "proof.mjs");
    writeFileSync(bundle, await buildProof());
    return import(pathToFileURL(bundle).href);
  })();
  return proofReady;
}

test("a Markdown file keeps its GFM structure through the shared TipTap editor", async () => {
  const proof = await loadProof();
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

// A selector run starts after the previous statement, so an at-rule such as @source does not join it.
// Only commas outside parentheses separate selectors, so :is(a, b) stays one selector.
function declarations(css, selector) {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selectors]) => selectors.slice(selectors.lastIndexOf(";") + 1).split(/,(?![^()]*\))/).map((item) => item.trim()).includes(selector));
  return Object.fromEntries(rules.flatMap(([, , body]) => body.split(";").map((item) => item.split(":").map((part) => part.trim()))
    .filter(([name, value]) => name && value)));
}

// linkedom has no layout, so this test pins the table rules and the reader DOM they select.
test("Markdown tables wrap ordinary cell text and scroll only when code or content cannot fit", async () => {
  const app = new URL("../app/", import.meta.url);
  const global = readFileSync(new URL("global.css", app), "utf8");
  const files = readFileSync(new URL("project-files.css", app), "utf8");
  // Chat: Core sets width:max-content, which keeps every cell on one line. The override must follow Core's import.
  assert.ok(global.indexOf(".agent-markdown-table-wrap > table") > global.indexOf("@agent-native/core/styles/agent-native.css"));
  assert.deepEqual(declarations(global, ".agent-markdown-table-wrap > table"), { width: "auto", "overflow-wrap": "break-word" });
  // The long-token spans the chat test below checks may break anywhere, so a long URL or hash does not widen the table.
  // Links are left out, so ordinary words in link text still break only at spaces.
  assert.deepEqual(declarations(global, ".agent-markdown-table-wrap .agent-markdown-long-token"), { "overflow-wrap": "anywhere" });
  assert.ok(!/\.agent-markdown-table-wrap[^{]*\ba\b[^{]*\{[^}]*anywhere/.test(global.replace(/\/\*[\s\S]*?\*\//g, "")),
    "no rule lets whole links break anywhere");
  assert.deepEqual(declarations(global, ".agent-markdown-table-wrap code"), { "white-space": "nowrap" });
  // Reader: the table stays a table with automatic layout, and TipTap's wrapper scrolls a table that cannot fit.
  assert.deepEqual(declarations(files, ".file-reading-surface .tiptap .tableWrapper"), { "overflow-x": "auto" });
  assert.deepEqual(declarations(files, ".file-reading-surface .tiptap table"), { "table-layout": "auto", "overflow-wrap": "break-word" });
  assert.deepEqual(declarations(files, ".file-reading-surface .tiptap table code"), { "white-space": "nowrap" });

  const proof = await loadProof();
  assert.deepEqual(proof.mountedTable("| Name | Value |\n| --- | --- |\n| alpha | 1 |"), { wrapper: "tableWrapper" },
    "the read-only reader renders the wrapper that scrolls wide tables");
});

// Chat replies render through Core's markdownComponents from the installed, patched package. The
// cells and links mark each unbroken run of 20 or more characters for the CSS above. The rendered
// text, the hrefs, inline code, and the copied HTML must stay what they would be without the marks.
const chatProofSource = `
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownComponents, markdownUrlTransform, onMarkdownReady, renderMarkdownToClipboardHtml } from "./markdown-renderer.js";

const render = (markdown, components) => renderToStaticMarkup(createElement(ReactMarkdown,
  { remarkPlugins: [remarkGfm], components, urlTransform: markdownUrlTransform }, markdown));
export const renderChat = markdown => render(markdown, markdownComponents);
// The same Markdown with Core's table wrapper only, which is how the cells rendered before the marks.
export const renderUnmarked = markdown => render(markdown, { table: markdownComponents.table });
export const copiedHtml = markdown => new Promise(resolve => onMarkdownReady(() => resolve(renderMarkdownToClipboardHtml(markdown))));
`;

let chatProofReady;
function loadChatProof() {
  chatProofReady ??= (async () => {
    const bundle = await esbuild.build({
      stdin: { contents: chatProofSource, resolveDir: join(CORE, "dist", "client", "chat"), sourcefile: "chat-table-proof.js", loader: "js" },
      bundle: true, write: false, platform: "node", format: "esm", target: "node22", logLevel: "silent",
      loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' },
      // react-dom/server's CommonJS build requires Node built-ins.
      banner: { js: `import { createRequire as createProofRequire } from "node:module";
const require = createProofRequire(${JSON.stringify(join(WORKBENCH, "package.json"))});` },
    });
    const file = join(folder, "chat-table-proof.mjs");
    writeFileSync(file, bundle.outputFiles[0].text);
    return import(pathToFileURL(file).href);
  })();
  return chatProofReady;
}

test("chat table cells and links mark long unbroken text without changing text, links, or code", async () => {
  const chat = await loadChatProof();

  const url = "https://github.com/vivary-dev/vivary/releases/download/desktop-preview-20261019/Vivary-Setup.exe.receipt.json?download=1&check=sha256";
  const hash = "abc123def456abc123def456abc123def456abc123def456abc123def456abcd";
  const path = "packages/workbench/node_modules/@agent-native/core/dist/styles/agent-conversation.css";
  const plain = "AbcdefghijklmnopqrstUVWXYZ0123456789-and-more";
  const source = [
    "| Source | Note | Size |",
    "| :--- | --- | ---: |",
    `| [${url}](${url}) | Authentication keeps the selected runtime | 12 |`,
    `| ${hash} | Prose with ordinary words and a [short link](https://example.test/notes) | 7 |`,
    `| \`${path}\` | Code stays whole: \`${path}\` | 1 |`,
    `| ${plain} | x | 2 |`,
  ].join("\n");
  const html = chat.renderChat(source);
  const before = chat.renderUnmarked(source);
  const linkedom = createRequire(join(CORE, "package.json"))("linkedom");
  const parse = (markup) => linkedom.parseHTML(`<!doctype html><html><body>${markup}</body></html>`).document;
  const marked = parse(html);
  const unmarked = parse(before);
  const cells = (doc) => [...doc.querySelectorAll("th, td")];
  const attributes = (cell) => [...cell.attributes].map((attribute) => `${attribute.name}=${attribute.value}`).join(" ");

  // Spans appear only on runs of 20 or more characters without whitespace, never inside code.
  assert.deepEqual([...marked.querySelectorAll(".agent-markdown-long-token")].map((span) => span.textContent), [url, hash, plain]);
  assert.equal(marked.querySelectorAll("code .agent-markdown-long-token").length, 0);
  assert.deepEqual([...marked.querySelectorAll("code")].map((code) => code.innerHTML), [path, path]);
  // Every cell's text is byte-identical, and each cell keeps its alignment and other attributes.
  assert.deepEqual(cells(marked).map((cell) => cell.textContent), cells(unmarked).map((cell) => cell.textContent));
  assert.equal(marked.querySelector("table").textContent, unmarked.querySelector("table").textContent);
  assert.deepEqual(cells(marked).map(attributes), cells(unmarked).map(attributes));
  assert.ok(cells(marked).some((cell) => /text-align:\s*right/.test(cell.getAttribute("style") ?? "")), "the right-aligned column keeps its alignment");
  // Links keep their original destinations, and a short link renders exactly as before.
  assert.deepEqual([...marked.querySelectorAll("a")].map((a) => a.getAttribute("href")), [url, "https://example.test/notes"]);
  assert.equal(marked.querySelector("a").textContent, url);
  assert.equal(marked.querySelectorAll("a")[1].innerHTML, "short link");
  // The long-token spans are the only difference from the unmarked rendering. Core's link component
  // already passed react-markdown's node prop through as an attribute before this change.
  const withoutMarks = html.replace(/<span class="agent-markdown-long-token">([^<]*)<\/span>/g, "$1");
  assert.equal(withoutMarks.replaceAll(' node="[object Object]"', ""), before.replaceAll(' node="[object Object]"', ""));

  // Copy uses the message's Markdown as plain text and Core's separate clipboard components for HTML.
  const copied = await chat.copiedHtml(source);
  assert.ok(copied.includes(`href="${url.replaceAll("&", "&amp;")}"`));
  assert.ok(!copied.includes("agent-markdown-long-token"));
});

// Review of #259: a long run inside bold or struck text still sets the cell's minimum width, so it is
// marked as well. Inline code stays whole, a link inside bold text is marked once by Core's link
// component, and the text and hrefs stay what they would be without the marks.
test("chat table cells mark long unbroken text inside bold and struck text", async () => {
  const chat = await loadChatProof();
  const bold = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const struck = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
  const url = "https://example.test/a/very/long/path/without/any/spaces/in/it";
  const path = "packages/workbench/app/components/chat/a-very-long-file-name.tsx";
  const source = [
    "| Kind | Value |",
    "| --- | --- |",
    `| bold | **${bold}** |`,
    `| struck | ~~${struck}~~ |`,
    `| nested | ***${bold}*** and ~~**${struck}**~~ |`,
    `| bold link | **[${url}](${url})** |`,
    `| bold code | **\`${path}\`** |`,
  ].join("\n");
  const html = chat.renderChat(source);
  const before = chat.renderUnmarked(source);
  const linkedom = createRequire(join(CORE, "package.json"))("linkedom");
  const parse = (markup) => linkedom.parseHTML(`<!doctype html><html><body>${markup}</body></html>`).document;
  const marked = parse(html);
  const unmarked = parse(before);
  const spans = (selector) => [...marked.querySelectorAll(selector)].map((span) => span.textContent);

  assert.deepEqual(spans(".agent-markdown-long-token"), [bold, struck, bold, struck, url]);
  assert.deepEqual(spans("strong > .agent-markdown-long-token"), [bold, bold, struck]);
  assert.deepEqual(spans("del > .agent-markdown-long-token"), [struck]);
  assert.deepEqual(spans("em > strong > .agent-markdown-long-token"), [bold]);
  assert.deepEqual(spans("strong > a > .agent-markdown-long-token"), [url], "the link inside bold text is marked once");
  assert.equal(marked.querySelectorAll(".agent-markdown-long-token .agent-markdown-long-token").length, 0);
  assert.equal(marked.querySelectorAll("code .agent-markdown-long-token").length, 0);
  assert.deepEqual([...marked.querySelectorAll("code")].map((code) => code.innerHTML), [path]);
  // The text of every cell and the link destination are byte-identical.
  const cells = (doc) => [...doc.querySelectorAll("th, td")].map((cell) => cell.textContent);
  assert.deepEqual(cells(marked), cells(unmarked));
  assert.deepEqual([...marked.querySelectorAll("a")].map((a) => a.getAttribute("href")), [url]);
  const withoutMarks = html.replace(/<span class="agent-markdown-long-token">([^<]*)<\/span>/g, "$1");
  assert.equal(withoutMarks.replaceAll(' node="[object Object]"', ""), before.replaceAll(' node="[object Object]"', ""));
});

// The owner saw a document's footnote definitions run together as one paragraph in the reader.
// What an editable document saved for footnoteMarkdown before read-only footnotes existed,
// measured on the unpatched Toolkit. The editable path already escapes the brackets and joins the
// definitions. That is unchanged here, and this pin proves the read-only feature leaves it alone.
const EDITABLE_FOOTNOTE_MARKDOWN = [
  "TypeScript checks ran at three versions\\[^diagnostics-matrix\\] with the same options\\[^options-matrix\\].",
  "",
  "A second mention of the versions\\[^diagnostics-matrix\\] and a reference with no note\\[^missing\\].",
  "",
  "\\[^diagnostics-matrix\\]: TypeScript diagnostics at 5.9.3, 6.0.3, and 7.0.2. \\[^options-matrix\\]: TypeScript compiler options"
    + " from `tsconfig.json`. An indented line continues the note. \\[^unused\\]: A definition that nothing references.",
].join("\n");
const footnoteMarkdown = [
  "TypeScript checks ran at three versions[^diagnostics-matrix] with the same options[^options-matrix].",
  "",
  "A second mention of the versions[^diagnostics-matrix] and a reference with no note[^missing].",
  "",
  "[^diagnostics-matrix]: TypeScript diagnostics at 5.9.3, 6.0.3, and 7.0.2.",
  "[^options-matrix]: TypeScript compiler options from `tsconfig.json`.",
  "    An indented line continues the note.",
  "[^unused]: A definition that nothing references.",
].join("\n");

test("the reader renders GFM footnotes as superscript links and one notes list at the end", async () => {
  const proof = await loadProof();
  const { json, html } = proof.readMarkdown(footnoteMarkdown, { footnotes: true });
  const types = json.content.map((block) => block.type);
  assert.deepEqual(types, ["paragraph", "paragraph", "footnotes"]);
  const references = json.content.slice(0, 2).flatMap((block) => block.content.filter((node) => node.type === "footnoteReference"));
  assert.deepEqual(references.map((node) => [node.attrs.label, node.attrs.number]),
    [["diagnostics-matrix", 1], ["options-matrix", 2], ["diagnostics-matrix", 1]]);
  // A reference without a definition stays text, as in GFM.
  assert.match(json.content[1].content.at(-1).text, /\[\^missing\]\.$/);
  // Notes follow the order of first reference, and an unreferenced definition is not shown.
  const notes = json.content[2].content;
  assert.deepEqual(notes.map((item) => item.attrs.label), ["diagnostics-matrix", "options-matrix"]);
  assert.equal(notes[0].content[0].content[0].text, "TypeScript diagnostics at 5.9.3, 6.0.3, and 7.0.2.");
  assert.deepEqual(notes[1].content[0].content.map((node) => node.text),
    ["TypeScript compiler options from ", "tsconfig.json", ". An indented line continues the note."]);
  // Each reference is a superscript link to its note. Repeated references share the note's number.
  assert.equal(html.match(/<sup class="an-rich-md-footnote-ref"><a [^>]*href="#fn-1"[^>]*>1<\/a><\/sup>/g)?.length, 2);
  assert.equal(html.match(/<sup class="an-rich-md-footnote-ref"><a [^>]*href="#fn-2"[^>]*>2<\/a><\/sup>/g)?.length, 1);
  assert.match(html, /<section [^>]*class="an-rich-md-footnotes"[^>]*><ol><li id="fn-1"><p>TypeScript diagnostics[^<]*<\/p><\/li><li id="fn-2">/);
  assert.equal(html.match(/ id="/g)?.length, 2, "only the two notes carry ids, so no id repeats");
  assert.ok(!html.includes("[^diagnostics-matrix]") && !html.includes("[^options-matrix]") && !html.includes("[^unused]"));
  // Files and Settings > Documentation are the read-only readers that opt in. Both follow a note link in place.
  for (const route of ["files.tsx", "architecture.tsx"]) {
    const source = readFileSync(new URL(`../app/routes/${route}`, import.meta.url), "utf8");
    assert.match(source, /Features = \{ image: false, tables: true, tasks: true, link: true, footnotes: true \};/, route);
    assert.match(source, /focusFootnote/, route);
  }
});

test("editable documents keep footnote Markdown and their saved bytes unchanged", async () => {
  const proof = await loadProof();
  // The editable factory registers no footnote nodes, so its parse and save path is the one it had before.
  const editable = proof.readMarkdown(footnoteMarkdown, { editable: true });
  assert.ok(!JSON.stringify(editable.json).includes("footnote"));
  assert.equal(editable.markdown, EDITABLE_FOOTNOTE_MARKDOWN);
  // The existing round-trip corpus still saves byte-identically.
  assert.equal(proof.readMarkdown(markdown, { editable: true }).markdown, `${markdown.replace("- [x] shipped\n", "- [x] shipped\n\n")}\n`);
  // A read-only reconcile that reads Markdown gets the footnote syntax back.
  const readOnly = proof.readMarkdown(footnoteMarkdown, { footnotes: true }).markdown;
  assert.match(readOnly, /versions\[\^diagnostics-matrix\] with the same options\[\^options-matrix\]\./);
  assert.match(readOnly, /\n\[\^diagnostics-matrix\]: TypeScript diagnostics at 5\.9\.3, 6\.0\.3, and 7\.0\.2\.\n/);
});

// Review of #259: GFM matches footnote labels like link reference labels, ignoring case.
test("footnote labels match without case, and each side keeps the label it was written with", async () => {
  const proof = await loadProof();
  const { json, markdown } = proof.readMarkdown("See[^Note] here.\n\n[^note]: text", { footnotes: true });
  assert.deepEqual(json.content.map((block) => block.type), ["paragraph", "footnotes"]);
  const reference = json.content[0].content.find((node) => node.type === "footnoteReference");
  assert.deepEqual([reference.attrs.label, reference.attrs.number], ["Note", 1]);
  assert.deepEqual(json.content[1].content.map((item) => [item.attrs.label, item.content[0].content[0].text]), [["note", "text"]]);
  assert.match(markdown, /See\[\^Note\] here\./);
  assert.match(markdown, /\n\[\^note\]: text$/);
});

// Review of #259: a footnote label, like a link label, may hold backslash-escaped brackets and
// backslashes. An escape does not end the label, and labels still match without case.
test("footnote labels keep escaped brackets and backslashes and still match without case", async () => {
  const proof = await loadProof();
  const source = String.raw`Notes[^a\]b] and[^c\[d] and[^E\\F] and[^x\\] here.

[^A\]B]: First.
[^C\[D]: Second.
[^e\\f]: Third.
[^X\\]: Fourth.`;
  const { json, markdown } = proof.readMarkdown(source, { footnotes: true });
  assert.deepEqual(json.content.map((block) => block.type), ["paragraph", "footnotes"]);
  const references = json.content[0].content.filter((node) => node.type === "footnoteReference");
  assert.deepEqual(references.map((node) => [node.attrs.label, node.attrs.number]),
    [[String.raw`a\]b`, 1], [String.raw`c\[d`, 2], [String.raw`E\\F`, 3], [String.raw`x\\`, 4]]);
  assert.deepEqual(json.content[1].content.map((item) => [item.attrs.label, item.content[0].content[0].text]),
    [[String.raw`A\]B`, "First."], [String.raw`C\[D`, "Second."], [String.raw`e\\f`, "Third."], [String.raw`X\\`, "Fourth."]]);
  // Each side saves the label it was written with.
  assert.match(markdown, /^Notes\[\^a\\\]b\] and\[\^c\\\[d\] and\[\^E\\\\F\] and\[\^x\\\\\] here\./);
  for (const definition of [String.raw`[^A\]B]: First.`, String.raw`[^C\[D]: Second.`, String.raw`[^e\\f]: Third.`, String.raw`[^X\\]: Fourth.`]) {
    assert.ok(markdown.includes(`\n${definition}`), definition);
  }
  // An unescaped bracket still ends or rejects a label.
  assert.ok(!JSON.stringify(proof.readMarkdown("Bad[^a[b] here.\n\n[^a[b]: x", { footnotes: true }).json).includes("footnote"));
});

// GitHub's footnote help writes a note over several lines: two trailing spaces, then the next line.
// The continuation stays in the note whether it is indented two spaces, as in that help, or not at all.
test("a footnote continued on the next line keeps the continuation in its note", async () => {
  const proof = await loadProof();
  for (const continuation of ["  This allows you to have a footnote with multiple lines.", "This allows you to have a footnote with multiple lines."]) {
    const source = `Multi[^2] here.\n\n[^2]: Every new line should be prefixed with 2 spaces.  \n${continuation}\n\nAfter.`;
    const { json } = proof.readMarkdown(source, { footnotes: true });
    assert.deepEqual(json.content.map((block) => block.type), ["paragraph", "paragraph", "footnotes"], continuation);
    assert.equal(json.content[1].content[0].text, "After.");
    const note = json.content[2].content[0].content[0].content;
    assert.deepEqual(note.map((node) => node.type), ["text", "hardBreak", "text"], continuation);
    assert.equal(note[2].text.trim(), "This allows you to have a footnote with multiple lines.");
  }
});

// A definition inside another becomes its own note, and the outer note keeps the blocks after it.
test("a nested footnote definition becomes its own note and the outer note keeps its later blocks", async () => {
  const proof = await loadProof();
  const source = ["Outer[^outer] and inner[^inner].", "", "[^outer]: Outer start.", "", "    [^inner]: Inner note.", "",
    "    Outer continues.", "", "Body after."].join("\n");
  const { json } = proof.readMarkdown(source, { footnotes: true });
  assert.deepEqual(json.content.map((block) => block.type), ["paragraph", "paragraph", "footnotes"]);
  assert.equal(json.content[1].content[0].text, "Body after.");
  const notes = json.content[2].content.map((item) => [item.attrs.label, item.content.map((block) => block.content[0].text)]);
  assert.deepEqual(notes, [["outer", ["Outer start.", "Outer continues."]], ["inner", ["Inner note."]]]);
});

// Only a rendered reference's link to a rendered note moves focus. Heading links such as #fn-details or #fn-1
// keep their normal handling, even when a note with that number exists.
test("note links move focus only to a rendered note and leave other #fn- links alone", async () => {
  await loadProof();
  const built = await esbuild.build({ entryPoints: [join(WORKBENCH, "app", "lib", "footnote-links.ts")], bundle: true,
    write: false, format: "esm", platform: "node", logLevel: "silent" });
  const helper = join(folder, "footnote-links.mjs");
  writeFileSync(helper, built.outputFiles[0].text);
  const { focusFootnote } = await import(pathToFileURL(helper).href);
  const reader = document.createElement("div");
  reader.innerHTML = '<p><sup class="an-rich-md-footnote-ref"><a href="#fn-1">1</a></sup> <a href="#fn-details">details</a>'
    + ' <a href="#fn-2">2</a> <a class="heading-link" href="#fn-1">section</a></p><h2 id="fn-details">Fn details</h2>'
    + '<section class="an-rich-md-footnotes"><ol><li id="fn-1"><p>The note.</p></li></ol></section>';
  let focused = null;
  const note = reader.querySelector("li");
  note.focus = () => { focused = note; };
  const click = (href, selector = `a[href="${href}"]`) => {
    const event = { target: reader.querySelector(selector), currentTarget: reader, prevented: false,
      preventDefault() { this.prevented = true; } };
    return [focusFootnote(event), event.prevented];
  };
  assert.deepEqual(click("#fn-details"), [false, false]);
  assert.deepEqual(click("#fn-2"), [false, false], "a note link without a rendered note is not taken over");
  assert.deepEqual(click("#fn-1", "a.heading-link"), [false, false], "an ordinary #fn-1 link is not a note link");
  assert.equal(focused, null);
  assert.deepEqual(click("#fn-1"), [true, true]);
  assert.equal(focused, note);
});

test.after(() => {
  rmSync(folder, { recursive: true, force: true });
  return esbuild.stop();
});
