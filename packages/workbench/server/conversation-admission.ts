import { createHash } from "node:crypto";
import { withThreadDataLock } from "@agent-native/core/server";

export function createCodeDraftIdentity(ownerEmail: string, orgId: string, projectId: string | null) {
  const key = createHash("sha256").update(JSON.stringify([ownerEmail.toLowerCase(), orgId, projectId])).digest("hex");
  return { storageKey: "vivary-code-draft-v1:" + key };
}

/** A scope lock covers retained run IDs and their older draft aliases in this single server process. */
export function withCodeConversationAdmission<T>(ownerEmail: string, orgId: string | undefined,
  projectId: string | null, admit: () => Promise<T>): Promise<T> {
  const identity = createCodeDraftIdentity(ownerEmail, orgId ?? "", projectId);
  return withThreadDataLock("vivary-code-admission:" + identity.storageKey, admit);
}
