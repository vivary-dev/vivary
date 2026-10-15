import {
  createCodeAgentChatAdapter,
  type AssistantChatAdapterContext,
  type CodeAgentChatController,
} from "@agent-native/core/client/agent-chat";
import { actionErrorMessage, callAction } from "@agent-native/core/client/hooks";
import type { NativeActionCaller } from "./native-actions";
import type {
  VivaryCodeState,
} from "../../server/local-code-agent";

const PRE_APPEND_CODE_REJECTIONS = new Set([
  "vivary_code_engine_changed", "vivary_code_runtime_unavailable", "vivary_code_models_unavailable",
  "vivary_code_model_changed", "vivary_code_model_unsupported", "vivary_code_project_changed",
  "vivary_code_project_reconnecting", "vivary_code_host_closing", "vivary_code_run_active",
  "vivary_code_workspace_unavailable", "vivary_code_run_not_found", "vivary_code_historical_engine",
  "vivary_code_cleanup_required",
]);

function isPreAppendCodeRejection(error: unknown): boolean {
  return error !== null && typeof error === "object" && "errorCode" in error
    && typeof error.errorCode === "string" && PRE_APPEND_CODE_REJECTIONS.has(error.errorCode);
}

type LocalCodeChatOptions = {
  context: AssistantChatAdapterContext;
  call: NativeActionCaller;
  projectId: string | null;
  draftThreadId: string;
  runIdRef: { current: string | null };
  engines: () => VivaryCodeState["engines"];
  onStarted: (runId: string) => void;
  onStreaming: (streaming: boolean) => void;
  onSettled: () => void;
  onKnownRejected: (submitId: string) => Promise<void>;
};

export function createLocalCodeChatAdapter(
  options: LocalCodeChatOptions,
): ReturnType<typeof createCodeAgentChatAdapter> {
  const projectId = options.projectId ?? undefined;
  const scopedState = (state: VivaryCodeState) => {
    if (state.projectId !== options.projectId) throw new Error("The project changed. Reopen its conversation before sending another message.");
    return state;
  };
  return {
    async *run(input) {
      const userMessage = input.messages.findLast(message => message.role === "user");
      const marker = input.runConfig?.custom?.agentNativeQueuedMessageId;
      const draftSubmitId = typeof marker === "string" ? marker : undefined;
      const rejectLocal = async (reason: string) => {
        if (draftSubmitId) await options.onKnownRejected(draftSubmitId);
        return new Error(reason);
      };
      const message = userMessage?.content
        .filter(part => part.type === "text")
        .map(part => part.text)
        .join("\n")
        .trim();
      if (!message) throw await rejectLocal("Enter a message for the agent.");
      if (message.length > 8_000) throw await rejectLocal("Keep the message under 8,000 characters.");
      if (userMessage?.attachments?.length || userMessage?.content.some(part => part.type !== "text")) {
        throw await rejectLocal("Attachments are not connected to this runtime yet. Ask the agent to read a file already in the workspace.");
      }
      const engine = options.engines().find(item => item.engine === options.context.engineRef.current);
      const model = options.context.modelRef.current;
      if (!engine || !model || !engine.models.includes(model)) {
        throw await rejectLocal("Choose an available runtime and model.");
      }
      if (input.abortSignal.aborted) {
        if (draftSubmitId) await options.onKnownRejected(draftSubmitId);
        return;
      }

      const send = async (params: Record<string, unknown>) => {
        try {
          return await options.call<VivaryCodeState>("vivary-code-send", params);
        } catch (error) {
          if (draftSubmitId && isPreAppendCodeRejection(error)) await options.onKnownRejected(draftSubmitId);
          throw error;
        }
      };
      options.onStreaming(true);
      try {
        const starting = options.runIdRef.current === null;
        if (starting) {
          const state = scopedState(await send({ projectId, message, model, engine: engine.engine,
            draftSubmitId, draftThreadId: draftSubmitId ? options.draftThreadId : undefined }));
          if (state.error) throw new Error(state.error);
          if (!state.run) throw new Error("The agent did not return a conversation.");
          options.runIdRef.current = state.run.id;
          options.onStarted(state.run.id);
        }

        let readInFlight: Promise<VivaryCodeState> | null = null;
        const read = (runId: string) => {
          readInFlight ??= callAction<VivaryCodeState>("vivary-code-state", { projectId, runId }, { method: "GET" })
            .then(scopedState)
            .finally(() => { readInFlight = null; });
          return readInFlight;
        };
        let firstTranscript = starting;
        const controller: CodeAgentChatController = {
          get: async runId => (await read(runId)).run,
          transcript: async runId => {
            // A new run may already have output before the create action returns.
            if (firstTranscript) {
              firstTranscript = false;
              return [];
            }
            return (await read(runId)).run?.events ?? [];
          },
          sendFollowUp: async ({ runId, prompt, mode }) => {
            if (mode === "queued") return { ok: false, error: "Wait for the current response or stop it before sending another message." };
            const state = scopedState(await send({ projectId, runId, message: prompt, model, engine: engine.engine,
              draftSubmitId, draftThreadId: draftSubmitId ? options.draftThreadId : undefined }));
            return { ok: !state.error && !!state.run, run: state.run, error: state.error };
          },
          control: async ({ runId, command }) => {
            if (command !== "stop") return { ok: false, error: "This runtime does not support approval requests." };
            const state = scopedState(await options.call<VivaryCodeState>("vivary-code-stop", { projectId, runId }));
            return { ok: !state.error, run: state.run, error: state.error };
          },
        };
        const adapter = createCodeAgentChatAdapter({
          controller,
          runIdRef: options.runIdRef,
          modelRef: options.context.modelRef,
          engineRef: options.context.engineRef,
          attachOnlyRef: { current: starting },
          followUpModeRef: { current: "immediate" },
          stopOnAbort: false,
          pollIntervalMs: 750,
          idlePollIntervalMs: 350,
          terminalIdlePolls: 2,
        });
        const updates = adapter.run(input);
        if (Symbol.asyncIterator in updates) yield* updates;
        else yield await updates;
      } catch (error) {
        throw new Error(actionErrorMessage(error) ?? (error instanceof Error ? error.message : "The agent could not complete this request."));
      } finally {
        options.onStreaming(false);
        options.onSettled();
      }
    },
  };
}
