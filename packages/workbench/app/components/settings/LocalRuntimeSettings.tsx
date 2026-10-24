import { useState } from "react";
import { actionErrorMessage, callAction, useActionQuery } from "@agent-native/core/client/hooks";
import { SettingsGroup, SettingsRow } from "@agent-native/core/client/settings";
import { Badge, Button, Skeleton } from "@agent-native/toolkit/ui";
import { IconExternalLink, IconRefresh } from "@tabler/icons-react";

import type { CodePermissionMode } from "../../../server/code-permissions";
import type { VivaryCodeEngine, VivaryRuntimeStatus, VivaryRuntimeStatusResult } from "../../../server/local-runtime-setup";

const runtimes = [
  {
    engine: "claude-cli",
    label: "Claude Code",
    signInCommand: "claude auth login",
    installUrl: "https://code.claude.com/docs/en/setup",
    helpUrl: "https://code.claude.com/docs/en/cli-usage",
    description: "Use Claude models with your Claude Code account.",
  },
  {
    engine: "codex-cli",
    label: "Codex",
    signInCommand: "codex login",
    installUrl: "https://developers.openai.com/codex/cli",
    helpUrl: "https://developers.openai.com/codex/auth",
    description: "Inspect your ChatGPT sign-in, Codex models, and configured tools.",
  },
] satisfies Array<{
  engine: VivaryCodeEngine;
  label: string;
  signInCommand: string;
  installUrl: string;
  helpUrl: string;
  description: string;
}>;

// The select below offers exactly the modes the permissions action accepts.
const permissionModes: readonly CodePermissionMode[] = ["normal", "read-only", "yolo"];

const statusLabels: Record<VivaryRuntimeStatus["status"], string> = {
  ready: "Signed in",
  "sign-in-required": "Sign-in required",
  "update-required": "Update required",
  "not-installed": "Not installed",
  unavailable: "Check needed",
};

export function LocalRuntimeSettings() {
  const status = useActionQuery<VivaryRuntimeStatusResult>("vivary-runtime-status", {}, {
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const permissions = useActionQuery<{ mode: "normal" | "read-only" | "yolo" }>("vivary-code-permissions", {}, { retry: false });
  const [saving, setSaving] = useState(false);
  async function saveMode(mode: CodePermissionMode) {
    setSaving(true);
    setRefreshError(undefined);
    try {
      await callAction("vivary-code-permissions-set", { mode });
      await permissions.refetch();
    } catch (failure) { setRefreshError(actionErrorMessage(failure) ?? "Permissions could not be saved."); }
    finally { setSaving(false); }
  }
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();
  const error = refreshError ?? actionErrorMessage(status.error);
  const checking = status.isPending || refreshing;

  async function refresh() {
    setRefreshing(true);
    setRefreshError(undefined);
    try {
      await callAction<VivaryRuntimeStatusResult>("vivary-runtime-status", { refresh: true }, { method: "GET" });
      await status.refetch({ throwOnError: true });
    } catch (failure) {
      setRefreshError(actionErrorMessage(failure) ?? "Runtime status could not be checked. Try again.");
    } finally {
      setRefreshing(false);
    }
  }

  return <div className="mx-auto w-full max-w-2xl space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-semibold tracking-tight">Coding runtimes</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Vivary uses the coding agents installed on this computer. Choose a runtime when starting a conversation.
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={checking}>
        <IconRefresh size={16} className={refreshing ? "animate-spin motion-reduce:animate-none" : undefined} />
        {refreshing ? "Checking" : "Refresh"}
      </Button>
    </div>

    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

    <SettingsGroup title="Codex permissions">
      <SettingsRow id="codex-permissions" label="Execution mode" description="Applies when you send your next message. Running work keeps its current permissions.">
        <select aria-label="Codex execution mode" className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={permissions.data?.mode ?? "normal"} disabled={saving || !permissions.data}
          onChange={event => {
            const next = permissionModes.find(mode => mode === event.target.value);
            if (next) void saveMode(next);
          }}>
          <option value="normal">Normal</option><option value="read-only">Read only</option><option value="yolo">YOLO</option>
        </select>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {permissions.data?.mode === "yolo" ? "Codex can run commands with full host access without asking for approval. Use this only with projects and instructions you trust."
            : permissions.data?.mode === "read-only" ? "Codex can inspect local files but cannot edit them or request broader command permissions. Connected services retain their own access settings."
              : "Codex can work inside the project. It asks before actions that need broader access."}
        </p>
        {permissions.error && <p role="alert" className="text-sm text-destructive">Permissions could not be loaded. <button onClick={() => void permissions.refetch()}>Retry</button></p>}
      </SettingsRow>
    </SettingsGroup>
    <SettingsGroup title="Local agents">
      {runtimes.map(runtime => {
        const current = status.data?.runtimes.find(item => item.engine === runtime.engine);
        return <SettingsRow key={runtime.engine} id={runtime.engine} label={runtime.label}
          description={runtime.description}
          status={status.isPending
            ? <Skeleton className="h-5 w-20 rounded-full" />
            : <Badge variant={current?.status === "ready" ? "secondary" : "outline"}>
                {current ? statusLabels[current.status] : "Not checked"}
              </Badge>}
        >
          {status.isPending
            ? <div className="space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /></div>
            : <p className="text-sm leading-6 text-muted-foreground" role="status">
                {current?.message ?? "Refresh to check this runtime."}
              </p>}
          {runtime.engine === "claude-cli" && status.data?.claudeModels && <div className="mt-3 space-y-2 text-sm text-muted-foreground">
            <p>Installed version: {current?.version ?? "Unverified"}. Model IDs and API list prices verified 2026-10-13.</p>
            {status.data.claudeModels.map(model => <p key={model.id}>
              {model.label} ({model.id}). {model.message} API list price per million tokens: {model.apiPrice}.
            </p>)}
            <p>API list prices are reference information. They do not describe your subscription bill or included model access.</p>
          </div>}
          {runtime.engine === "codex-cli" && status.data?.codexModels && <div className="mt-3 space-y-2 text-sm text-muted-foreground">
            <p>{status.data.codexModels.message}</p>
            {status.data.codexModels.status === "ready" && <>
              <p>{status.data.codexModels.models.length} models reported by Codex.</p>
              <p>Configured connections: {status.data.codexModels.connections.length
                ? status.data.codexModels.connections.join(", ") : "None"}.</p>
              <p>Connection names come from Codex settings. Availability is checked when Codex uses them.</p>
            </>}
          </div>}
          <details className="mt-3 text-sm" open={current?.status !== "ready"}>
            <summary className="w-fit cursor-pointer font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {current?.status === "ready" ? "Setup and sign-in help" : "Set up " + runtime.label}
            </summary>
            <ol className="mt-3 list-decimal space-y-3 pl-5 text-muted-foreground">
              <li>
                <a className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4"
                  href={runtime.installUrl} target="_blank" rel="noopener noreferrer">
                  {current?.status === "update-required" ? "Update" : "Install"} {runtime.label}<IconExternalLink size={14} aria-hidden="true" />
                </a>{" "}using the official instructions.
              </li>
              <li>
                Open your terminal and run:
                <code className="mt-2 block w-fit max-w-full overflow-x-auto rounded-md bg-muted px-3 py-2 text-foreground">
                  {runtime.signInCommand}
                </code>
              </li>
              <li>Finish signing in through your browser, then select Refresh above.</li>
            </ol>
            <a className="mt-3 inline-flex items-center gap-1 text-muted-foreground underline underline-offset-4"
              href={runtime.helpUrl} target="_blank" rel="noopener noreferrer">
              {runtime.label} sign-in help<IconExternalLink size={14} aria-hidden="true" />
            </a>
          </details>
        </SettingsRow>;
      })}
    </SettingsGroup>
    <p className="text-sm leading-6 text-muted-foreground">
      Your coding agent manages its own credentials. Vivary does not need an account.
    </p>
  </div>;
}
