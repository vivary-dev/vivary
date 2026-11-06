import { BrowserConnection } from "./components/layout/BrowserConnection";
import {
  AppProviders,
  createAgentNativeQueryClient,
} from "@agent-native/core/client/hooks";
import {
  CommandMenu,
  useCommandMenuShortcut,
} from "@agent-native/core/client/navigation";
import { getThemeInitScript } from "@agent-native/core/client/ui";
import { ToolkitProvider } from "@agent-native/toolkit";
import { IconMoon, IconSun } from "@tabler/icons-react";
import { useTheme } from "next-themes";
import { useCallback, useState, type ReactNode } from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useNavigate,
} from "react-router";
import {
  AppearancePreferencesProvider,
  useAppearancePreferences,
} from "./components/layout/AppearancePreferences";
import { Layout as AppLayout } from "./components/layout/Layout";
import { FileDraftProvider } from "./components/projects/FileDrafts";
import "./project-files.css";
import { ProjectProvider } from "./components/projects/ProjectContext";
import { designSystem } from "./design-system";
import { navigationItems, settingsItems } from "./lib/navigation";
import stylesheet from "./global.css?url";

export const links = () => [{ rel: "stylesheet", href: stylesheet }];

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: getThemeInitScript("system") }}
        />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

function AppContent() {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const { ready, setTheme } = useAppearancePreferences();
  const [commandOpen, setCommandOpen] = useState(false);
  useCommandMenuShortcut(useCallback(() => setCommandOpen(true), []));
  const isDark = resolvedTheme === "dark";
  return (
    <>
      <CommandMenu
        open={commandOpen}
        onOpenChange={setCommandOpen}
        placeholder="Search Vivary"
        showAgentFallback={false}
      >
        <CommandMenu.Group heading="Workspace">
          {navigationItems.map((item) => (
            <CommandMenu.Item
              key={item.href}
              keywords={[...item.keywords]}
              onSelect={() =>
                navigate(
                  item.href.startsWith("/?") ? (() => { const params = new URLSearchParams(window.location.search); params.set("panel", new URLSearchParams(item.href.slice(2)).get("panel") ?? "details"); return "/?" + params.toString(); })() : item.href,
                )
              }
            >
              <item.icon className="size-4" aria-hidden />
              {item.label}
            </CommandMenu.Item>
          ))}
        </CommandMenu.Group>
        <CommandMenu.Group heading="Settings">
          {settingsItems.map((item) => (
            <CommandMenu.Item
              key={item.href}
              keywords={[...item.keywords]}
              onSelect={() => navigate(item.href)}
            >
              <item.icon className="size-4" aria-hidden />
              {item.label}
            </CommandMenu.Item>
          ))}
          {ready && (
            <CommandMenu.Item
              onSelect={() => setTheme(isDark ? "light" : "dark")}
              keywords={["theme", "dark", "light", "mode"]}
            >
              {isDark ? (
                <IconSun className="size-4" aria-hidden />
              ) : (
                <IconMoon className="size-4" aria-hidden />
              )}
              {isDark ? "Use light theme" : "Use dark theme"}
            </CommandMenu.Item>
          )}
        </CommandMenu.Group>
      </CommandMenu>
      <AppLayout>
        <Outlet />
      </AppLayout>
    </>
  );
}

export default function Root() {
  const [queryClient] = useState(() => createAgentNativeQueryClient());
  return (
    <BrowserConnection><ToolkitProvider designSystem={designSystem}>
      <AppProviders
        queryClient={queryClient}
        defaultTheme="system"
        documentTitleFallback="Vivary"
        clientOnlyFallback={
          <div className="shell-skeleton" role="status">
            <span className="sr-only">Opening Vivary</span>
            <div />
            <div />
          </div>
        }
      >
        <AppearancePreferencesProvider>
          <ProjectProvider>
            <FileDraftProvider><AppContent /></FileDraftProvider>
          </ProjectProvider>
        </AppearancePreferencesProvider>
      </AppProviders>
    </ToolkitProvider></BrowserConnection>
  );
}

export { ErrorBoundary } from "@agent-native/core/client/ui";
