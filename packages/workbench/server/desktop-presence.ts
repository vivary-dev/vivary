import { readAppState } from "@agent-native/core/application-state";
import { eq } from "@agent-native/core/db/schema";
import { z } from "zod";

import { selectionSchema } from "../app/lib/project-catalog-schema.ts";
import { VIVARY_LOCAL_OWNER_EMAIL } from "../shared/owner-session";
import { desktopHostAvailable } from "./desktop-host.ts";
import { getDb } from "./db/index.mjs";
import { projects } from "./db/schema.mjs";
import { getVivaryCodeHostState } from "./local-code-agent.ts";
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

async function readSelectedProjectId(): Promise<string | null> {
  const raw = await readAppState(SELECTION_KEY);
  const parsed = selectionSchema.safeParse(raw);
  if (!parsed.success || parsed.data.projectId === null) return null;
  return parsed.data.projectId;
}

async function readProjectLabel(projectId: string): Promise<string | null> {
  const [row] = await getDb().select({ displayName: projects.displayName })
    .from(projects).where(eq(projects.projectId, projectId)).limit(1);
  return sanitizeLabel(row?.displayName ?? null);
}

function resolvePhase(
  host: Awaited<ReturnType<typeof getVivaryCodeHostState>>,
  selectedProjectId: string | null,
): z.infer<typeof desktopPresencePhaseSchema> {
  if (!selectedProjectId) return "hidden";
  const activeProjectId = host.activeRun?.projectId ?? host.pendingApproval?.projectId ?? null;
  const scoped = activeProjectId === null || activeProjectId === selectedProjectId;
  if (host.pendingApproval && scoped) return "review";
  if (host.activeRun && scoped) return "agent";
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

export async function buildDesktopPresenceSnapshot(
  ownerEmail = VIVARY_LOCAL_OWNER_EMAIL,
): Promise<DesktopPresenceSnapshot> {
  const selectedProjectId = await readSelectedProjectId();
  const host = await getVivaryCodeHostState(ownerEmail);
  const phase = resolvePhase(host, selectedProjectId);
  const projectLabel = phase === "hidden" ? null : await readProjectLabel(selectedProjectId!);
  if (phase !== "hidden" && !projectLabel) {
    return desktopPresenceSnapshotSchema.parse({ phase: "hidden", projectLabel: null, startedAt: phaseStartedAt });
  }
  const startedAt = phaseClock(phase, projectLabel);
  return desktopPresenceSnapshotSchema.parse({ phase, projectLabel, startedAt });
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

export function installDesktopPresencePublisher() {
  if (!desktopHostAvailable()) return () => undefined;
  let lastPayload = "";
  let timer;
  const tick = async () => {
    try {
      const snapshot = await buildDesktopPresenceSnapshot();
      const payload = JSON.stringify(snapshot);
      if (payload === lastPayload) return;
      lastPayload = payload;
      notifyParent(snapshot);
    } catch {
      // Discord presence must never disturb the local server.
    }
  };
  timer = setInterval(() => { void tick(); }, PRESENCE_POLL_MS);
  timer.unref?.();
  void tick();
  return () => {
    clearInterval(timer);
  };
}
