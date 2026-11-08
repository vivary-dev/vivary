import { readAppState } from "@agent-native/core/application-state";
import { getDbExec } from "@agent-native/core/db";
import { resolveOrgIdForEmail } from "@agent-native/core/org";
import { runWithRequestContext } from "@agent-native/core/server";
import { z } from "zod";

import { selectionSchema, type ProjectSelection } from "../app/lib/project-catalog-schema.ts";
import { VIVARY_LOCAL_OWNER_EMAIL } from "../shared/owner-session";
import { desktopHostAvailable } from "./desktop-host.ts";
import { getVivaryCodeHostState } from "./local-code-agent.ts";
import { catalogScopeKey } from "./project-scope.mjs";
import { readLocalProjectScope } from "./project-services.mjs";
import {
  readDesktopSettings,
  writeDesktopSettings,
  type DesktopSettings,
} from "./desktop-settings-store.ts";

const SELECTION_KEY = "vivary-project-selection-v1";
const PRESENCE_POLL_MS = 5_000;

export const desktopPresencePhaseSchema = z.enum(["hidden", "idle", "agent", "review"]);
export const desktopPresenceSnapshotSchema = z.strictObject({
  phase: desktopPresencePhaseSchema,
  projectLabel: z.string().max(128).nullable(),
  startedAt: z.number().int().nonnegative(),
});

export type DesktopPresenceSnapshot = z.infer<typeof desktopPresenceSnapshotSchema>;
type CodeHostState = Awaited<ReturnType<typeof getVivaryCodeHostState>>;

/**
 * Installation seams for the poller. Defaults are the production readers; the
 * test replaces them so it can run the snapshot build without a database, a
 * registry service, or a code host.
 */
export type DesktopPresenceDependencies = {
  readSelection?: () => Promise<ProjectSelection | null>;
  readScopeKey?: (ownerEmail: string) => Promise<string | null>;
  readHost?: (ownerEmail: string) => Promise<CodeHostState>;
  readLabel?: (projectId: string) => Promise<string | null>;
};

function sanitizeLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127 && code !== 92 && code !== 47;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return Array.from(cleaned).length <= 128 ? cleaned : `${Array.from(cleaned).slice(0, 127).join("")}…`;
}

async function readProjectSelection(): Promise<ProjectSelection | null> {
  const raw = await readAppState(SELECTION_KEY);
  const parsed = selectionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function readProjectLabel(projectId: string): Promise<string | null> {
  const { rows } = await getDbExec().execute({
    sql: "SELECT display_name FROM vivary_registry_projects WHERE project_id = ? LIMIT 1",
    args: [projectId],
  });
  const displayName = rows[0]?.display_name;
  return sanitizeLabel(typeof displayName === "string" ? displayName : null);
}

/**
 * The scope the catalog would show this owner right now. Presence must degrade
 * to hidden rather than fail while project services warm up or after the local
 * scope changes, so every refusal becomes null here.
 */
async function readCatalogScopeKey(ownerEmail: string): Promise<string | null> {
  try {
    const orgId = await resolveOrgIdForEmail(ownerEmail);
    if (!orgId) return null;
    const scope = await readLocalProjectScope({
      userEmail: ownerEmail,
      orgId,
      appId: "workbench",
      caller: "http",
    });
    return scope ? catalogScopeKey(scope) : null;
  } catch {
    return null;
  }
}

function resolvePhase(
  host: CodeHostState,
  selectedProjectId: string | null,
): z.infer<typeof desktopPresencePhaseSchema> {
  if (!selectedProjectId) return "hidden";
  // Several conversations can run at once (#261). A run counts for the selected project when it has no project, as in the
  // personal workspace, or the same one. A pending request on any counting run outranks work.
  const scoped = host.activeRuns.filter(run => run.projectId === null || run.projectId === selectedProjectId);
  if (scoped.some(run => run.pendingApprovals.length > 0)) return "review";
  if (scoped.length > 0) return "agent";
  return "idle";
}

let phaseStartedAt = Math.floor(Date.now() / 1000);
let lastPhaseKey = "";

function phaseClock(phase: z.infer<typeof desktopPresencePhaseSchema>, projectLabel: string | null) {
  const key = `${phase}:${projectLabel ?? ""}`;
  if (key !== lastPhaseKey) {
    lastPhaseKey = key;
    phaseStartedAt = Math.floor(Date.now() / 1000);
  }
  return phaseStartedAt;
}

/**
 * The poller runs from a Nitro plugin, outside any request, so the app-state
 * read needs the owner's request context the way code-permissions.ts provides
 * one. A saved selection also only counts while it belongs to the owner's
 * current catalog scope; a stale one would show a project they no longer have.
 */
export async function buildDesktopPresenceSnapshot(
  ownerEmail = VIVARY_LOCAL_OWNER_EMAIL,
  dependencies: DesktopPresenceDependencies = {},
): Promise<DesktopPresenceSnapshot> {
  const {
    readSelection = readProjectSelection,
    readScopeKey = readCatalogScopeKey,
    readHost = getVivaryCodeHostState,
    readLabel = readProjectLabel,
  } = dependencies;
  return runWithRequestContext({ userEmail: ownerEmail }, async () => {
    const selection = await readSelection();
    const currentScopeKey = selection?.projectId == null ? null : await readScopeKey(ownerEmail);
    const selectedProjectId = selection !== null && selection.projectId !== null
      && currentScopeKey === selection.scopeKey ? selection.projectId : null;
    const host = await readHost(ownerEmail);
    const phase = resolvePhase(host, selectedProjectId);
    const projectLabel = phase === "hidden" || selectedProjectId === null
      ? null : await readLabel(selectedProjectId);
    if (phase !== "hidden" && !projectLabel) {
      return desktopPresenceSnapshotSchema.parse({ phase: "hidden", projectLabel: null, startedAt: phaseStartedAt });
    }
    const startedAt = phaseClock(phase, projectLabel);
    return desktopPresenceSnapshotSchema.parse({ phase, projectLabel, startedAt });
  });
}

function notifyParent(snapshot: DesktopPresenceSnapshot) {
  if (!process.connected || typeof process.send !== "function") return;
  try {
    process.send({ type: "vivary:desktop:presence", snapshot }, () => undefined);
  } catch {
    // Parent may disconnect during shutdown.
  }
}

function notifySettingsChanged(settings: DesktopSettings) {
  if (!process.connected || typeof process.send !== "function") return;
  try {
    process.send({ type: "vivary:desktop:settings", settings }, () => undefined);
  } catch {
    // Parent may disconnect during shutdown.
  }
}

export async function publishDesktopPresenceSnapshot() {
  if (!desktopHostAvailable()) return null;
  const snapshot = await buildDesktopPresenceSnapshot();
  notifyParent(snapshot);
  return snapshot;
}

export async function updateDesktopSettings(input: unknown) {
  const settings = await writeDesktopSettings(input);
  notifySettingsChanged(settings);
  await publishDesktopPresenceSnapshot();
  return settings;
}

export { readDesktopSettings, writeDesktopSettings };
export type { DesktopSettings };

export function createDesktopPresencePublisher({
  readEnabled = async () => (await readDesktopSettings()).discord.enabled,
  buildSnapshot = () => buildDesktopPresenceSnapshot(),
  notify = notifyParent,
  pollMs = PRESENCE_POLL_MS,
}: {
  readEnabled?: () => Promise<boolean>;
  buildSnapshot?: () => Promise<DesktopPresenceSnapshot>;
  notify?: (snapshot: DesktopPresenceSnapshot) => void;
  pollMs?: number;
} = {}) {
  let lastPayload = "";
  const hidden = (): DesktopPresenceSnapshot => ({ phase: "hidden", projectLabel: null, startedAt: phaseStartedAt });
  const tick = async () => {
    let snapshot: DesktopPresenceSnapshot;
    try {
      // With sharing Off a tick reads only the settings file. The selection, org, scope and code host stay untouched.
      snapshot = await readEnabled() ? await buildSnapshot() : hidden();
    } catch {
      // Discord presence must never disturb the local server. A snapshot that cannot be built hides presence,
      // so Discord does not keep showing the last project.
      snapshot = hidden();
    }
    const payload = JSON.stringify(snapshot);
    if (payload === lastPayload) return null;
    lastPayload = payload;
    notify(snapshot);
    return snapshot;
  };
  const start = () => {
    const timer = setInterval(() => { void tick(); }, pollMs);
    timer.unref?.();
    void tick();
    return () => {
      clearInterval(timer);
    };
  };
  return { tick, start };
}

export function installDesktopPresencePublisher() {
  if (!desktopHostAvailable()) return () => undefined;
  return createDesktopPresencePublisher().start();
}
