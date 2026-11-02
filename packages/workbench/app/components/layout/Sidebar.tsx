import { openCommandMenu } from "@agent-native/core/client/navigation";
import { IconBook2, IconSearch, IconSettings } from "@tabler/icons-react";
import { Link } from "react-router";
import { useProjects } from "../projects/ProjectContext";
import { ProjectNavigation } from "../projects/ProjectNavigation";
import { ProjectHistory } from "./ProjectHistory";
import { ChatHistory } from "./ChatHistory";
import { useVivaryChatIdentity } from "./use-vivary-chat-identity";

export function Sidebar() {
  const { identity } = useVivaryChatIdentity("unassigned");
  const { activeProject } = useProjects();
  return <aside className="vivary-sidebar flex h-full min-w-0 flex-col overflow-hidden" aria-label="Projects and conversations">
    <div className="vivary-sidebar-brand">
      <Link to="/" className="flex min-w-0 flex-1 items-center gap-3" aria-label="Vivary home">
        <span className="vivary-mark" aria-hidden>V</span><span className="text-sm font-semibold">Vivary</span>
      </Link>
    </div>
    <div className="vivary-sidebar-content">
      <div className="vivary-project-navigation"><ProjectNavigation /></div>
      <section className="workspace-project-conversations">
        <h2>{activeProject?.displayName ?? "Personal workspace"} conversations</h2>
        <ProjectHistory />
      </section>
      {identity && <details className="workspace-saved-conversations">
        <summary>Unassigned conversations</summary>
        <p>Earlier chats keep their original history and are not assigned to a project.</p>
        <ChatHistory key={identity.storageKey} identity={identity} />
      </details>}
    </div>
    <footer className="workspace-navigation-footer">
      <Link className="vivary-nav-link" to="/settings/architecture"><IconBook2 size={17} aria-hidden />Documentation</Link>
      <Link className="vivary-nav-link" to="/settings"><IconSettings size={17} aria-hidden />Settings</Link>
      <button className="vivary-sidebar-utility" onClick={openCommandMenu} aria-label="Search Vivary"><IconSearch size={18} aria-hidden /></button>
    </footer>
  </aside>;
}
