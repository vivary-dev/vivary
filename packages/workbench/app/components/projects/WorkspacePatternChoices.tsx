import { useId } from "react";
import { Input } from "@/components/ui/input";

import type { WorkspacePatternChoice, WorkspacePatternDefinition } from "../../../shared/workspace-patterns.ts";
import type { z } from "zod";
import type { workspacePatternId } from "../../../shared/workspace-patterns.ts";
type WorkspacePatternId = z.infer<typeof workspacePatternId>;

export function WorkspacePatternChoices({
  catalog,
  value,
  onChange,
  disabled,
}: {
  catalog: WorkspacePatternDefinition[];
  value: WorkspacePatternChoice[];
  onChange: (choices: WorkspacePatternChoice[]) => void;
  disabled: boolean;
}) {
  const instanceId = useId();
  const selected = new Map(value.map(choice => [choice.id, choice]));

  function toggle(definition: WorkspacePatternDefinition, checked: boolean) {
    if (checked) {
      if (selected.has(definition.id)) return;
      onChange([...value, {
        id: definition.id,
        name: definition.defaultName,
        path: definition.defaultPath,
      }]);
      return;
    }
    onChange(value.filter(choice => choice.id !== definition.id));
  }

  function update(id: WorkspacePatternId, field: "name" | "path", next: string) {
    onChange(value.map(choice => choice.id === id ? { ...choice, [field]: next } : choice));
  }

  return <fieldset disabled={disabled} className="grid min-w-0 gap-3">
    <legend className="text-sm font-medium">Optional guidance</legend>
    <p className="text-xs leading-5 text-muted-foreground">
      Choose helpful files to include with this project. You can change their names and locations.
    </p>
    <div className="grid min-w-0 gap-2">
      {catalog.map(definition => {
        const choice = selected.get(definition.id);
        const descriptionId = `${instanceId}-workspace-pattern-${definition.id}-description`;
        const nameId = `${instanceId}-workspace-pattern-${definition.id}-name`;
        const pathId = `${instanceId}-workspace-pattern-${definition.id}-path`;
        return <section key={definition.id} className="grid min-w-0 gap-2 rounded-md border border-border p-3">
          <label className="flex min-w-0 items-start gap-2 text-sm font-medium">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-primary"
              aria-label={definition.label}
              aria-describedby={descriptionId}
              checked={choice !== undefined}
              onChange={event => toggle(definition, event.target.checked)}
            />
            <span className="min-w-0 break-words">
              {definition.label}
              <span id={descriptionId} className="mt-1 block text-xs leading-5 font-normal text-muted-foreground break-words">
                {definition.description}
              </span>
            </span>
          </label>
          {choice && <div className="grid min-w-0 gap-2">
            <label htmlFor={nameId} className="grid min-w-0 gap-1 text-xs">
              Name
              <Input
                id={nameId}
                aria-label={`${definition.label} name`}
                value={choice.name}
                autoComplete="off"
                className="min-w-0 w-full"
                onChange={event => update(definition.id, "name", event.target.value)}
              />
            </label>
            <label htmlFor={pathId} className="grid min-w-0 gap-1 text-xs">
              File location
              <Input
                id={pathId}
                aria-label={`${definition.label} path`}
                value={choice.path}
                autoComplete="off"
                className="min-w-0 w-full"
                onChange={event => update(definition.id, "path", event.target.value)}
              />
            </label>
          </div>}
        </section>;
      })}
    </div>
  </fieldset>;
}
