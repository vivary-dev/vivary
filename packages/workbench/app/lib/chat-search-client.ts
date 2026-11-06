import type { ChatSearchPage } from "./chat-search-schema";

/** Continue bounded server pages until a useful page of hits, completion, or the automatic budget. */
export async function continueChatSearch({ after, signal, fetchPage, onPage, onRequest,
  now = Date.now, maxPages = 12, maxMilliseconds = 3000 }: {
  after?: string; signal: AbortSignal; fetchPage: (after?: string) => Promise<ChatSearchPage>;
  onPage: (page: ChatSearchPage) => void; onRequest: (after?: string) => void;
  now?: () => number; maxPages?: number; maxMilliseconds?: number;
}) {
  const started = now();
  let hits = 0;
  for (let i = 0; i < maxPages; i++) {
    signal.throwIfAborted(); onRequest(after);
    const page = await fetchPage(after);
    signal.throwIfAborted(); onPage(page);
    hits += page.results.length;
    after = page.continueAfter ?? undefined;
    if (!after || hits >= page.limits.results || now() - started >= maxMilliseconds) break;
  }
}
