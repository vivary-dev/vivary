import {
  IconBook2,
  IconFolder,
  IconLayoutColumns,
  IconMessageCircle,
  IconSearch,
  IconSettings,
  IconTerminal2,
} from "@tabler/icons-react";

export const navigationItems = [
  { href: "/", label: "Workspace", icon: IconMessageCircle, keywords: ["conversation", "project"] },
  { href: "/?panel=files", label: "Open files", icon: IconFolder, keywords: ["read", "edit", "rename"] },
  { href: "/?panel=details", label: "Project details", icon: IconLayoutColumns, keywords: ["host", "information"] },
  { href: "/?panel=search", label: "Search project", icon: IconSearch, keywords: ["find", "grep", "text", "filename", "regex"] },
] as const;

export const settingsItems = [
  {
    href: "/settings/architecture",
    label: "Documentation",
    icon: IconBook2,
    keywords: ["architecture", "high-level design", "how vivary works"],
  },
  {
    href: "/settings",
    label: "Settings",
    icon: IconSettings,
    keywords: ["theme", "appearance", "preferences"],
  },
  {
    href: "/settings/runtimes",
    label: "Coding runtimes",
    icon: IconTerminal2,
    keywords: ["local", "cli", "claude code", "codex", "sign in"],
  },
  {
    href: "/settings/agent#llm",
    label: "Model providers",
    icon: IconSettings,
    keywords: ["api key", "openai", "anthropic", "gemini", "models"],
  },
  {
    href: "/settings/integrations",
    label: "Integrations",
    icon: IconSettings,
    keywords: ["connections", "secrets"],
  },
  {
    href: "/settings/agent/resources",
    label: "Agent resources",
    icon: IconFolder,
    keywords: ["instructions", "skills", "memory"],
  },
] as const;

export function isConversationRoute(pathname: string) {
  return (
    pathname === "/" ||
    pathname === "/agent" ||
    pathname === "/chat" ||
    pathname === "/workbench"
  );
}

export function navigationTitle(pathname: string) {
  if (pathname.startsWith("/settings")) return "Settings";
  return (
    navigationItems.find((item) => item.href === pathname)?.label ?? "Vivary"
  );
}

export function fullChatHref(identity?: { storageKey: string; scope: { type: string; id: string } } | null) {
  if (!identity) return "/?runtime=native";
  try {
    const threadId = window.localStorage.getItem(
      `agent-chat-active-thread:${identity.storageKey}:scope:${identity.scope.type}:${identity.scope.id}`,
    );
    return threadId ? `/?runtime=native&thread=${encodeURIComponent(threadId)}` : "/?runtime=native";
  } catch {
    return "/?runtime=native";
  }
}
