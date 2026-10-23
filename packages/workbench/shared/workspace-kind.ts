import { z } from "zod";
import type { WorkspacePreset } from "./workspace-patterns.ts";

/**
 * The owner's choice for a project: Coding or Personal. It sets defaults only.
 * Both conversation kinds stay available in every project. A project without a
 * choice is null and shows "Not set". Nothing changes it silently.
 */
export const workspaceKind = z.enum(["coding", "personal"]);
export type WorkspaceKind = z.infer<typeof workspaceKind>;

/** The guidance preset a new project starts with for each kind. The owner can still change it. */
export const WORKSPACE_KIND_PRESET: Readonly<Record<WorkspaceKind, WorkspacePreset>> = Object.freeze({
  coding: "coding",
  personal: "knowledge-work",
});

export function workspaceKindLabel(kind: WorkspaceKind | null): string {
  return kind === "coding" ? "Coding" : kind === "personal" ? "Personal" : "Not set";
}
