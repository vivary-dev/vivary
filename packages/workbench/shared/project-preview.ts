import { z } from "zod";

const projectId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const requestId = z.string().uuid();
const script = z.enum(["dev", "start", "preview"]);
const previewUrl = z.string().url().max(2048);

export const projectPreviewInput = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("discover"), projectId }),
  z.strictObject({ operation: z.literal("inspect"), projectId, url: previewUrl }),
  z.strictObject({ operation: z.literal("review"), projectId, script, url: previewUrl }),
  z.strictObject({ operation: z.literal("start"), projectId, script, url: previewUrl,
    requestId, acceptedManifestDigest: digest, reviewExpiresAt: z.number().int().positive() }),
  z.strictObject({ operation: z.literal("status"), projectId }),
  z.strictObject({ operation: z.literal("stop"), projectId, launchId: z.string().uuid() }),
]);

const base = { projectId, host: z.string().min(1).max(255) };
const launch = {
  ...base,
  folder: z.string(),
  script,
  scriptText: z.string(),
  command: z.string(),
  launcher: z.string(),
  url: previewUrl,
  manifestDigest: digest,
  reviewExpiresAt: z.number().int().positive(),
  requestId,
  launchId: z.string().uuid(),
  pid: z.number().int().positive().nullable().describe(
    "Preview owner PID: the Python containment owner on Windows or package-manager process-group leader on POSIX."),
  processRunning: z.boolean().describe("Whether the preview owner process is running."),
  staleBinding: z.boolean(),
};

export const projectPreviewResult = z.discriminatedUnion("code", [
  z.strictObject({ code: z.literal("idle"), ...base }),
  z.strictObject({ code: z.literal("discovered"), ...base, folder: z.string(),
    scripts: z.array(z.strictObject({ script, scriptText: z.string() })).max(3) }),
  z.strictObject({ code: z.literal("checked"), ...base, url: previewUrl,
    reachable: z.boolean(), embedding: z.enum(["blocked", "unknown"]),
    reason: z.string().optional() }),
  z.strictObject({ code: z.literal("unsupported"), ...base, reason: z.string() }),
  z.strictObject({ code: z.literal("review"), ...base, folder: z.string(), script,
    scriptText: z.string(), command: z.string(), launcher: z.string(),
    url: previewUrl, manifestDigest: digest, reviewExpiresAt: z.number().int().positive() }),
  z.strictObject({ code: z.literal("starting"), ...launch }),
  z.strictObject({ code: z.literal("ready"), ...launch,
    checkedAt: z.string(), embedding: z.enum(["blocked", "unknown"]) }),
  z.strictObject({ code: z.literal("unavailable"), ...launch,
    reason: z.string(), logTail: z.string().max(4096).optional() }),
  z.strictObject({ code: z.literal("stopped"), ...launch }),
]);

export type ProjectPreviewInput = z.infer<typeof projectPreviewInput>;
export type ProjectPreviewResult = z.infer<typeof projectPreviewResult>;
export type ProjectPreviewScript = z.infer<typeof script>;
