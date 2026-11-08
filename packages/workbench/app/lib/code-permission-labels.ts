import type { VivaryCodeEngine } from "../../server/local-runtime-setup";

// Vivary's execution mode reaches Codex launches only. Every Claude Code run is recorded as `auto-edit`,
// which Core's executor starts in Claude Code's `acceptEdits` mode, so Claude Code edits files without
// asking whichever mode is selected. The composer and Settings say so rather than imply the mode applies.
export const CLAUDE_CODE_PERMISSION_LABEL =
  "Claude Code accepts file edits without asking. The execution mode in Runtime settings applies to Codex only.";
export const CODEX_PERMISSION_LABEL = "Codex uses the permissions selected in Runtime settings.";
export const EXECUTION_MODE_SCOPE_LABEL =
  "This mode applies to Codex only. Claude Code conversations accept file edits without asking, whichever mode is selected.";

export function runtimePermissionLabel(engine: VivaryCodeEngine): string {
  return engine === "codex-cli" ? CODEX_PERMISSION_LABEL : CLAUDE_CODE_PERMISSION_LABEL;
}
