// Only these owner actions accept the private proxy session transport on a POST.
// Same-origin reads may carry it on every route.
export const VIVARY_OWNER_ACTIONS = [
  "vivary-chat-draft", "vivary-native-archive",
  "vivary-conversation-link", "vivary-linked-history",
  "vivary-code-send", "vivary-code-stop", "vivary-code-approve", "vivary-code-deny",
  "vivary-code-cleanup",
  "vivary-register-project", "vivary-connect-project-folder",
  "vivary-project-file-save", "vivary-project-file-rename",
  "vivary-preview-new-project", "vivary-create-new-project", "vivary-workspace-pattern-catalog",
  "vivary-preview-managed-project-reconnection", "vivary-confirm-managed-project-reconnection",
  "vivary-original-command", "vivary-project-adoption", "vivary-project-preview",
  "vivary-remote-preview", "vivary-project-read-owner",
  "vivary-project-evaluate-owner",
  "vivary-project-memory", "vivary-project-memory-write",
  "vivary-automation-files",
] as const;
export type VivaryOwnerAction = typeof VIVARY_OWNER_ACTIONS[number];
