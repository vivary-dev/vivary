import { buildRepositoryFromCodeAgentTranscript, type AssistantChatProps } from "@agent-native/core/client/agent-chat";
import type { CodeAgentTranscriptEvent } from "@agent-native/core/code-agents";
type Repository = NonNullable<Awaited<ReturnType<NonNullable<AssistantChatProps["loadHistoryRepository"]>>>>;

/** Some lifecycle events have no normal transcript row. Expose the exact saved event only in the read-only match view. */
export function codeMatchRepository(events: CodeAgentTranscriptEvent[], referenceId?: string | null): Repository {
  const repository = buildRepositoryFromCodeAgentTranscript(events) as Repository;
  if (!referenceId || codeMatchMessageId(repository, referenceId)) return repository;
  const event = events.find(event => event.id === referenceId);
  if (!event) return repository;
  const message = { id: "code-search-" + event.id, role: "assistant" as const, createdAt: new Date(event.createdAt),
    content: [{ type: "text" as const, text: `Saved Code event (${event.kind})\n\n${event.message}` }],
    status: { type: "complete" as const, reason: "stop" as const },
    metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [],
      custom: { codeAgentTranscriptEventIds: [event.id] } } };
  // Core's rows can combine several visible events. Locate the first later row
  // from saved event order, keeping the canonical rows and their content intact.
  const matchIndex = events.indexOf(event);
  const predecessor = events.slice(0, matchIndex).reverse()
    .map(event => codeMatchMessageId(repository, event.id)).find(id => id !== null);
  const successor = events.slice(matchIndex + 1)
    .map(event => codeMatchMessageId(repository, event.id)).find(id => id !== null && id !== predecessor);
  const insertionIndex = successor ? repository.messages.findIndex(entry => entry.message.id === successor) : repository.messages.length;
  const messages = [...repository.messages];
  messages.splice(insertionIndex, 0, { message, parentId: messages[insertionIndex - 1]?.message.id ?? null });
  if (successor) messages[insertionIndex + 1] = { ...messages[insertionIndex + 1], parentId: message.id };
  return { ...repository, messages, headId: successor ? repository.headId : message.id };
}
export function codeMatchMessageId(repository: Repository, referenceId: string): string | null {
  return repository.messages.find(entry => {
    const ids = entry.message.metadata?.custom?.codeAgentTranscriptEventIds;
    return Array.isArray(ids) && ids.includes(referenceId);
  })?.message.id ?? null;
}
