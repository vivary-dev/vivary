import type { AssistantChatProps } from "@agent-native/core/client/agent-chat";

// Disabling the composer does not disable Core's retry, edit, or restored-queue paths.
export const createHistoryReadAdapter: NonNullable<AssistantChatProps["createAdapter"]> = () => ({
  async *run() {
    throw new Error("Reading saved history. Return to the latest conversation to continue.");
  },
});
