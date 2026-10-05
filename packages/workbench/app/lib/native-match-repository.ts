import type { AssistantChatProps } from "@agent-native/core/client/agent-chat";
type HistoryRepository = NonNullable<Awaited<ReturnType<NonNullable<AssistantChatProps["loadHistoryRepository"]>>>>;

/** Import only the path containing the match, so branch selection cannot hide its replies. */
export function nativeMatchRepository(threadData: string, referenceId: string): HistoryRepository {
  const repository = { ...JSON.parse(threadData), queuedMessages: [] } as HistoryRepository;
  const byId = new Map(repository.messages.map(entry => [entry.message.id, entry]));
  if (!byId.has(referenceId)) throw new Error("The matching message is no longer available.");
  const pathTo = (head: string | null) => {
    const path: string[] = [], visited = new Set<string>();
    let id = head;
    while (id && byId.has(id) && !visited.has(id)) {
      visited.add(id); path.push(id); id = byId.get(id)?.parentId ?? null;
    }
    return path.reverse();
  };
  let headId = repository.headId, path = pathTo(headId ?? null);
  if (!path.includes(referenceId)) {
    // A branch may have later replies. Select its newest retained descendant, using save order
    // when older repositories have no message timestamps.
    headId = referenceId; path = pathTo(referenceId);
    const parents = new Set(repository.messages.map(entry => entry.parentId));
    const leaves = repository.messages.flatMap((entry, index) => {
      if (parents.has(entry.message.id)) return [];
      const candidate = pathTo(entry.message.id);
      return candidate.includes(referenceId) ? [{ entry, path: candidate, index,
        time: new Date(entry.message.createdAt ?? "").getTime() }] : [];
    });
    const dated = leaves.every(leaf => Number.isFinite(leaf.time));
    const newest = leaves.sort((a, b) => dated ? b.time - a.time || b.index - a.index : b.index - a.index)[0];
    if (newest) { headId = newest.entry.message.id; path = newest.path; }
  }
  return { ...repository, headId, messages: path.map(id => byId.get(id)!) };
}
