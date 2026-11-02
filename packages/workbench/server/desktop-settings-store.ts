import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const APPLICATION_ID = /^\d{17,20}$/;

const settingsSchema = z.strictObject({
  discord: z.strictObject({
    enabled: z.boolean(),
    applicationId: z.string().max(20),
  }),
});

export type DesktopSettings = z.infer<typeof settingsSchema>;

export const DESKTOP_SETTINGS_FILE = "desktop-settings.json";

export function desktopSettingsPath(dataDir = process.env.VIVARY_DATA_DIR) {
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
    throw new TypeError("Desktop settings require an absolute data directory.");
  }
  return path.join(dataDir, DESKTOP_SETTINGS_FILE);
}

export function normalizeDesktopSettings(value: unknown): DesktopSettings {
  const parsed = settingsSchema.safeParse(value);
  const discord = parsed.success ? parsed.data.discord : { enabled: false, applicationId: "" };
  const applicationId = discord.applicationId.trim();
  if (applicationId && !APPLICATION_ID.test(applicationId)) {
    throw new TypeError("Discord application id must be a numeric Developer Portal id.");
  }
  if (discord.enabled && !applicationId) {
    throw new TypeError("Turn on Discord presence only after you enter an application id.");
  }
  return Object.freeze({
    discord: Object.freeze({ enabled: discord.enabled, applicationId }),
  });
}

export function defaultDesktopSettings(): DesktopSettings {
  return normalizeDesktopSettings({ discord: { enabled: false, applicationId: "" } });
}

export async function readDesktopSettings(dataDir = process.env.VIVARY_DATA_DIR): Promise<DesktopSettings> {
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

export async function writeDesktopSettings(next: unknown, dataDir = process.env.VIVARY_DATA_DIR): Promise<DesktopSettings> {
  const settings = normalizeDesktopSettings(next);
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
    throw new TypeError("Desktop settings require an absolute data directory.");
  }
  const target = desktopSettingsPath(dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, target);
  return settings;
}
