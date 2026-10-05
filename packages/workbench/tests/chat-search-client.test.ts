import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { continueChatSearch } from "../app/lib/chat-search-client.ts";
import { highlightedExcerpt, chatMatchTime } from "../app/lib/chat-search-excerpt.ts";
import type { ChatSearchPage } from "../app/lib/chat-search-schema.ts";
const page = (cursor: string | null, results: ChatSearchPage["results"] = []): ChatSearchPage => ({ results, continueAfter: cursor,
  scannedSessions: 25, scannedMessages: 50, searchedSessions: 25, readBytes: 0, limited: false,
  limits: { sessions: 25, messages: 500, bytes: 16 * 1024 * 1024, results: 25 } });

test("automatic search traverses empty pages and stops on completion without manual clicks", async () => {
  const requests: (string | undefined)[] = [], results: ChatSearchPage[] = [];
  await continueChatSearch({ signal: new AbortController().signal, onRequest: cursor => requests.push(cursor), onPage: p => results.push(p),
    fetchPage: async after => page(after === undefined ? "next" : after === "next" ? "last" : null) });
  assert.deepEqual(requests, [undefined, "next", "last"]); assert.equal(results.length, 3);
});
test("retry uses the failed cursor and keeps earlier pages", async () => {
  let after: string | undefined, successful = 0;
  const delivered: ChatSearchPage[] = [];
  const callbacks = { signal: new AbortController().signal, onRequest: (cursor?: string) => { after = cursor; },
    onPage: (p: ChatSearchPage) => { delivered.push(p); } };
  await assert.rejects(continueChatSearch({ ...callbacks, fetchPage: async () => {
    if (successful++) throw new Error("temporary"); return page("failed-page");
  } }), /temporary/);
  assert.equal(after, "failed-page"); assert.equal(delivered.length, 1);
  await continueChatSearch({ ...callbacks, after, fetchPage: async cursor => { assert.equal(cursor, "failed-page"); return page(null); } });
  assert.equal(delivered.length, 2);
});
test("automatic work stops at time/page budgets and cancellation discards a late page", async () => {
  let calls = 0;
  await continueChatSearch({ signal: new AbortController().signal, onRequest: () => {}, onPage: () => {},
    fetchPage: async () => { calls++; return page("next"); }, maxPages: 2 });
  assert.equal(calls, 2);
  calls = 0;
  await continueChatSearch({ signal: new AbortController().signal, onRequest: () => {}, onPage: () => {},
    fetchPage: async () => { calls++; return page("next"); }, now: () => calls * 3000 });
  assert.equal(calls, 1);
  const abort = new AbortController();
  await assert.rejects(continueChatSearch({ signal: abort.signal, onRequest: () => {}, onPage: () => assert.fail("Stale page rendered"),
    fetchPage: async () => { abort.abort(); return page(null); } }), { name: "AbortError" });
});
test("excerpt terms produce literal safe marks and human dates", () => {
  const html = renderToStaticMarkup(createElement("span", null, highlightedExcerpt("<script>NeEdLe & needle</script>", "needle")));
  assert.equal(html, "<span>&lt;script&gt;<mark>NeEdLe</mark> &amp; <mark>needle</mark>&lt;/script&gt;</span>");
  assert.equal(renderToStaticMarkup(createElement("span", null, highlightedExcerpt("one [two] three", "[two]"))),
    "<span>one <mark>[two]</mark> three</span>");
  assert.equal(chatMatchTime("2026-01-01T00:00:00Z", undefined, Date.parse("2026-01-02T00:00:00Z")).label, "yesterday");
  assert.equal(chatMatchTime().label, "Saved conversation");
});

for (const [name, text, query, expected] of [
  ["expanding lowercase prefix", "İİ needle", "needle", "İİ <mark>needle</mark>"],
  ["expanding prefix and astral emoji", "İİİ 🧪 needle after", "needle", "İİİ 🧪 <mark>needle</mark> after"],
  ["ASCII repeated matches", "Needle then needle.", "needle", "<mark>Needle</mark> then <mark>needle</mark>."],
  ["astral repeated matches", "İİİ 🧪🧪", "🧪", "İİİ <mark>🧪</mark><mark>🧪</mark>"],
  ["partial surrogate is not highlighted", "🧪", "\ud83e", "🧪"],
  ["context-dependent final sigma stays unmarked", "ΟΣ", "ς", "ΟΣ"],
  ["context-dependent lowering outside the match", "ΟΣ İİ needle", "needle", "ΟΣ İİ <mark>needle</mark>"],
]) test(`Unicode highlighting preserves original characters (${name})`, () => {
  const html = renderToStaticMarkup(createElement("span", null, highlightedExcerpt(text, query)));
  assert.equal(html, `<span>${expected}</span>`);
  assert.equal(html.isWellFormed(), true, "marks must not split surrogate pairs");
});
