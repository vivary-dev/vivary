import { HeaderActionsProvider } from "@agent-native/toolkit/app-shell";
import { Button, ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@agent-native/toolkit/ui";
import { IconMenu2 } from "@tabler/icons-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigationType } from "react-router";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Header } from "./Header";
import { CodeRunControl } from "./CodeRunControl";
import { Sidebar } from "./Sidebar";
import { SettingsPromptAlert } from "./SettingsPromptAlert";
import { Workspace } from "../workspace/Workspace";
import { useSettingsChatHandoff } from "@/lib/settings-chat-handoff";
import { readPanelWidth, savePanelWidth, useNarrowLayout, type PanelHandle } from "./use-workspace-layout";

const WIDTH_KEY = "vivary.navigation.width";
const CLOSED_KEY = "vivary.sidebar.collapsed";
function readClosed() {
  try { return window.localStorage.getItem(CLOSED_KEY) === "1"; } catch { return false; }
}

export function Layout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const previousPathname = useRef(location.pathname);
  const settings = location.pathname.startsWith("/settings");
  const handoff = useSettingsChatHandoff(settings);
  const narrow = useNarrowLayout();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readClosed);
  const panel = useRef<PanelHandle>(null);
  const shell = useRef<HTMLDivElement>(null);
  const [shellWidth, setShellWidth] = useState(0);
  useEffect(() => {
    const element = shell.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setShellWidth(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const opener = useRef<HTMLButtonElement>(null);
  const [width] = useState(() => readPanelWidth(WIDTH_KEY, 248, 200, 400));

  useEffect(() => {
    if (narrow || collapsed) panel.current?.collapse();
    else panel.current?.resize(readPanelWidth(WIDTH_KEY, width, 200, 400));
  }, [narrow, collapsed, width, shellWidth]);
  useEffect(() => {
    const changedPage = previousPathname.current !== location.pathname;
    previousPathname.current = location.pathname;
    // Conversation restoration replaces query state without a navigation choice.
    if (changedPage || navigationType !== "REPLACE") setMobileOpen(false);
  }, [location.key, location.pathname, navigationType]);

  function changeCollapsed(next: boolean) {
    setCollapsed(next);
    try { window.localStorage.setItem(CLOSED_KEY, next ? "1" : "0"); } catch { /* Keep the control usable. */ }
    if (next) requestAnimationFrame(() => opener.current?.focus());
  }
  function showNavigation() {
    if (narrow) setMobileOpen(true);
    else changeCollapsed(!collapsed);
  }

  return <HeaderActionsProvider>
    <div ref={shell} className="agent-layout-shell vivary-shell flex w-full overflow-hidden bg-background text-foreground">
      <a className="skip-link" href="#workbench-content">Skip to content</a>
      <ResizablePanelGroup orientation="horizontal" className="h-full" onLayoutChanged={(_, meta) => {
        if (meta.isUserInteraction && !narrow && panel.current) {
          const size = panel.current.getSize().inPixels;
          if (size >= 200) savePanelWidth(WIDTH_KEY, size);
          if (panel.current.isCollapsed() !== collapsed) changeCollapsed(panel.current.isCollapsed());
        }
      }}>
        <ResizablePanel id="projects" panelRef={panel} defaultSize={narrow || collapsed ? 0 : width}
          minSize={200} maxSize={400} collapsible collapsedSize={0} groupResizeBehavior="preserve-pixel-size">
          <div className="h-full" hidden={narrow || collapsed}>
            <Sidebar />
          </div>
        </ResizablePanel>
        <ResizableHandle className="workspace-resize-handle" disabled={narrow || collapsed}
          hidden={narrow || collapsed} aria-label="Resize project navigation" />
        <ResizablePanel id="workspace" minSize={narrow ? 0 : 400}>
          <div className="flex h-full min-h-0 min-w-0 flex-col">
            <header className="workspace-topbar">
              <Button ref={opener} size="icon" variant="ghost" onClick={showNavigation}
                aria-label={narrow || collapsed ? "Open navigation" : "Close navigation"}
                aria-expanded={narrow ? mobileOpen : !collapsed}><IconMenu2 size={18} aria-hidden /></Button>
              <span className="text-sm font-semibold">Vivary</span>
              {settings && <Link className="ml-auto text-sm underline" to="/">Return to workspace</Link>}
            </header>
            <CodeRunControl />
            {handoff.undelivered && <SettingsPromptAlert
              key={handoff.undelivered.submitMessageId ?? handoff.undelivered.prompt}
              undelivered={handoff.undelivered} onDismiss={handoff.dismiss} />}
            <main id="workbench-content" tabIndex={-1} className="relative min-h-0 min-w-0 flex-1">
              {!settings && <div className="h-full"><Workspace /></div>}
              {settings && <div className="h-full overflow-auto"><Header />{children}</div>}
            </main>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-[300px] max-w-[90vw] p-0"
          onCloseAutoFocus={event => { event.preventDefault(); opener.current?.focus(); }}>
          <SheetTitle className="sr-only">Projects and conversations</SheetTitle>
          <SheetDescription className="sr-only">Choose a project, open its conversation, or change settings.</SheetDescription>
          <Sidebar />
        </SheetContent>
      </Sheet>
    </div>
  </HeaderActionsProvider>;
}
