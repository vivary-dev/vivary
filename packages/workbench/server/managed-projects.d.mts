import type { WorkspacePatternChoice, WorkspacePreset } from "../shared/workspace-patterns";
import type { ActionRunContext } from "@agent-native/core/action";

export type ManagedProjectFile = {
  path: string;
  content: string;
  bytes: number;
  sha256: string;
};

export type ManagedProjectPreview = {
  code: "preview";
  plan: {
    schema: "vivary.thin-init-plan/v1";
    target: string;
    preset: string;
    adapters: string[];
    active_context: string | null;
    files: ManagedProjectFile[];
    content_sha256: string;
    plan_sha256: string;
  };
};

export function previewManagedProject(
  context: ActionRunContext | undefined,
  input: { name: string; patternChoices?: WorkspacePatternChoice[];
    preset?: WorkspacePreset },
  dependencies?: Record<string, unknown>,
): Promise<ManagedProjectPreview>;

export function createManagedProject(
  context: ActionRunContext | undefined,
  input: { name: string; displayName?: string; acceptedPlanSha256: string;
    patternChoices?: WorkspacePatternChoice[]; preset?: WorkspacePreset },
  dependencies?: Record<string, unknown>,
): Promise<
  | { code: "plan-changed" }
  | {
      code: "created" | "already-created";
      target: string;
      planSha256: string;
      registration: Record<string, unknown>;
    }
>;

export function isWindowsReservedName(name: string): boolean;

export function readWorkspaceContext(
  workspace: { projectId: string; root: string },
  candidates?: readonly string[],
  dependencies?: Record<string, unknown>,
): Promise<import("../app/lib/project-memory-schema").WorkspaceContextPaths>;

export function observeProjectVersion(
  workspace: { projectId: string; root: string },
  dependencies?: Record<string, unknown>,
): Promise<{ kind: "plain" } | { kind: "unknown" }
  | { kind: "git"; head: string | null; ref: string | null; entries: Array<{ path: string; state: string }> | null }>;

export function installedPatternCatalog(
  context: ActionRunContext | undefined,
  dependencies?: Record<string, unknown>,
): Promise<import("../shared/workspace-patterns").WorkspacePatternCatalog>;
