import { fail, type ActionRunContext } from "@agent-native/core/action";
import {
  resolveLocalProjectHistory,
  resolveLocalProjectWorkspace,
  type LocalProjectWorkspace,
} from "./project-services.mjs";
import type { VivaryCodeProjectHistory } from "./local-code-agent";

function preserveAccessDenial(error: unknown): void {
  if (error && typeof error === "object" && "statusCode" in error
      && (error.statusCode === 401 || error.statusCode === 403)) {
    throw error;
  }
}

/** Resolve browser project IDs through the current Native grant before file or run access. */
export async function resolveVivaryCodeProject(
  context: ActionRunContext | undefined,
  projectId: string | undefined,
): Promise<LocalProjectWorkspace | undefined> {
  if (!projectId) return undefined;
  try {
    return await resolveLocalProjectWorkspace(context, projectId);
  } catch (error) {
    preserveAccessDenial(error);
    fail("This project folder is unavailable. Reconnect it from Projects.", {
      errorCode: "vivary_code_project_unavailable",
      statusCode: 409,
    });
  }
}

/** Resolve authorized project identity for history without touching its folder. */
export async function resolveVivaryCodeProjectHistory(
  context: ActionRunContext | undefined,
  projectId: string | undefined,
): Promise<VivaryCodeProjectHistory | undefined> {
  if (!projectId) return undefined;
  try {
    return await resolveLocalProjectHistory(context, projectId);
  } catch (error) {
    preserveAccessDenial(error);
    fail("This project's conversation history is unavailable.", {
      errorCode: "vivary_code_project_history_unavailable",
      statusCode: 409,
    });
  }
}


/** Discover runtime configuration from a connected folder without changing history access. */
export async function resolveVivaryCodeProjectDiscoveryRoot(
  context: ActionRunContext | undefined,
  projectId: string | undefined,
): Promise<string | undefined> {
  if (!projectId) return undefined;
  try {
    return (await resolveLocalProjectWorkspace(context, projectId)).root;
  } catch (error) {
    preserveAccessDenial(error);
    return undefined;
  }
}
