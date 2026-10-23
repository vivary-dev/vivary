import { buildRepositoryFromCodeAgentTranscript, type AssistantChatProps } from "@agent-native/core/client/agent-chat";
import type { CodeAgentTranscriptEvent } from "@agent-native/core/code-agents";
type Repository = NonNullable<Awaited<ReturnType<NonNullable<AssistantChatProps["loadHistoryRepository"]>>>>;
type Message = Repository["messages"][number]["message"];

/** The note `applyVivaryCodeRuntimeSwitch` appends. Matches `VIVARY_CODE_SWITCH_SOURCE` on the server. */
const RUNTIME_SWITCH_SOURCE = "vivary-runtime-switch";
/** The note `recordProjectContextLoad` appends once per turn, such as "Loaded project context ...". */
const PROJECT_CONTEXT_SOURCE = "vivary-project-context";

/**
 * The Code transcript as chat rows. Core would fold a runtime switch note or a project context note into the reply
 * before it, so each becomes its own row instead: a switch as a divider, a context note as a short status row that
 * local-agent.css mutes by its `code-context-` ID. Some lifecycle events have no normal transcript row. Expose the
 * exact saved event only in the read-only match view.
 */
export function codeMatchRepository(events: CodeAgentTranscriptEvent[], referenceId?: string | null): Repository {
  let repository = buildRepositoryFromCodeAgentTranscript(events.filter(event => !ownRow(event))) as Repository;
  for (const event of events) {
    if (isRuntimeSwitch(event)) {
      repository = insertEventRow(repository, events, event, "code-switch-" + event.id,
        // A Markdown rule and one short line. Core renders assistant text as Markdown and has no divider row of its own.
        `---\n\n*${escapeMarkdown(event.message)}*`);
    } else if (event.kind === "note" && event.metadata?.source === PROJECT_CONTEXT_SOURCE) {
      repository = insertEventRow(repository, events, event, "code-context-" + event.id, escapeMarkdown(event.message));
    }
  }
  if (!referenceId || codeMatchMessageId(repository, referenceId)) return repository;
  const event = events.find(event => event.id === referenceId);
  if (!event) return repository;
  return insertEventRow(repository, events, event, "code-search-" + event.id, `Saved Code event (${event.kind})\n\n${event.message}`);
}

function isRuntimeSwitch(event: CodeAgentTranscriptEvent): boolean {
  return event.kind === "note" && event.metadata?.source === RUNTIME_SWITCH_SOURCE;
}

/** A note shown as its own row rather than folded into a reply. */
function ownRow(event: CodeAgentTranscriptEvent): boolean {
  return event.kind === "note" && (event.metadata?.source === RUNTIME_SWITCH_SOURCE || event.metadata?.source === PROJECT_CONTEXT_SOURCE);
}

function escapeMarkdown(text: string): string {
  return text.replace(/[*_`\\]/g, "\\$&");
}

/** Adds one row for an event Core gave no row, in saved event order, keeping the canonical rows and their content. */
function insertEventRow(repository: Repository, events: CodeAgentTranscriptEvent[], event: CodeAgentTranscriptEvent,
  id: string, text: string): Repository {
  const message: Message = { id, role: "assistant" as const, createdAt: new Date(event.createdAt),
    content: [{ type: "text" as const, text }],
    status: { type: "complete" as const, reason: "stop" as const },
    metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [],
      custom: { codeAgentTranscriptEventIds: [event.id] } } } as Message;
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
