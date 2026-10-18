import { fail, type ActionRunContext } from "@agent-native/core/action";
import type { AgentChatPluginOptions } from "@agent-native/core/server";
import { getRequestOrgId } from "@agent-native/core/server";
import { createError, HTTPError } from "h3";
import { refreshHeldCredentials } from "./credential-redaction.ts";
import { prepareLinkedNativeMessage } from "./linked-conversations";
import { projectIdentity, sameProject } from "./project-files.ts";
import {
  projectMemory,
  renderUnavailableContext,
  unavailableProjectContext,
  type ProjectContextBlock,
} from "./project-memory.ts";
import {
  matchChatProject,
  resolveLocalProjectWorkspace,
  type ChatScopeMatch,
} from "./project-services.mjs";

type PrepareRequestDetails = Parameters<
  NonNullable<AgentChatPluginOptions["prepareRequest"]>
>[0];

type NativeChatProjectDependencies = {
  getOrgId: () => string | undefined;
  /** Classifies the chat scope of the current request. See project services. */
  matchChatProject: (context: ActionRunContext) => Promise<ChatScopeMatch>;
  resolveProjectWorkspace: (
    context: ActionRunContext,
    projectId: string,
  ) => Promise<unknown>;
};

const defaultDependencies: NativeChatProjectDependencies = {
  getOrgId: getRequestOrgId,
  matchChatProject,
  resolveProjectWorkspace: resolveLocalProjectWorkspace,
};

// Project services refuse with a 401, 403, or 503 and a fixed sentence.
function accessRefusal(error: unknown): { statusCode: 401 | 403 | 503; message: string } | null {
  if (!(error instanceof Error) || !("statusCode" in error)) return null;
  const { statusCode } = error;
  return statusCode === 401 || statusCode === 403 || statusCode === 503 ? { statusCode, message: error.message } : null;
}

// The send guard is the HTTP boundary: an error must leave it as an h3 error,
// or h3 answers 500. Issue #91. Core's chat client reads a 401 or 403 on a
// send as a lost session and asks the owner to sign in, and a 409 as a run
// still finishing. A lost session keeps its 401, so that sign-in recovery
// runs, and a folder that is not ready yet keeps its 503. Any other refusal,
// and anything else, leaves as a 422 whose body the client shows as a final
// error in the refusal's own sentence.
function conversationError(error: unknown, fallback: string): Error {
  const refusal = accessRefusal(error);
  if (refusal?.statusCode === 401 || refusal?.statusCode === 503) {
    return createError({ statusCode: refusal.statusCode, statusMessage: refusal.message, cause: error });
  }
  const message = refusal?.message ?? fallback;
  return new HTTPError({ status: 422, message, cause: error,
    body: { error: message, errorCode: "vivary_project_conversation_refused", retryable: false } });
}

// Project services classify the scope Native pinned to this request. Native
// consumed the request body before either caller runs. The context keeps the
// caller that asked: the send guard runs inside an HTTP request, and a tool
// call stays a tool call.
async function matchChatScope(
  dependencies: Pick<NativeChatProjectDependencies, "matchChatProject">,
  identity: { owner: string | null | undefined; orgId: string | null | undefined; caller: "http" | "tool";
    signal?: AbortSignal },
): Promise<ChatScopeMatch> {
  const context: ActionRunContext = {
    caller: identity.caller,
    userEmail: identity.owner?.trim().toLowerCase(),
    orgId: identity.orgId,
    appId: "workbench",
    ...(identity.signal ? { signal: identity.signal } : {}),
  };
  return dependencies.matchChatProject(context);
}

/**
 * Revalidate v2 project-scoped Native sends before any model or attachment work.
 * Other scopes retain Agent-Native's existing behavior, including legacy v1 chats.
 */
export function createVivaryNativeChatProjectGuard(
  dependencies: NativeChatProjectDependencies = defaultDependencies,
): (details: PrepareRequestDetails) => Promise<void> {
  return async details => {
    let match: ChatScopeMatch;
    try {
      match = await matchChatScope(dependencies,
        { owner: details.ownerEmail, orgId: dependencies.getOrgId(), caller: "http" });
    } catch (error) {
      throw conversationError(error, "Project conversation access is unavailable.");
    }
    if (match.kind !== "project") return;
    try {
      await dependencies.resolveProjectWorkspace(match.context, match.projectId);
    } catch (error) {
      throw conversationError(error, "This project folder is unavailable. Reconnect it from Projects.");
    }
  };
}

export const prepareVivaryNativeChatProject =
  createVivaryNativeChatProjectGuard();

/**
 * Native `prepareRequest`. The held credentials reload first, so a key saved
 * since the last send is redacted in this reply. Then the project guard runs.
 */
export async function prepareVivaryNativeChatSend(details: PrepareRequestDetails) {
  await refreshHeldCredentials();
  await prepareVivaryNativeChatProject(details);
  try { return await prepareLinkedNativeMessage(details); }
  catch (error) { throw conversationError(error, "The linked source history is unavailable. Open the original conversation."); }
}

/**
 * The project a Native tool call acts on comes only from its chat's pinned
 * scope, never from tool input. The returned context is the one project
 * services admitted for that project. It stays a tool call.
 */
export function createVivaryNativeChatProjectResolver(
  dependencies: NativeChatProjectDependencies = defaultDependencies,
): (context: ActionRunContext | undefined) => Promise<{ projectId: string; projectContext: ActionRunContext }> {
  return async context => {
    let match: ChatScopeMatch = { kind: "not-project" };
    try {
      if (context?.caller === "tool") {
        match = await matchChatScope(dependencies,
          { owner: context.userEmail, orgId: context.orgId, caller: "tool", signal: context.signal });
      }
    } catch (error) {
      // A tool call reports a refusal the way its other refusals do.
      const refusal = accessRefusal(error);
      fail(refusal?.message ?? "Project conversation access is unavailable.", {
        errorCode: "vivary_project_read_access",
        statusCode: refusal?.statusCode ?? 409,
      });
    }
    if (match.kind !== "project") {
      fail("Open this chat from a project to use project tools.", {
        errorCode: "vivary_project_read_scope",
        statusCode: 409,
      });
    }
    return { projectId: match.projectId, projectContext: match.context };
  };
}

export const resolveNativeChatProject = createVivaryNativeChatProjectResolver();

type NativeChatContextDependencies = Pick<NativeChatProjectDependencies, "getOrgId" | "matchChatProject"> & {
  /** Resolve the admitted project and load its context block for this message. */
  loadProjectContext: (context: ActionRunContext, projectId: string) => Promise<ProjectContextBlock>;
};

const defaultContextDependencies: NativeChatContextDependencies = {
  getOrgId: getRequestOrgId,
  matchChatProject,
  loadProjectContext: (context, projectId) => loadNativeProjectContext(context, projectId),
};

type ProjectContextLoader = {
  resolve: typeof resolveLocalProjectWorkspace;
  memory: Pick<typeof projectMemory, "renderForRun" | "recordLoad">;
};

/**
 * Load the Full chat block for an admitted project. The binding is resolved
 * again after the load, and a changed binding gets the unavailable block
 * instead, so a block from the old folder never reaches the model.
 */
export async function loadNativeProjectContext(context: ActionRunContext, projectId: string,
  loader: ProjectContextLoader = { resolve: resolveLocalProjectWorkspace, memory: projectMemory }):
  Promise<ProjectContextBlock> {
  const workspace = await loader.resolve(context, projectId);
  const load = await loader.memory.renderForRun(workspace, "full-chat");
  const again = await loader.resolve(context, projectId);
  if (!sameProject(projectIdentity(workspace), projectIdentity(again))) {
    return renderUnavailableContext(again.label, "The project changed while its context was loaded.", "full-chat");
  }
  // extraContext runs only for a send the guard admitted, so this message is being sent.
  loader.memory.recordLoad(workspace, load, "full-chat");
  return load.block;
}

/**
 * Native actions that reach owner-wide data: memory and resources, chat
 * history, and the SQL database tools, which can read other threads. None
 * of these stores has a project column, so a project chat has no grant for
 * them. Tests pin the names against Native's registry and against the
 * database entries Native builds, so a rename or a new database tool fails
 * instead of silently exposing owner-wide data again.
 */
export const OWNER_WIDE_ACTIONS = [
  "resources", "save-memory", "delete-memory", "chat-history",
  "db-schema", "db-query", "db-exec", "db-patch",
] as const;

/**
 * Native `extraContext`, run on every send after the guard. A project chat
 * gets its pinned project's context block. Other chats get nothing extra.
 * Native drops a thrown error silently, so a refusal that arrives after the
 * guard becomes a block that tells the model context is unavailable.
 */
export function createVivaryNativeChatContext(
  dependencies: NativeChatContextDependencies = defaultContextDependencies,
): NonNullable<AgentChatPluginOptions["extraContext"]> {
  return async (_event, owner) => {
    try {
      const match = await matchChatScope(dependencies,
        { owner, orgId: dependencies.getOrgId(), caller: "http" });
      if (match.kind !== "project") return null;
      return await dependencies.loadProjectContext(match.context, match.projectId);
    } catch (error) {
      return unavailableProjectContext(null, error, "full-chat");
    }
  };
}

/**
 * Native `resolveActionSurface`. A project chat loses the owner-wide actions,
 * and Native drops the framework prompt lines that name them. Native's
 * resources context note remains, and the project block says the tools are
 * unavailable. Any other chat keeps Native's default surface. A
 * classification error fails closed.
 */
export function createVivaryNativeChatActionSurface(
  dependencies: Pick<NativeChatProjectDependencies, "getOrgId" | "matchChatProject"> = defaultDependencies,
): NonNullable<AgentChatPluginOptions["resolveActionSurface"]> {
  return async details => {
    const withoutOwnerMemory = {
      allowedActionNames: details.availableActionNames.filter(name =>
        !OWNER_WIDE_ACTIONS.some(denied => denied === name)),
    };
    try {
      const match = await matchChatScope(dependencies,
        { owner: details.ownerEmail, orgId: details.orgId ?? dependencies.getOrgId(), caller: "http" });
      return match.kind === "project" ? withoutOwnerMemory : { mode: "default" };
    } catch {
      return withoutOwnerMemory;
    }
  };
}

/** The Native chat options Vivary sets. The Nitro plugin spreads them into createAgentChatPlugin. */
export const vivaryNativeChatProjectOptions = {
  prepareRequest: prepareVivaryNativeChatSend,
  extraContext: createVivaryNativeChatContext(),
  resolveActionSurface: createVivaryNativeChatActionSurface(),
} satisfies Partial<AgentChatPluginOptions>;
