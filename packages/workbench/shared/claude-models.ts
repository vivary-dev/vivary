// Verified 2026-10-13 against Anthropic's model overview, pricing, and Claude Code model configuration.
// https://platform.claude.com/docs/en/models/overview
// https://platform.claude.com/docs/en/about-claude/pricing
// https://code.claude.com/docs/en/model-config
export type ClaudeCodeModelId = "claude-sonnet-5-5" | "claude-haiku-5-5" | "claude-opus-5-5" | "claude-fable-5-1";
import { compareReleaseVersions } from "./runtime-versions";

export const CLAUDE_CODE_DEFAULT_MODEL: ClaudeCodeModelId = "claude-sonnet-5-5";
export const CLAUDE_CODE_LEGACY_ALIASES: readonly string[] = ["sonnet", "haiku", "opus", "fable"];

export const CLAUDE_CODE_MODELS: readonly {
  id: ClaudeCodeModelId; label: string; minimumVersion: string; apiPrice: string;
}[] = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", minimumVersion: "2.1.284", apiPrice: "$2 input / $10 output" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", minimumVersion: "2.1.293",
    apiPrice: "$0.10 input / $0.50 output at up to 100K input tokens, $0.50 input / $2.50 output above 100K" },
  { id: "claude-opus-5-5", label: "Opus 5.5", minimumVersion: "2.1.280", apiPrice: "$4 input / $20 output" },
  { id: "claude-fable-5-1", label: "Fable 5.1", minimumVersion: "2.1.257", apiPrice: "$10 input / $50 output" },
];

export function claudeCodeModelChoices(version?: string) {
  return CLAUDE_CODE_MODELS.map(model => {
    const difference = compareReleaseVersions(version, model.minimumVersion);
    const support = difference === undefined ? "unverified" : difference >= 0 ? "supported" : "upgrade-required";
    return { ...model, support,
      message: support === "supported" ? `Claude Code ${version} supports this model ID.`
        : support === "upgrade-required" ? `Requires Claude Code ${model.minimumVersion} or later. Installed: ${version}.`
        : `Requires Claude Code ${model.minimumVersion} or later. Installed version is unverified.` };
  });
}
