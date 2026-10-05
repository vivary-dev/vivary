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
  return { ...repository, messages: [...repository.messages, { message, parentId: repository.headId ?? null }], headId: message.id };
}
export function codeMatchMessageId(repository: Repository, referenceId: string): string | null {
  return repository.messages.find(entry => {
    const ids = entry.message.metadata?.custom?.codeAgentTranscriptEventIds;
    return Array.isArray(ids) && ids.includes(referenceId);
  })?.message.id ?? null;
}
