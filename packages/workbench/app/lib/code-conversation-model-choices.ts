import type { VivaryCodeState } from "../../server/local-code-agent";
import { CLAUDE_CODE_LEGACY_ALIASES } from "../../shared/claude-models";

export function codeConversationModelChoices(
  engine: VivaryCodeState["engines"][number], retained: boolean, selectedModel?: string,
): string[] {
  const models = retained ? [...engine.models]
    : engine.engine === "claude-cli" ? engine.claudeModels?.map(model => model.id) ?? []
    : engine.modelCatalog?.status === "ready" ? engine.modelCatalog.models.map(model => model.id) : [];
  // Retained runs may keep exact historical IDs. Saved Claude aliases are also admissible for new runs.
  if (selectedModel && !models.includes(selectedModel)
    && (retained || engine.engine === "claude-cli" && CLAUDE_CODE_LEGACY_ALIASES.includes(selectedModel))) {
    models.push(selectedModel);
  }
  return models;
}
