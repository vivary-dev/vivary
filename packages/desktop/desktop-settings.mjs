import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export function desktopDataDir(home = homedir()) {
  return path.join(home, ".vivary", "workbench");
}

export const DESKTOP_SETTINGS_FILE = "desktop-settings.json";

const APPLICATION_ID = /^\d{17,20}$/;

export function defaultDesktopSettings() {
  return Object.freeze({
    discord: Object.freeze({ enabled: false, applicationId: "" }),
  });
}

export function desktopSettingsPath(dataDir = desktopDataDir()) {
  return path.join(dataDir, DESKTOP_SETTINGS_FILE);
}

export function normalizeDesktopSettings(value) {
  const discord = value && typeof value === "object" && value.discord && typeof value.discord === "object"
    ? value.discord : {};
  const enabled = discord.enabled === true;
  const applicationId = typeof discord.applicationId === "string" ? discord.applicationId.trim() : "";
  if (applicationId && !APPLICATION_ID.test(applicationId)) {
    throw new TypeError("Discord application id must be a numeric Developer Portal id.");
  }
  if (enabled && !applicationId) {
    throw new TypeError("Turn on Discord presence only after you enter an application id.");
  }
  return Object.freeze({
    discord: Object.freeze({ enabled, applicationId }),
  });
}

export async function readDesktopSettings(dataDir = desktopDataDir()) {
  try {
    const parsed = JSON.parse(await readFile(desktopSettingsPath(dataDir), "utf8"));
    return normalizeDesktopSettings(parsed);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return defaultDesktopSettings();
    }
    if (error instanceof TypeError) throw error;
    return defaultDesktopSettings();
  }
}

export async function writeDesktopSettings(next, dataDir = desktopDataDir()) {
  const settings = normalizeDesktopSettings(next);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const target = desktopSettingsPath(dataDir);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, target);
  return settings;
}
