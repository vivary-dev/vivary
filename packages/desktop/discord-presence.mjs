import { createHash } from "node:crypto";

import { Client } from "@xhayper/discord-rpc";

import { readDesktopSettings } from "./desktop-settings.mjs";

const RETRY_MS = 30_000;
const MAX_STATE_CHARS = 128;
const MAX_DETAILS_CHARS = 128;

export function sanitizePresenceText(value, max = MAX_STATE_CHARS) {
  if (typeof value !== "string") return "";
  const cleaned = Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 32 && code !== 127 && code !== 60 && code !== 62;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || /[\\/]/.test(cleaned) || /^[A-Za-z]:/.test(cleaned)) return "";
  return Array.from(cleaned).length <= max ? cleaned : `${Array.from(cleaned).slice(0, max - 1).join("")}…`;
}

export function presenceStateLine(phase) {
  if (phase === "agent") return "Agent running";
  if (phase === "review") return "Reviewing";
  return "Managing memory";
}

export function buildDiscordActivity(snapshot) {
  if (!snapshot || snapshot.phase === "hidden" || !snapshot.projectLabel) return null;
  const details = sanitizePresenceText(snapshot.projectLabel, MAX_DETAILS_CHARS);
  const state = sanitizePresenceText(presenceStateLine(snapshot.phase), MAX_STATE_CHARS);
  if (!details || !state) return null;
  const startedAt = Number.isInteger(snapshot.startedAt) ? snapshot.startedAt : Math.floor(Date.now() / 1000);
  return { details, state, startTimestamp: startedAt * 1000, instance: true };
}

export function presenceFingerprint(snapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot ?? null)).digest("hex");
}

export function createDiscordPresenceController({
  readSettings = readDesktopSettings,
  ClientImpl = Client,
  pid = process.pid,
} = {}) {
  let settings = defaultSettings();
  let snapshot = null;
  let fingerprint = "";
  let client = null;
  let connecting = null;
  let retryTimer = null;
  let disposed = false;

  function defaultSettings() {
    return { discord: { enabled: false, applicationId: "" } };
  }

  function clearRetry() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry(delayMs = RETRY_MS) {
    if (disposed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void syncActivity();
    }, delayMs);
    retryTimer.unref?.();
  }

  async function closeClient() {
    clearRetry();
    connecting = null;
    if (!client) return;
    const active = client;
    client = null;
    try {
      await active.destroy();
    } catch {
      // Discord may already be gone during shutdown.
    }
  }

  async function ensureClient() {
    if (client?.user) return client;
    if (connecting) return connecting;
    if (!settings.discord.enabled || !settings.discord.applicationId) return null;
    connecting = (async () => {
      const next = new ClientImpl({ clientId: settings.discord.applicationId });
      next.on("disconnected", () => {
        if (client === next) client = null;
        scheduleRetry();
      });
      await next.login();
      if (disposed) {
        await next.destroy();
        return null;
      }
      client = next;
      return next;
    })();
    try {
      return await connecting;
    } catch {
      client = null;
      scheduleRetry();
      return null;
    } finally {
      connecting = null;
    }
  }

  async function pushActivity(activity) {
    const live = await ensureClient();
    if (!live?.user) return;
    if (!activity) {
      await live.user.clearActivity(pid);
      return;
    }
    await live.user.setActivity({
      details: activity.details,
      state: activity.state,
      startTimestamp: activity.startTimestamp,
      instance: activity.instance,
    }, pid);
  }

  async function syncActivity() {
    if (disposed) return;
    if (!settings.discord.enabled || !settings.discord.applicationId) {
      await closeClient();
      return;
    }
    const activity = buildDiscordActivity(snapshot);
    try {
      await pushActivity(activity);
    } catch {
      await closeClient();
      scheduleRetry();
    }
  }

  return {
    async reloadSettings() {
      const next = await readSettings();
      const applicationChanged = next.discord.applicationId !== settings.discord.applicationId
        || next.discord.enabled !== settings.discord.enabled;
      settings = next;
      fingerprint = "";
      if (applicationChanged) await closeClient();
      await syncActivity();
    },
    updateSnapshot(next) {
      const nextFingerprint = presenceFingerprint(next);
      if (nextFingerprint === fingerprint) return;
      fingerprint = nextFingerprint;
      snapshot = next;
      void syncActivity();
    },
    async clear() {
      fingerprint = "";
      snapshot = null;
      try {
        if (client?.user) await client.user.clearActivity(pid);
      } catch {
        // Discord may already be gone during shutdown.
      } finally {
        await closeClient();
      }
    },
    dispose() {
      disposed = true;
      void this.clear();
    },
  };
}
