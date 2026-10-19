import { useId } from "react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@agent-native/toolkit/ui";
import { IconChevronDown, IconSettings } from "@tabler/icons-react";

export type CodeModelOption = { model: string; label: string; disabled: boolean; note?: string };
/** One runtime's models. `status` says why the runtime cannot take a new choice now. */
export type CodeRuntimeGroup = { engine: string; label: string; status?: string; options: CodeModelOption[] };

const routeValue = (engine: string, model: string) => JSON.stringify([engine, model]);

/**
 * The Code composer's one runtime and model control, inside the prompt box beside Send. It matches Core's Native
 * model button and lists models grouped by runtime. Radix supplies the menu roles, arrow keys, typeahead, Escape
 * and focus return. Choosing an item only reports the route. The conversation decides whether that selects it
 * or asks to switch.
 */
export function CodeModelPicker({ groups, engine, model, runtimeLabel, modelLabel, disabled, describedBy, onSelect, onSettings }: {
  groups: CodeRuntimeGroup[];
  engine: string;
  model: string;
  runtimeLabel: string;
  modelLabel: string;
  disabled: boolean;
  describedBy?: string;
  onSelect: (engine: string, model: string) => void;
  onSettings: () => void;
}) {
  const id = useId();
  return <DropdownMenu modal={false}>
    <DropdownMenuTrigger asChild disabled={disabled}>
      <button type="button" className="local-agent-model-button" aria-label={`Runtime and model: ${runtimeLabel} ${modelLabel}`}
        aria-describedby={describedBy}>
        <span className="local-agent-model-runtime">{runtimeLabel}</span>
        <span className="local-agent-model-name">{modelLabel}</span>
        <IconChevronDown className="local-agent-model-chevron" aria-hidden />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent side="top" align="end" collisionPadding={8} className="local-agent-model-menu">
      <DropdownMenuRadioGroup value={routeValue(engine, model)}>
        {groups.map((group, index) => <DropdownMenuGroup key={group.engine} aria-labelledby={`${id}-${index}`}>
          {index > 0 && <DropdownMenuSeparator />}
          <DropdownMenuLabel id={`${id}-${index}`} className="local-agent-model-group">
            <span>{group.label}</span>{group.status && <span className="local-agent-model-status">{group.status}</span>}
          </DropdownMenuLabel>
          {group.options.length ? group.options.map(option => <DropdownMenuRadioItem key={option.model}
            value={routeValue(group.engine, option.model)} disabled={option.disabled}
            className="local-agent-model-item" onSelect={() => onSelect(group.engine, option.model)}>
            <span className="local-agent-model-item-label">{option.label}</span>
            {option.note && <span className="local-agent-model-status">{option.note}</span>}
          </DropdownMenuRadioItem>)
            : <DropdownMenuItem disabled className="local-agent-model-item">No models available</DropdownMenuItem>}
        </DropdownMenuGroup>)}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem className="local-agent-model-item" onSelect={onSettings}>
        <IconSettings size={14} aria-hidden /> Runtime settings
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}
