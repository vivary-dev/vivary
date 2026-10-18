import { BrowserAccessSettings } from "@/components/settings/BrowserAccessSettings";
import { useAppearancePreferences } from "@/components/layout/AppearancePreferences";
import { AppearancePicker } from "@agent-native/core/client/ui";
import {
  SettingsGroup,
  SettingsRow,
  SettingsTabsPage,
  useAgentSettingsTabs,
  type SettingsSearchEntry,
} from "@agent-native/core/client/settings";
import { useSetPageTitle } from "@agent-native/toolkit/app-shell";
import { Button } from "@agent-native/toolkit/ui";
import { IconFileCheck, IconTerminal2 } from "@tabler/icons-react";
import { AutomationFileReview } from "@/components/settings/AutomationFileReview";
import { LocalRuntimeSettings } from "@/components/settings/LocalRuntimeSettings";
import { McpSettings } from "@/components/settings/McpSettings";
import { useTheme } from "next-themes";
import { Link } from "react-router";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const generalSearchEntries: SettingsSearchEntry[] = [
  {
    id: "vivary-theme",
    label: "Theme",
    keywords: "appearance light dark system display",
    hash: "theme",
  },
  {
    id: "vivary-appearance",
    label: "Color palette",
    keywords: "appearance colors accent",
    hash: "appearance",
  },
  {
    id: "vivary-runtimes",
    label: "Coding runtimes",
    keywords: "local cli claude code codex sign in",
    tabId: "runtimes",
  },
  {
    id: "vivary-models",
    label: "Model providers",
    keywords: "api key openai anthropic gemini models",
    tabId: "agent",
    hash: "llm",
  },
];

export function meta() {
  return [{ title: "Settings | Vivary" }];
}

export default function SettingsRoute() {
  const { theme } = useTheme();
  const {
    ready, error, retryAppearance, retrySession, setTheme, setAppearance,
  } = useAppearancePreferences();
  const nativeTabs = useAgentSettingsTabs({
    appName: "Vivary",
    usageAppId: "vivary",
  });
  const runtimeTab = {
    id: "runtimes",
    label: "Coding runtimes",
    icon: IconTerminal2,
    group: "agent",
    keywords: "local cli claude code codex terminal coding sign in",
    content: <LocalRuntimeSettings />,
  };
  // Issue #109: files automation runs wrote wait here for the owner's review.
  const automationFilesTab = {
    id: "automation-files",
    label: "Automation files",
    icon: IconFileCheck,
    group: "agent",
    content: <AutomationFileReview />,
  };
  const browserTab = { id: "browser-access", label: "Remote access", icon: IconTerminal2, group: "agent", keywords: "remote access another device phone pair browser https tailscale", content: <BrowserAccessSettings /> };
  const tabs = nativeTabs
    .filter((tab) => tab.id !== "organization" && tab.id !== "workspace")
    .map((tab) => (tab.id === "mcp" ? { ...tab, keywords: "mcp", searchEntries: [], content: <McpSettings /> } : tab))
    .flatMap((tab) => (tab.id === "agent" ? [runtimeTab, browserTab, automationFilesTab, tab] : [tab]));
  useSetPageTitle("Settings");

  return (
    <SettingsTabsPage
      generalLabel="General"
      ariaLabel="Vivary settings"
      searchPlaceholder="Search settings"
      extraTabs={tabs}
      generalSearchEntries={generalSearchEntries}
      general={
        <div className="mx-auto w-full max-w-2xl space-y-6">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">General</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              Choose how the app looks and connect the models you want to use.
            </p>
          </div>
          {error && (
            <div role="status" className="flex items-center gap-3 text-sm text-destructive">
              <span>{error}</span>
              {retryAppearance && (
                <Button variant="ghost" size="sm" onClick={retryAppearance}>
                  Retry
                </Button>
              )}
              {retrySession && (
                <Button variant="ghost" size="sm" onClick={retrySession}>
                  Retry session
                </Button>
              )}
            </div>
          )}
          <SettingsGroup title="Appearance">
            <SettingsRow
              id="theme"
              label="Theme"
              description="Use a light or dark interface, or follow your computer."
              control={
                <Select
                  value={theme ?? "system"}
                  disabled={!ready}
                  onValueChange={(value) => {
                    if (
                      value === "light" ||
                      value === "dark" ||
                      value === "system"
                    )
                      setTheme(value);
                  }}
                >
                  <SelectTrigger className="w-40" aria-label="Theme">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">System</SelectItem>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
            <SettingsRow
              id="appearance"
              label="Color palette"
              description="Apply the same colors across the app."
              control={
                <fieldset disabled={!ready} aria-label="Color palette">
                  <AppearancePicker onChange={setAppearance} />
                </fieldset>
              }
            />
          </SettingsGroup>
          <SettingsGroup title="Models and tools">
            <SettingsRow
              label="Coding runtimes"
              description="Set up the local coding agents used by Agent."
              control={
                <Link className="vivary-settings-link" to="/settings/runtimes">
                  Set up coding runtimes
                </Link>
              }
            />
            <SettingsRow
              label="Model providers"
              description="Connect a provider and choose models for Full chat."
              control={
                <Link className="vivary-settings-link" to="/settings/agent#llm">
                  Set up providers
                </Link>
              }
            />
            <SettingsRow
              label="Integrations"
              description="Manage service connections and secrets."
              control={
                <Link
                  className="vivary-settings-link"
                  to="/settings/integrations"
                >
                  Open integrations
                </Link>
              }
            />
            <SettingsRow
              label="Agent resources"
              description="Manage instructions, skills, memory, and files."
              control={
                <Link
                  className="vivary-settings-link"
                  to="/settings/agent/resources"
                >
                  Open resources
                </Link>
              }
            />
          </SettingsGroup>
        </div>
      }
    />
  );
}
