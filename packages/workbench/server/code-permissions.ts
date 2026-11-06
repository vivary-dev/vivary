import { readAppState, writeAppState } from "@agent-native/core/application-state";
import { runWithRequestContext } from "@agent-native/core/server";

export const CODE_PERMISSION_MODES = ["normal", "read-only", "yolo"] as const;
export type CodePermissionMode = typeof CODE_PERMISSION_MODES[number];
export function isCodePermissionMode(value: unknown): value is CodePermissionMode {
  return CODE_PERMISSION_MODES.some(mode => mode === value);
}
export async function getCodePermissionMode(ownerEmail: string, orgId?: string): Promise<CodePermissionMode> {
  return runWithRequestContext({ userEmail: ownerEmail, orgId }, async () => {
    const state = await readAppState("vivary:codex-permissions");
    return isCodePermissionMode(state?.mode) ? state.mode : "normal";
  });
}
export async function setCodePermissionMode(ownerEmail: string, mode: CodePermissionMode, orgId?: string): Promise<void> {
  return runWithRequestContext({ userEmail: ownerEmail, orgId }, () => writeAppState("vivary:codex-permissions", { mode }));
}
