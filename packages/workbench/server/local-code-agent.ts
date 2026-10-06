import { getCodePermissionMode, type CodePermissionMode } from "./code-permissions";
import { readCodeTranscriptWindow } from "./code-transcript-page";
import { codexApprovalResponse, supportsCodexRequest, type CodexApprovalDecision } from "./codex-approval";
import type { CodexActionRequest } from "./code-execution-protocol";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { fail, type ActionRunContext } from "@agent-native/core/action";
import {
  appendCodeAgentTranscriptEvent,
  codeAgentRunTranscriptPath,
  createCodeAgentRunRecord,
  getCodeAgentRunRecord,
  isActiveCodeAgentRun,
  listCodeAgentRunRecords,
  listCodeAgentTranscriptEvents,
  readClaudeCodeSessionLog,
  updateCodeAgentRunRecord,
  type CodeAgentRunRecord,
  type CodeAgentTranscriptEvent,
} from "@agent-native/core/code-agents";

import { getCodexModels, type CodexModelCatalog } from "./codex-models";
import { projectReconnectionPending } from "./project-reconnection-admission.mjs";

import {
  WINDOWS_SCAN_FAILURES, type WindowsScanFailure,
  BOOT_ID_PATTERN, checkWorkerCleanup, endWorkerLeftovers, executeVivaryCodeWorker, isTraced, VivaryCodeWorkerCleanupError,
  type CleanupCheck, type CleanupFailure, type CleanupTarget, type EndAttempt, type EndOutcome, type LeftoverProcess,
} from "./code-execution-host";
import { redactCredentialsInValue, refreshHeldCredentials } from "./credential-redaction.ts";
import type { ProjectContextBlock, ProjectContextLoad } from "./project-memory.ts";
import { getVivaryRuntimeStatus, type VivaryCodeEngine, type VivaryRuntimeStatus } from "./local-runtime-setup.ts";

export const VIVARY_CODE_ENGINES = ["claude-cli", "codex-cli"] satisfies [VivaryCodeEngine, ...VivaryCodeEngine[]];
export const VIVARY_CODE_DEFAULT_ENGINE: VivaryCodeEngine = "claude-cli";

const VIVARY_CODE_GOAL_ID = "vivary-local-code";
const VIVARY_CODE_APP_MARKER = "vivary-workbench-local-code";
export type VivaryCodeModel = "sonnet" | "opus" | "fable";
export const VIVARY_CODE_MODELS = [
  "sonnet",
  "opus",
  "fable",
] satisfies [VivaryCodeModel, ...VivaryCodeModel[]];
export const VIVARY_CODE_DEFAULT_MODEL: VivaryCodeModel = "sonnet";
const MAX_RUNS = 20;
const MAX_TRANSCRIPT_EVENTS = 400;
const MAX_FOLLOW_UP_EVENTS = 24;
const MAX_FOLLOW_UP_CONTEXT_CHARS = 12_000;
const MAX_FOLLOW_UP_EVENT_CHARS = 3_000;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_LISTED_FILES = 200;
const MAX_SCANNED_ENTRIES = 2_000;
const MAX_SCAN_DEPTH = 6;
const SHUTDOWN_WAIT_MS = 10_000;
const ALLOWED_FILE_EXTENSIONS = new Set([".json", ".md", ".txt"]);
const MAX_CLEANUP_LISTED = 50;
const MAX_CLEANUP_NAMED_IN_MESSAGES = 5;
const MAX_CLEANUP_ENDS = 20;

type ActiveRun = {
  controller: AbortController;
  ownerEmail: string;
  orgId?: string;
  execution: Promise<void> | null;
  stopReason: "shutdown" | "user" | null;
  workspace: VivaryCodeWorkspace;
  permissionMode: CodePermissionMode;
  requests: Map<string, { request: CodexActionRequest; resolve: (response: Record<string, unknown>) => void }>;
};

export type VivaryCodeRunSummary = Pick<
  CodeAgentRunRecord,
  "id" | "status" | "phase" | "title" | "updatedAt"
> & {
  engine: VivaryCodeEngine;
  engineLabel: string;
  model: string;
  draftThreadId: string | null;
};

export type VivaryCodeRunState = VivaryCodeRunSummary & {
  events: CodeAgentTranscriptEvent[];
};

export type VivaryCodeProjectHistory = Readonly<{
  label: string;
  projectId: string;
  bindingId: string;
  rootId: string;
  bindingRevision: number;
}>;

export type VivaryCodeWorkspace = Readonly<{
  root: string;
  label: string;
  projectId?: string;
  bindingId?: string;
  rootId?: string;
  bindingRevision?: number;
  policyRevision?: number;
}>;

export type VivaryCodeReadScope = VivaryCodeProjectHistory | VivaryCodeWorkspace
  | Readonly<{ kind: "unassigned"; label: string; projectId?: never }>;

export type VivaryCodePendingApproval = CodexActionRequest & {
  runId: string;
  title: string;
  projectId: string | null;
  workspaceLabel: string;
};

export type VivaryCodeRecentRun = Pick<CodeAgentRunRecord, "id" | "status" | "title" | "phase"> & {
  projectId: string | null;
};

/** Issue #121. The refusal's state for the host strip and the Code panel. The server owns the wording. */
export type VivaryCodeCleanupView = {
  /** Names the list shown here. A decision carries it back, so it acts only on what the owner saw. */
  version: string;
  heading: string;
  /** Commands appear in backticks. */
  instruction: string;
  /** `confirmed` means Vivary traced the process to the run, so End them may end it. */
  remaining: { pid: number; name: string; confirmed: boolean }[];
  /** How many more processes the last check found than `remaining` lists. */
  unlisted: number;
  /** A scan can find the listed processes, and at least one is confirmed, so End them can act. */
  canEnd: boolean;
  /** End them has run on this refusal, or cannot act, so the owner may continue past what is left. */
  canContinue: boolean;
  /** What the last End them on this refusal did, or null before any. */
  notice: string | null;
  /** The Code composer's placeholder while the refusal holds. */
  composer: string;
  /** A check or an End is running. */
  checking: boolean;
  /** Set only for the run's owner. */
  run: { id: string; title: string; projectId: string | null } | null;
};

export type VivaryCodeHostState = {
  activeRun: { id: string; title: string; projectId: string | null } | null;
  pendingApproval: VivaryCodePendingApproval | null;
  recentRun: VivaryCodeRecentRun | null;
  busy: boolean;
  cleanup: VivaryCodeCleanupView | null;
};

export type VivaryCodeState = VivaryCodeHostState & {
  projectId: string | null;
  workspaceLabel: string;
  engineLabel: string;
  models: readonly VivaryCodeModel[];
  defaultModel: VivaryCodeModel;
  defaultEngine: VivaryCodeEngine;
  runtime: VivaryRuntimeStatus;
  permissionMode: CodePermissionMode;
  engines: { engine: VivaryCodeEngine; label: string; models: string[]; configured: boolean; runtime: VivaryRuntimeStatus; modelCatalog: CodexModelCatalog | null }[];
  runs: VivaryCodeRunSummary[];
  run: VivaryCodeRunState | null;
  error?: string;
};

export type VivaryCodeFileSummary = {
  path: string;
  name: string;
  sizeBytes: number;
  updatedAt: string;
};

export type VivaryCodeFileState = {
  workspaceLabel: string;
  files: VivaryCodeFileSummary[];
  file: (VivaryCodeFileSummary & { content: string }) | null;
  truncated: boolean;
};

type CleanupScan = "done" | "unavailable" | "not-recorded";

/**
 * Issue #121. Coding processes from a run outlived its stop, or Vivary could not confirm that they did not, so the host
 * refuses new runs. The run record keeps it as `metadata.cleanupRefusal`, without `runId`.
 */
export type CleanupRefusal = {
  runId: string;
  /** Null when the run predates recorded targets, or on a platform Vivary cannot check. */
  target: CleanupTarget | null;
  /** The processes last observed, at most `MAX_CLEANUP_LISTED`. */
  remaining: LeftoverProcess[];
  /** How many processes that observation found, listed or not. */
  total: number;
  /**
   * Names every process that observation found and whether one was hidden, from `leftoverFingerprint`. Null until a
   * check lists processes for the refusal.
   */
  fingerprint: string | null;
  hidden: boolean;
  /** Whether the last check could scan. `not-recorded` is a marker that never had a target. */
  scan: CleanupScan;
  scanFailure?: WindowsScanFailure;
  step: CleanupFailure["step"] | null;
  refusedAt: string;
  checkedAt: string;
  /** Each End them on this refusal, oldest first. */
  ends: CleanupEnd[];
};

/** One End them: who chose it, when, and what it did to each process it tried. */
type CleanupEnd = { at: string; by: string; attempts: EndAttempt[] };

/**
 * How a refusal ended, kept as `metadata.cleanupLifted` on the run. Continue anyway records the list the owner was
 * shown, and what the check right before it found: `scan` says whether that check ran, and `remaining` lists at most
 * `MAX_CLEANUP_LISTED` of the `total` processes it found.
 */
type CleanupLift = { ends: CleanupEnd[] } & (
  | { how: "rechecked"; checkedAt: string }
  | { how: "ended"; endedAt: string; by: string }
  | { how: "owner-confirmed"; confirmedAt: string; by: string; shown: LeftoverProcess[]; hidden: boolean;
    scan: CleanupScan; remaining: LeftoverProcess[]; total: number });

const tracedSchema = z.object({ pid: z.number().int().positive(), start: z.number().int().nonnegative() });
// A Linux `comm` can be empty, so an empty name must not discard the whole refusal.
const leftoverSchema = tracedSchema.extend({ name: z.string().max(260) });
const storedCleanupRefusalSchema = z.object({
  // A boot id that is not a UUID fails to parse, so a damaged one refuses rather than reading as a reboot.
  target: z.discriminatedUnion("platform", [
    z.object({ platform: z.literal("linux"), groupId: z.number().int().positive(),
      bootId: z.string().regex(BOOT_ID_PATTERN).nullable(), traced: z.array(tracedSchema).max(200).default([]) }),
    z.object({ platform: z.literal("win32"), tracked: z.array(z.object({
      pid: z.number().int().positive(), createdFrom: z.number(), createdTo: z.number(), childrenTo: z.number().nullable(),
    })).min(1).max(200), traced: z.array(tracedSchema).max(200).default([]),
      overflow: z.literal(true).optional() }),
  ]).nullable(),
  remaining: z.array(leftoverSchema).max(MAX_CLEANUP_LISTED),
  total: z.number().int().nonnegative().optional(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  hidden: z.boolean(),
  scan: z.enum(["done", "unavailable", "not-recorded"]),
  scanFailure: z.enum(WINDOWS_SCAN_FAILURES).optional(),
  step: z.enum(["taskkill", "exit", "group", "worker-exited"]).nullable(),
  refusedAt: z.string(),
  checkedAt: z.string(),
  ends: z.array(z.object({ at: z.string(), by: z.string(), attempts: z.array(leftoverSchema.extend({
    outcome: z.enum(["ended", "mismatched", "gone", "failed", "unknown"]),
  })).max(MAX_CLEANUP_LISTED) })).max(MAX_CLEANUP_ENDS).default([]),
  // A refusal written without a count counts what it lists.
}).transform(stored => ({ ...stored, total: stored.total ?? stored.remaining.length }));

type CodeHostState = {
  activeRuns: Map<string, ActiveRun>;
  initialization: Promise<void> | null;
  /** Shutdown only. */
  closing: boolean;
  shutdown: Promise<void> | null;
  /** The oldest refusal still in force. */
  cleanup: CleanupRefusal | null;
  /** One check or End at a time. Never rejects. */
  cleanupCheck: Promise<void> | null;
  /** Refusals whose last write failed, by run. They stay in force from memory until a write succeeds or they lift. */
  unsaved: Map<string, CleanupRefusal>;
};

// Nitro bundles plugins while Native loads action source modules. Both must own
// the same process-local controllers so shutdown can stop runs started by actions.
const codeHostKey = Symbol.for("vivary.workbench.code-host");
const hostProcess = globalThis as typeof globalThis & {
  [codeHostKey]?: CodeHostState;
};
const hostState = hostProcess[codeHostKey] ??= {
  activeRuns: new Map<string, ActiveRun>(),
  initialization: null,
  closing: false,
  shutdown: null,
  cleanup: null,
  cleanupCheck: null,
  unsaved: new Map<string, CleanupRefusal>(),
};
const activeRuns = hostState.activeRuns;
export async function initializeVivaryCodeAgent(): Promise<void> {
  await resolveWorkspace();
  await ensureVivaryCodeHostInitialized();
}

export function shutdownVivaryCodeAgent(): Promise<void> {
  hostState.shutdown ??= stopActiveRunsForShutdown();
  return hostState.shutdown;
}

async function ensureVivaryCodeHostInitialized(): Promise<void> {
  // Production uses one supervised Node process, so persisted active records here
  // can only be leftovers from a prior host process.
  hostState.initialization ??= Promise.resolve().then(() => {
    for (const run of listCodeAgentRunRecords(VIVARY_CODE_GOAL_ID)) {
      if (metadataString(run, "app") !== VIVARY_CODE_APP_MARKER) continue;
      if (!isActiveCodeAgentRun(run)) continue;
      appendCodeAgentTranscriptEvent({
        runId: run.id,
        kind: "status",
        message: "The previous Vivary code host ended before this run finished.",
        metadata: {
          status: "paused",
          phase: "interrupted",
          reason: "host-restart",
        },
      });
      updateCodeAgentRunRecord(run.id, {
        status: "paused",
        phase: "interrupted",
        needsApproval: false,
        metadata: { pendingLaunch: undefined },
        progress: {
          label: "Interrupted",
          completed: 0,
          total: 1,
          failed: 0,
          percent: 0,
        },
      });
    }
    // Issue #121. The oldest persisted refusal is in force before any send. The check that may lift it runs behind it.
    reloadCleanup();
    if (hostState.cleanup) void recheckVivaryCodeCleanup().catch(() => undefined);
  });
  await hostState.initialization;
}

/** Issue #121. Checks every persisted refusal again, after any check or End already running. */
export function recheckVivaryCodeCleanup(): Promise<void> {
  return exclusiveCleanupWork(async () => {
    for (const refusal of settledCleanupRefusals()) {
      if (refusal.target) recordCleanupCheck(refusal, await checkWorkerCleanup(refusal.target));
    }
  });
}

/**
 * Issue #121. The owner's decision on the refusal the host strip shows, the oldest one, and only on the version of its
 * list the owner saw. End them ends each listed process it can, and lifts the refusal when the check after that is
 * empty. Continue anyway lifts it on the owner's word after one more check, which lifts it on its own when nothing is
 * left, and which must find exactly the processes the owner was told of.
 */
export async function resolveVivaryCodeCleanup(input: {
  ownerEmail: string; orgId?: string; decision: "end" | "continue"; version: string;
}): Promise<VivaryCodeHostState> {
  await ensureVivaryCodeHostInitialized();
  const outcome = await exclusiveCleanupWork(async (): Promise<"done" | "changed" | "not-offered"> => {
    const refusal = settledCleanupRefusals()[0];
    if (!refusal) return "done";
    if (cleanupVersion(refusal) !== input.version) return "changed";
    const offers = cleanupOffers(refusal);
    if (input.decision === "continue") return offers.canContinue ? continueAnyway(refusal, input.ownerEmail) : "not-offered";
    if (!offers.canEnd || !refusal.target) return "not-offered";
    const { attempts, check } = await endWorkerLeftovers(refusal.target, refusal.remaining);
    const end: CleanupEnd = { at: new Date().toISOString(), by: input.ownerEmail, attempts };
    const ended = attemptsWith([end], "ended");
    // The credential redaction plugin redacts server output. Process names stay out of the log.
    console.error(`[vivary-code-host] cleanup-end run=${refusal.runId} tried=${attempts.length} ended=${ended.length} `
      + `unknown=${attemptsWith([end], "unknown").length} result=${check.result}`);
    const recorded = { ...refusal, ends: [...refusal.ends, end].slice(-MAX_CLEANUP_ENDS) };
    if (check.result === "clean" && ended.length) {
      liftCleanupRefusal(recorded, { how: "ended", endedAt: end.at, by: input.ownerEmail, ends: recorded.ends });
    } else {
      recordCleanupCheck(recorded, check);
    }
    return "done";
  });
  if (outcome === "changed") {
    fail("The list of leftover coding processes changed. Review it again before you choose.", {
      errorCode: "vivary_code_cleanup_changed", statusCode: 409,
    });
  }
  if (outcome === "not-offered") {
    fail(input.decision === "continue"
      ? "Choose End them first. Continue anyway is offered when End them cannot end everything."
      : "End them cannot act on this list. Choose Continue anyway.", {
      errorCode: "vivary_code_cleanup_not_offered", statusCode: 409,
    });
  }
  return getVivaryCodeHostState(input.ownerEmail, input.orgId);
}

/**
 * What the strip offers. End them when a listed process may be ended. Continue anyway once End them has run on this
 * refusal, or when End them cannot act, so the owner tries End them first whenever it can help.
 */
function cleanupOffers(refusal: CleanupRefusal): { canEnd: boolean; canContinue: boolean } {
  const canEnd = refusal.scan === "done" && refusal.remaining.some(leftover => confirmedFromRun(refusal, leftover));
  return { canEnd, canContinue: !canEnd || refusal.ends.length > 0 };
}

/**
 * Whether Vivary traced a listed process to the run, so End them may end it. A process linked only through an exited
 * parent or a reused group id could belong to another program.
 */
function confirmedFromRun(refusal: CleanupRefusal, leftover: LeftoverProcess): boolean {
  return refusal.target !== null && leftover.pid !== process.pid && isTraced(refusal.target.traced, leftover);
}

/** Every process these End them runs gave this outcome. */
function attemptsWith(ends: readonly CleanupEnd[], outcome: EndOutcome): LeftoverProcess[] {
  return ends.flatMap(({ attempts }) => attempts.filter(attempt => attempt.outcome === outcome)
    .map(({ pid, name, start }) => ({ pid, name, start })));
}

/** Names the processes End them was sent but could not report on, or is empty when there are none. */
function unreadNote(ends: readonly CleanupEnd[]): string {
  const unknown = attemptsWith(ends, "unknown");
  return unknown.length ? `Vivary could not read what End them did to ${processList(unknown)}.` : "";
}

/**
 * Continue anyway, after one more check. A clean check lifts the refusal as rechecked. A check whose processes differ
 * from those the owner was told of, listed or not, records them and lifts nothing, so the strip shows them and offers
 * End them when it can.
 */
async function continueAnyway(refusal: CleanupRefusal, by: string): Promise<"done" | "changed"> {
  const check = refusal.target ? await checkWorkerCleanup(refusal.target) : null;
  if (check?.result === "clean") {
    recordCleanupCheck(refusal, check);
    return "done";
  }
  if (check?.result === "remaining" && leftoverFingerprint(check.remaining, check.hidden) !== refusal.fingerprint) {
    recordCleanupCheck(refusal, check);
    return "changed";
  }
  const found = check?.result === "remaining" ? check.remaining : [];
  liftCleanupRefusal(refusal, {
    how: "owner-confirmed", confirmedAt: new Date().toISOString(), by, shown: refusal.remaining,
    hidden: refusal.hidden, scan: !check ? refusal.scan : check.result === "remaining" ? "done" : "unavailable",
    remaining: found.slice(0, MAX_CLEANUP_LISTED), total: found.length, ends: refusal.ends,
  });
  return "done";
}

/**
 * Names every process a check found, however many a refusal lists, by PID and start time, and whether the check found
 * a hidden one. The same processes give the same fingerprint in any order.
 */
function leftoverFingerprint(found: readonly LeftoverProcess[], hidden: boolean): string {
  const processes = found.map(({ pid, start }) => `${pid}:${start}`).sort();
  return createHash("sha256").update(JSON.stringify([hidden, processes])).digest("hex");
}

/**
 * Names what the strip shows: the run, when it was refused, what the last check could do and found, listed or not, and
 * how many End them ran. A later check that finds the same processes keeps it.
 */
function cleanupVersion(refusal: CleanupRefusal): string {
  return createHash("sha256").update(JSON.stringify([refusal.runId, refusal.refusedAt, refusal.scan, refusal.hidden,
    refusal.remaining.map(({ pid, start, name }) => [pid, start, name]), refusal.fingerprint, refusal.ends.length]))
    .digest("hex").slice(0, 16);
}

/** Runs one piece of cleanup work after any other, then reloads the refusal in force. */
function exclusiveCleanupWork<T>(work: () => Promise<T>): Promise<T> {
  const run = (hostState.cleanupCheck ?? Promise.resolve()).then(work).finally(reloadCleanup);
  const settled: Promise<void> = run.then(() => undefined, error => {
    console.error(`[vivary-code-host] cleanup-check-failed ${error instanceof Error ? error.name : "unknown"}`);
  }).finally(() => {
    if (hostState.cleanupCheck === settled) hostState.cleanupCheck = null;
  });
  hostState.cleanupCheck = settled;
  return run;
}

/**
 * Every refusal in force for this app's runs, oldest first: each run record's, or the one in memory when its last write
 * failed.
 */
function cleanupRefusalsInForce(): CleanupRefusal[] {
  const refusals = new Map<string, CleanupRefusal>();
  for (const run of listCodeAgentRunRecords(VIVARY_CODE_GOAL_ID)) {
    if (metadataString(run, "app") !== VIVARY_CODE_APP_MARKER) continue;
    const refusal = cleanupRefusalFromRun(run);
    if (refusal) refusals.set(run.id, refusal);
  }
  for (const [runId, refusal] of hostState.unsaved) refusals.set(runId, refusal);
  return [...refusals.values()].sort((left, right) => left.refusedAt.localeCompare(right.refusedAt));
}

/** The refusals a check or a decision acts on. A run still stopping takes its own check first. */
function settledCleanupRefusals(): CleanupRefusal[] {
  return cleanupRefusalsInForce().filter(refusal => !stopStillChecking(refusal));
}

/** Whether the refusal's run is still stopping, so the check right after its failed stop has not ended. */
function stopStillChecking(refusal: CleanupRefusal): boolean {
  return activeRuns.has(refusal.runId);
}

function reloadCleanup(): void {
  hostState.cleanup = cleanupRefusalsInForce()[0] ?? null;
}

/** Parses a run's refusal once, at the record boundary. A marker it cannot read still refuses. */
function cleanupRefusalFromRun(run: CodeAgentRunRecord): CleanupRefusal | null {
  const stored = run.metadata?.cleanupRefusal;
  if (stored === undefined && run.metadata?.cleanupUnverified !== true) return null;
  const parsed = storedCleanupRefusalSchema.safeParse(stored);
  if (parsed.success) return { runId: run.id, ...parsed.data };
  // A `cleanupUnverified: true` marker from before part B recorded no target.
  return { runId: run.id, target: null, remaining: [], total: 0, fingerprint: null, hidden: false, scan: "not-recorded",
    step: null, refusedAt: run.updatedAt, checkedAt: run.updatedAt, ends: [] };
}

function storedCleanupRefusal(refusal: CleanupRefusal): Omit<CleanupRefusal, "runId"> {
  const { target, remaining, total, fingerprint, hidden, scan, scanFailure, step, refusedAt, checkedAt, ends } = refusal;
  return { target, remaining, total, fingerprint, hidden, scan, ...(scanFailure ? { scanFailure } : {}), step, refusedAt, checkedAt, ends };
}

/** What a refusal records from a check that found processes. It lists at most `MAX_CLEANUP_LISTED` and counts them all. */
function listedFromCheck(check: Extract<CleanupCheck, { result: "remaining" }>) {
  return { target: check.target, remaining: check.remaining.slice(0, MAX_CLEANUP_LISTED), total: check.remaining.length,
    fingerprint: leftoverFingerprint(check.remaining, check.hidden), hidden: check.hidden, scan: "done" as const, scanFailure: undefined };
}

/** Records one check of a refusal. A check keeps the run's place in history, and only a lift adds to its transcript. */
function recordCleanupCheck(refusal: CleanupRefusal, check: CleanupCheck): void {
  const checkedAt = new Date().toISOString();
  if (check.result === "clean") {
    liftCleanupRefusal(refusal, { how: "rechecked", checkedAt, ends: refusal.ends });
    return;
  }
  writeCleanupRefusal(check.result === "remaining" ? { ...refusal, ...listedFromCheck(check), checkedAt }
    : { ...refusal, scan: "unavailable", scanFailure: check.reason, checkedAt });
}

/**
 * Writes a refusal to its run and puts it in force. A write keeps the run's place in history unless it also records the
 * run's failure. When the write fails, the refusal stays in force from memory and the next write retries it, so a
 * failed write never lifts it.
 */
function writeCleanupRefusal(refusal: CleanupRefusal, failure?: { executionError: string }): void {
  try {
    const written = updateCodeAgentRunRecord(refusal.runId, record => ({
      ...(failure ? { status: "errored" as const, phase: "cleanup-unverified" as const } : { updatedAt: record.updatedAt }),
      metadata: { cleanupRefusal: storedCleanupRefusal(refusal), ...failure },
    }));
    if (!written) throw new Error("The run record is missing.");
    hostState.unsaved.delete(refusal.runId);
  } catch (error) {
    hostState.unsaved.set(refusal.runId, refusal);
    logCleanupRecordFailure(refusal.runId, error);
  }
  reloadCleanup();
}

function logCleanupRecordFailure(runId: string, error: unknown): void {
  // The credential redaction plugin redacts server output. The log names the error kind only.
  console.error(`[vivary-code-host] cleanup-record-failed run=${runId} ${error instanceof Error ? error.name : "unknown"}`);
}

/** Takes a failed stop's early refusal off when the check after it found nothing left, so the stop did finish. */
function clearStopRefusal(runId: string): void {
  hostState.unsaved.delete(runId);
  // A clear that fails leaves the refusal on the record, and the next check lifts it.
  try { updateCodeAgentRunRecord(runId, { metadata: { cleanupRefusal: undefined } }); }
  catch (error) { logCleanupRecordFailure(runId, error); }
  reloadCleanup();
}

function liftCleanupRefusal(refusal: CleanupRefusal, lift: CleanupLift): void {
  const remaining = lift.how === "owner-confirmed" ? lift.remaining.length : 0;
  const scan = lift.how === "owner-confirmed" ? lift.scan : "done";
  // The credential redaction plugin redacts server output. Process names stay out of the log.
  console.error(`[vivary-code-host] cleanup-lifted run=${refusal.runId} how=${lift.how} scan=${scan} remaining=${remaining}`);
  try {
    // Another refusal in force still refuses every send.
    const othersInForce = cleanupRefusalsInForce().some(other => other.runId !== refusal.runId);
    appendCodeAgentTranscriptEvent({ runId: refusal.runId, kind: "status",
      message: cleanupLiftMessage(lift, refusal, othersInForce), metadata: { phase: "cleanup-lifted", how: lift.how } });
    const recorded = updateCodeAgentRunRecord(refusal.runId, {
      metadata: { cleanupRefusal: undefined, cleanupUnverified: undefined, cleanupLifted: lift },
    });
    if (!recorded) throw new Error("The run record is missing.");
  } catch (error) {
    // The refusal stays in force from memory, with any End them it now holds, until its run records the lift.
    hostState.unsaved.set(refusal.runId, refusal);
    throw error;
  }
  hostState.unsaved.delete(refusal.runId);
}

/** The refusal a failed stop leaves, from the one check the host took right after it. */
function cleanupRefusalFromFailedStop(runId: string, error: VivaryCodeWorkerCleanupError,
  refusedAt: string | null): CleanupRefusal {
  const now = new Date().toISOString();
  const check = error.leftovers?.check;
  const common = { runId, step: error.cause?.step ?? null, refusedAt: refusedAt ?? now, checkedAt: now, ends: [] };
  return check?.result === "remaining" ? { ...common, ...listedFromCheck(check) }
    : { ...common, target: error.leftovers?.target ?? null, remaining: [], total: 0, fingerprint: null, hidden: false,
      scan: "unavailable", ...(check?.reason ? { scanFailure: check.reason } : {}) };
}

function cleanupPlatform(refusal: CleanupRefusal): "linux" | "win32" {
  return refusal.target?.platform ?? (process.platform === "win32" ? "win32" : "linux");
}

/**
 * Names processes by name and PID, and counts the rest of `total`, which exceeds the processes given when their list was
 * cut. With a refusal, it marks each one Vivary could not trace to the run.
 */
function processList(processes: readonly LeftoverProcess[], refusal?: CleanupRefusal, total = processes.length): string {
  const named = processes.slice(0, MAX_CLEANUP_NAMED_IN_MESSAGES).map(leftover => `${leftover.name} (PID ${leftover.pid}`
    + `${!refusal || confirmedFromRun(refusal, leftover) ? "" : ", not confirmed from that run"})`);
  const more = total - named.length;
  return more > 0 ? `${named.join(", ")}, and ${more} more` : named.join(", ");
}

/** The heading while the check right after a failed stop runs. */
const STOP_CHECK_HEADING = "Vivary is checking whether coding processes stopped";

function cleanupHeading(refusal: CleanupRefusal): string {
  if (refusal.scan !== "done") return "Vivary could not confirm that an earlier run's coding processes stopped";
  if (!refusal.remaining.length) return "A coding process from an earlier run is still running";
  return refusal.remaining.every(leftover => confirmedFromRun(refusal, leftover))
    ? "Coding processes from an earlier run are still running"
    : "Processes that may be left from an earlier run are still running";
}

/**
 * What the owner does next. The strip sits beside the controls, and a transcript or refusal message adds where they
 * are. Commands are in backticks.
 */
function cleanupInstruction(refusal: CleanupRefusal, where: "strip" | "message"): string {
  const at = where === "message" ? " at the top of Vivary" : "";
  const windows = cleanupPlatform(refusal) === "win32";
  const group = refusal.target?.platform === "linux" ? refusal.target.groupId : null;
  if (refusal.scan === "not-recorded") {
    return "This run ended before Vivary recorded which processes it started. End any codex, claude, or node processes "
      + `left from it ${windows ? "in Task Manager" : "in your process list"}, then choose Continue anyway${at}.`;
  }
  if (refusal.scan === "unavailable") {
    if (group !== null) {
      return `Vivary could not list the processes. Check them with \`pgrep -l -g ${group}\`, stop them with `
        + `\`kill -KILL -- -${group}\`, then choose Continue anyway${at}.`;
    }
    return `Vivary could not list the processes. Check ${windows ? "Task Manager" : "your process list"} for codex, `
      + `claude, or node processes from that run and end them, then choose Continue anyway${at}.`;
  }
  if (!refusal.remaining.length && group !== null) {
    return `Vivary cannot read its name. Stop process group ${group} with \`kill -KILL -- -${group}\`, which may need `
      + `sudo, then choose Continue anyway${at}. Vivary checks once more before it continues.`;
  }
  const yourself = group !== null ? `stop them with \`kill -KILL -- -${group}\``
    : `end them ${windows ? "in Task Manager" : "in your process list"} by PID`;
  // The list names only what the scan could read, as under `hidepid=1`.
  const unread = refusal.hidden && group !== null
    ? `Process group ${group} may also hold a process that Vivary cannot read or end. ` : "";
  const confirmed = refusal.remaining.filter(leftover => confirmedFromRun(refusal, leftover)).length;
  if (!confirmed) {
    return `${unread}Vivary cannot confirm that these came from that run, so it does not end them. `
      + `If they did, ${yourself}, then choose Continue anyway${at}.`;
  }
  const orContinue = cleanupOffers(refusal).canContinue ? ` Or choose Continue anyway${at}.` : "";
  if (confirmed === refusal.remaining.length) {
    return `${unread}Choose End them${at} to stop these processes. Vivary ends only listed processes it can confirm `
      + `came from that run, then checks again.${orContinue}`;
  }
  return `${unread}Choose End them${at} to stop the processes confirmed from that run, then Vivary checks again. It `
    + `does not end the others. If they came from that run, ${yourself}.${orContinue}`;
}

/** The refusal a send gets. */
function cleanupRefusalMessage(refusal: CleanupRefusal): string {
  if (stopStillChecking(refusal)) {
    return `${STOP_CHECK_HEADING}. The choices appear at the top of Vivary when the check ends.`;
  }
  const names = refusal.scan === "done" && refusal.remaining.length
    ? `: ${processList(refusal.remaining, refusal, refusal.total)}` : "";
  return `${cleanupHeading(refusal)}${names}. ${cleanupInstruction(refusal, "message")}`;
}

/** The transcript status when a stop fails. */
function cleanupFailureMessage(refusal: CleanupRefusal): string {
  const names = refusal.remaining.length
    ? `Still running: ${processList(refusal.remaining, refusal, refusal.total)}. ` : "";
  return `The coding process could not be stopped completely. ${names}${cleanupInstruction(refusal, "message")}`;
}

/** What the last End them did, in the strip's words. */
function cleanupNotice(refusal: CleanupRefusal): string | null {
  const last = refusal.ends.at(-1);
  if (!last) return null;
  const ended = attemptsWith([last], "ended");
  const failed = attemptsWith([last], "failed");
  const unread = unreadNote([last]);
  if (!ended.length && !failed.length && !unread) {
    return "End them ended nothing, because the listed processes had already exited or changed.";
  }
  return [ended.length ? `End them ended ${processList(ended)}.` : "",
    failed.length ? `Vivary could not end ${processList(failed)}.` : "", unread].filter(Boolean).join(" ");
}

/** The Code composer's placeholder, which names the choices the strip offers. */
function cleanupComposer(refusal: CleanupRefusal): string {
  const { canEnd, canContinue } = cleanupOffers(refusal);
  const choice = canEnd && canContinue ? "End them or Continue anyway" : canEnd ? "End them" : "Continue anyway";
  return `${cleanupHeading(refusal)}. Choose ${choice} above before sending another message.`;
}

/**
 * The transcript status when a refusal lifts. It marks any listed process Vivary did not trace to the run, and it says
 * that Vivary accepts new messages again only when no other refusal is in force.
 */
function cleanupLiftMessage(lift: CleanupLift, refusal: CleanupRefusal, othersInForce: boolean): string {
  const ended = attemptsWith(lift.ends, "ended");
  // What Vivary could not read about End them comes last in every lift, before what the lift means for new messages.
  const outcome = [unreadNote(lift.ends), othersInForce
    ? "This run no longer keeps Vivary from accepting new messages, but another run still does."
    : "Vivary accepts new messages again."].filter(Boolean).join(" ");
  if (lift.how === "ended") {
    return `You chose End them. Vivary ended ${processList(ended)} and found no coding processes left. ${outcome}`;
  }
  const endedNote = ended.length ? ` End them ended ${processList(ended)}.` : "";
  if (lift.how === "rechecked") return `The leftover coding processes are gone.${endedNote} ${outcome}`;
  if (lift.scan !== "done") {
    return `You chose to continue. Vivary could not check whether this run's coding processes stopped.${endedNote} `
      + outcome;
  }
  const which = lift.remaining.every(leftover => confirmedFromRun(refusal, leftover)) ? "these coding processes"
    : "these processes";
  return lift.remaining.length
    ? `You chose to continue while ${which} were still running: ${processList(lift.remaining, refusal, lift.total)}.`
      + `${endedNote} ${outcome}`
    : `You chose to continue while a coding process from this run was still running.${endedNote} ${outcome}`;
}

function cleanupView(refusal: CleanupRefusal, runs: readonly CodeAgentRunRecord[], ownerEmail: string,
  orgId?: string): VivaryCodeCleanupView {
  const run = runs.find(candidate => candidate.id === refusal.runId && isOwnedIdentity(candidate, ownerEmail, orgId));
  const shown = {
    version: cleanupVersion(refusal),
    remaining: refusal.remaining.map(leftover => ({ pid: leftover.pid, name: leftover.name,
      confirmed: confirmedFromRun(refusal, leftover) })),
    unlisted: refusal.total - refusal.remaining.length,
    notice: cleanupNotice(refusal),
    run: run ? { id: run.id, title: run.title, projectId: metadataString(run, "projectId") } : null,
  };
  // The check right after the failed stop decides what is left, so nothing is offered until it ends.
  if (stopStillChecking(refusal)) {
    return { ...shown, heading: STOP_CHECK_HEADING, instruction: "The choices appear here when the check ends.",
      canEnd: false, canContinue: false, checking: true,
      composer: `${STOP_CHECK_HEADING}. Wait for the check to end before sending another message.` };
  }
  return { ...shown, heading: cleanupHeading(refusal), instruction: cleanupInstruction(refusal, "strip"),
    ...cleanupOffers(refusal), composer: cleanupComposer(refusal), checking: hostState.cleanupCheck !== null };
}

async function stopActiveRunsForShutdown(): Promise<void> {
  hostState.closing = true;
  const executions: Promise<void>[] = [];
  for (const [runId, activeRun] of activeRuns) {
    if (activeRun.stopReason === null) {
      activeRun.stopReason = "shutdown";
      try {
        recordStoppingRun(
          runId,
          "The Vivary code host is shutting down.",
          "shutdown",
        );
      } finally {
        activeRun.controller.abort();
      }
    }
    if (activeRun.execution) executions.push(activeRun.execution);
  }
  if (executions.length === 0) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
  });
  try {
    await Promise.race([Promise.allSettled(executions), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}


export function requireVivaryCodeUser(ctx?: ActionRunContext): string {
  const userEmail = ctx?.userEmail?.trim().toLowerCase();
  if (!userEmail) {
    fail("Vivary could not confirm access to this local workspace. Reload the app.", {
      errorCode: "vivary_code_auth_required",
      statusCode: 401,
    });
  }
  return userEmail;
}

export async function getVivaryCodeHostState(
  ownerEmail: string,
  orgId?: string,
): Promise<VivaryCodeHostState> {
  await ensureVivaryCodeHostInitialized();
  return readVivaryCodeHostState(ownerEmail, orgId);
}

function readVivaryCodeHostState(ownerEmail: string, orgId?: string): VivaryCodeHostState {
  const runs = listCodeAgentRunRecords(VIVARY_CODE_GOAL_ID);
  const owned = runs.filter(run => isOwnedIdentity(run, ownerEmail, orgId));
  const active = owned.find(run => activeRuns.has(run.id));
  const pending = active ? activeRuns.get(active.id)?.requests.values().next().value?.request : undefined;
  const recent = owned.find(run => !activeRuns.has(run.id));
  return {
    activeRun: active ? { id: active.id, title: active.title, projectId: metadataString(active, "projectId") } : null,
    // The card shows a redacted copy. The stored request stays as Codex sent it, so the answer matches it.
    pendingApproval: pending && active ? { ...redactCredentialsInValue(pending), runId: active.id, title: active.title, projectId: metadataString(active, "projectId"), workspaceLabel: activeRuns.get(active.id)!.workspace.label } : null,
    recentRun: recent ? {
      id: recent.id,
      title: recent.title,
      status: recent.status,
      phase: recent.phase,
      projectId: metadataString(recent, "projectId"),
    } : null,
    busy: activeRuns.size > 0,
    // Every user of the host sees the refusal, because it refuses them all.
    cleanup: hostState.cleanup ? cleanupView(hostState.cleanup, runs, ownerEmail, orgId) : null,
  };
}

export function linkedCodeDraftRuns(ownerEmail: string, orgId: string, scope: VivaryCodeReadScope | undefined,
  draftThreadIds: readonly string[]): Map<string, Pick<VivaryCodeRunSummary, "id" | "title" | "updatedAt" | "engineLabel">> {
  const wanted = new Set(draftThreadIds);
  const linked = new Map<string, Pick<VivaryCodeRunSummary, "id" | "title" | "updatedAt" | "engineLabel">>();
  if (wanted.size === 0) return linked;
  const runs = listCodeAgentRunRecords(VIVARY_CODE_GOAL_ID);
  for (const run of runs) {
    if (scope ? !isOwnedRun(run, ownerEmail, orgId, scope)
      : !isOwnedIdentity(run, ownerEmail, orgId) || metadataString(run, "projectId") !== null) continue;
    const draftThreadId = runDraftThreadId(run);
    if (!draftThreadId || !wanted.has(draftThreadId) || linked.has(draftThreadId)) continue;
    linked.set(draftThreadId, { id: run.id, title: run.title, updatedAt: run.updatedAt,
      engineLabel: engineLabelFromRun(run) });
    if (linked.size === wanted.size) break;
  }
  return linked;
}

export function hasOwnedVivaryCodeSubmit(
  ownerEmail: string, orgId: string | undefined, scope: VivaryCodeReadScope | undefined,
  draftThreadId: string, submitId: string,
): boolean {
  const runs = listCodeAgentRunRecords(VIVARY_CODE_GOAL_ID).filter(run =>
    scope ? isOwnedRun(run, ownerEmail, orgId, scope)
      : isOwnedIdentity(run, ownerEmail, orgId) && metadataString(run, "projectId") === null);
  return runs.some(run => listCodeAgentTranscriptEvents(run.id).some(event =>
    event.kind === "user" && event.metadata?.draftThreadId === draftThreadId
      && event.metadata?.draftSubmitId === submitId));
}

export async function getVivaryCodeState(
  ownerEmail: string,
  runId?: string,
  selectedWorkspace?: VivaryCodeReadScope,
  orgId?: string,
  modelDiscoveryRoot?: string,
  anchor?: { eventId: string; eventOffset: number },
): Promise<VivaryCodeState> {
  const workspace = selectedWorkspace ?? await resolveWorkspace();
  await ensureVivaryCodeHostInitialized();
  let runs = ownedRuns(ownerEmail, orgId, workspace);
  let selected = runId
    ? requireOwnedRun(runId, ownerEmail, orgId, workspace)
    : runs[0] ?? null;

  const engines = await Promise.all(VIVARY_CODE_ENGINES.map(async engine => {
    const runtime = await getVivaryRuntimeStatus(engine);
    const discoveryRoot = "root" in workspace ? workspace.root : modelDiscoveryRoot;
    const modelCatalog = engine === "codex-cli" && runtime.status === "ready" && discoveryRoot
      ? await getCodexModels(discoveryRoot) : null;
    const models = engine === "claude-cli" ? [...VIVARY_CODE_MODELS]
      : modelCatalog?.status === "ready" ? modelCatalog.models.map(model => model.id) : [];
    return { engine, label: engine === "claude-cli" ? "Claude Code" : "Codex", models, modelCatalog,
      configured: runtime.status === "ready" && (engine !== "codex-cli" || modelCatalog?.status === "ready"), runtime };
  }));

  const permissionMode = await getCodePermissionMode(ownerEmail, orgId);
  let selectedEngine: VivaryCodeEngine;
  let runtime: VivaryRuntimeStatus;
  do {
    runs = ownedRuns(ownerEmail, orgId, workspace);
    selected = runId ? requireOwnedRun(runId, ownerEmail, orgId, workspace) : runs[0] ?? null;
    selectedEngine = selected ? engineFromRun(selected) : VIVARY_CODE_DEFAULT_ENGINE;
    // Discovery may outlast the runtime-status cache. Probe again before taking the final snapshot.
    runtime = await getVivaryRuntimeStatus(selectedEngine);
    runs = ownedRuns(ownerEmail, orgId, workspace);
    selected = runId ? requireOwnedRun(runId, ownerEmail, orgId, workspace) : runs[0] ?? null;
    // A newer default conversation can select another engine while its predecessor's probe awaits.
  } while ((selected ? engineFromRun(selected) : VIVARY_CODE_DEFAULT_ENGINE) !== selectedEngine);
  // No awaits separate run status, transcript and host activity in the returned snapshot.
  const host = readVivaryCodeHostState(ownerEmail, orgId);
  const selectedRuntime = engines.find(engine => engine.engine === selectedEngine);
  if (!selectedRuntime) fail("Choose an available coding runtime.", {
    errorCode: "vivary_code_runtime_unavailable", statusCode: 503,
  });
  if (selected && selectedEngine === "codex-cli" && !selectedRuntime.models.includes(modelFromRun(selected))) {
    selectedRuntime.models.push(modelFromRun(selected));
  }
  selectedRuntime.runtime = runtime;
  selectedRuntime.configured = runtime.status === "ready"
    && (selectedEngine !== "codex-cli" || selectedRuntime.modelCatalog?.status === "ready");

  // A search link opens a retained page after the same ownership check as the default transcript.
  // The stable ID checks the byte hint against edits or deletion; a stale link never opens a different event.
  const anchored = selected && anchor ? await readCodeTranscriptWindow(selected.id, anchor.eventOffset, MAX_TRANSCRIPT_EVENTS) : null;
  if (anchor && (!runId || anchored?.anchor?.id !== anchor.eventId)) {
    fail("This matching event is no longer available. Search again.", { statusCode: 404 });
  }

  return {
    ...host,
    projectId: workspace.projectId ?? null,
    workspaceLabel: workspace.label,
    defaultEngine: VIVARY_CODE_DEFAULT_ENGINE,
    engines,
    runtime,
    permissionMode,
    engineLabel: selected ? engineLabelFromRun(selected) : "Claude Code",
    models: VIVARY_CODE_MODELS,
    defaultModel: VIVARY_CODE_DEFAULT_MODEL,
    runs: runs.slice(0, MAX_RUNS).map(toRunSummary),
    run: selected
      ? {
          ...toRunSummary(selected),
          events: anchored ? dedupeAdjacentAssistantEvents(anchored.entries.map(entry => entry.event), anchor?.eventId) : dedupeAdjacentAssistantEvents(
            listCodeAgentTranscriptEvents(selected.id),
          ).slice(-MAX_TRANSCRIPT_EVENTS),
        }
      : null,
  };
}

export async function sendVivaryCodeMessage(input: {
  ownerEmail: string;
  orgId?: string;
  message: string;
  model?: string;
  engine?: VivaryCodeEngine;
  runId?: string;
  draftSubmitId?: string;
  draftThreadId?: string;
  workspace?: VivaryCodeWorkspace;
  revalidateWorkspace?: () => Promise<VivaryCodeWorkspace | undefined>;
  /**
   * The project's context for this message, loaded from the same workspace.
   * It goes into the engine prompt only. The transcript keeps the raw
   * message, so follow-up quoting never repeats an old block.
   */
  projectContext?: ProjectContextLoad;
  /** Called once the send has passed its refusals and claimed the host slot, so the panel's last load is true. */
  recordProjectContext?: (load: ProjectContextLoad) => void;
}): Promise<VivaryCodeState> {
  const workspace = input.workspace ?? await resolveWorkspace();
  await ensureVivaryCodeHostInitialized();
  // Issue #121. A send is when a refusal matters, so it waits for a check. The host-state polls never start one.
  if (hostState.cleanup) await (hostState.cleanupCheck ?? recheckVivaryCodeCleanup()).catch(() => undefined);
  assertCodeHostAvailable();

  const existing = input.runId ? requireOwnedRun(input.runId, input.ownerEmail, input.orgId, workspace) : null;
  const selectedEngine = existing ? engineFromRun(existing) : input.engine ?? VIVARY_CODE_DEFAULT_ENGINE;
  if (input.engine && input.engine !== selectedEngine) {
    fail("Start a new conversation to change coding runtimes.", { errorCode: "vivary_code_engine_changed", statusCode: 409 });
  }
  const runtime = await getVivaryRuntimeStatus(selectedEngine);
  if (runtime.status !== "ready") {
    fail(runtime.message, { errorCode: "vivary_code_runtime_unavailable", statusCode: 503 });
  }
  const catalog = selectedEngine === "codex-cli" ? await getCodexModels(workspace.root) : null;
  if (selectedEngine === "codex-cli" && catalog?.status !== "ready") {
    fail(catalog?.message ?? "Codex models are unavailable. Refresh Runtime settings.", { errorCode: "vivary_code_models_unavailable", statusCode: 503 });
  }
  const supportedModels = catalog?.status === "ready" ? catalog.models.map(model => model.id) : [];
  const recordedModel = existing ? modelFromRun(existing) : undefined;
  if (existing && input.model && input.model !== recordedModel) {
    fail("Start a new conversation to change its model.", { errorCode: "vivary_code_model_changed", statusCode: 409 });
  }
  const selectedModel = resolveVivaryCodeModel(selectedEngine,
    input.model ?? recordedModel ?? (catalog?.status === "ready" ? catalog.defaultModel : undefined),
    recordedModel ? [...supportedModels, recordedModel] : supportedModels);
  if (!existing && selectedEngine === "codex-cli" && selectedModel === "default") {
    fail("Choose a model reported by Codex before starting a conversation.", { errorCode: "vivary_code_model_unsupported", statusCode: 400 });
  }
  const permissionMode = await getCodePermissionMode(input.ownerEmail, input.orgId);
  // The worker's fingerprints and the transcript's user event use the credentials held now.
  await refreshHeldCredentials();
  if (input.revalidateWorkspace) {
    const current = await input.revalidateWorkspace();
    if (!current || !sameWorkspace(current, workspace)) {
      fail("The selected project changed while its runtime was checked. Select it again.", {
        errorCode: "vivary_code_project_changed", statusCode: 409,
      });
    }
  }

  // Claim the host slot synchronously after all runtime and project checks.
  assertCodeHostAvailable();
  const run = existing ?? createCodeAgentRunRecord({
    goalId: VIVARY_CODE_GOAL_ID,
    title: titleFromMessage(input.message),
    status: "queued",
    phase: "queued",
    needsApproval: false,
    permissionMode: "auto-edit",
    cwd: workspace.root,
    metadata: {
      app: VIVARY_CODE_APP_MARKER,
      engine: selectedEngine,
      model: selectedModel === "default" ? null : selectedModel,
      ownerEmail: input.ownerEmail,
      orgId: input.orgId,
      workspaceRoot: workspace.root,
      ...(workspace.projectId ? {
        projectId: workspace.projectId,
        bindingId: workspace.bindingId,
        rootId: workspace.rootId,
        bindingRevision: workspace.bindingRevision,
      } : {}),
      codexPermissionMode: permissionMode,
      ...(input.draftThreadId ? { draftThreadId: input.draftThreadId } : {}),
    },
  });

  const executionMessage = buildVivaryCodeExecutionPrompt(existing, selectedEngine, input.message,
    input.projectContext?.block);
  appendCodeAgentTranscriptEvent({ runId: run.id, kind: "user", message: input.message,
    metadata: { source: "vivary-workbench", permissionMode,
      ...(input.draftSubmitId && input.draftThreadId ? { draftSubmitId: input.draftSubmitId,
        draftThreadId: input.draftThreadId } : {}) } });
  if (input.projectContext) {
    recordProjectContextLoad(run, input.projectContext);
    input.recordProjectContext?.(input.projectContext);
  }
  updateCodeAgentRunRecord(run.id, { status: "queued", phase: "queued", needsApproval: false,
    metadata: { pendingLaunch: undefined, codexPermissionMode: permissionMode,
      ...(input.projectContext ? { projectContextRevision: input.projectContext.revision } : {}) } });
  startVivaryCodeRun({ runId: run.id, message: executionMessage, engine: selectedEngine, model: selectedModel,
    ownerEmail: input.ownerEmail, orgId: input.orgId, workspace, permissionMode });
  return getVivaryCodeState(input.ownerEmail, run.id, workspace, input.orgId);
}

export type VivaryCodeSessionDetails = {
  runId: string;
  engineLabel: string;
  sessionId: string | null;
  continuity: "new-session" | "reconstructed-context" | "resume-requested" | "native-resume" | "not-recorded";
  nextTurn: "native-resume" | "reconstructed-context";
  log: { reference: string; status: "available" | "missing" | "unavailable"; excerpt: string; truncated: boolean };
  providerLog: { reference: string | null; status: "available" | "missing" | "unavailable" | "unsupported" | "malformed" | "too-large";
    excerpt: string; truncated: boolean };
};

/** Authorize the run before Native opens its provider log; the client supplies no path. */
export async function getVivaryCodeSessionDetails(
  ownerEmail: string, runId: string, selectedWorkspace?: VivaryCodeReadScope, orgId?: string,
): Promise<VivaryCodeSessionDetails> {
  const workspace = selectedWorkspace ?? await resolveWorkspace();
  const run = requireOwnedRun(runId, ownerEmail, orgId, workspace);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(run.id)) fail("Local Vivary code run not found.", { statusCode: 404 });
  const sessionId = providerSessionId(run, engineFromRun(run));
  const mode = metadataString(run, "providerSessionMode");
  const continuity = mode === "new-session" || mode === "reconstructed-context" ? mode
    : sessionId && (mode === "native-resume" || mode === "resume-requested") ? mode : "not-recorded";
  const details: VivaryCodeSessionDetails = {
    runId: run.id, engineLabel: engineLabelFromRun(run), sessionId, continuity,
    nextTurn: sessionId ? "native-resume" : "reconstructed-context",
    log: { reference: `native-transcript:${run.id}`, status: "unavailable", excerpt: "", truncated: false },
    providerLog: { reference: sessionId ? `${engineFromRun(run) === "claude-cli" ? "claude-session" : "codex-thread"}:${sessionId}` : null,
      status: "unsupported", excerpt: "", truncated: false },
  };
  await refreshHeldCredentials();
  if (engineFromRun(run) === "claude-cli" && sessionId) {
    const provider = await readClaudeCodeSessionLog(run);
    // Redact each whole text before any output truncation, including a secret
    // that crosses the excerpt boundary. Paths and opaque provider data stay private.
    const messages = provider.messages.map(message => ({ role: message.role,
      text: redactCredentialsInValue(message.text)
        // Match web URLs first so their scheme/path stay intact, including credential placeholders.
        // Host paths consume through line end: spaces/apostrophes may be filename characters,
        // so ambiguous trailing prose is also hidden. The next line stays intact.
        .replace(/https?:\/\/(?:\[redacted [A-Za-z0-9_.:-]{1,64}\]|[^\s<>"'])+|(?<![A-Za-z0-9_+.-])file:[^\r\n]+|(?:[A-Za-z]:[\\/]|\\\\)[^\r\n]+|(?<![A-Za-z0-9:])\/[^\r\n]+/gi, value => /^https?:\/\//i.test(value) ? value : "[path]") }));
    const excerpt = messages.slice(-40).map(message => `${message.role}: ${message.text.slice(0, 1_500)}`).join("\n\n");
    details.providerLog = { reference: provider.reference, status: provider.status, excerpt: excerpt.slice(-20_000),
      truncated: messages.length > 40 || messages.some(message => message.text.length > 1_500) || excerpt.length > 20_000 };
  }
  let file;
  try {
    const logPath = codeAgentRunTranscriptPath(run.id);
    const before = await lstat(logPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) return details;
    file = await open(logPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await file.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n || opened.size > BigInt(Number.MAX_SAFE_INTEGER)) return details;
    // Read the final 64 KiB once. A partial first/last line is omitted, never parsed as another event.
    const size = Number(opened.size);
    const offset = Math.max(0, size - 64 * 1024);
    const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (offset) text = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "";
    const lines = text.split("\n").slice(0, -1);
    const messages: string[] = [];
    let truncated = offset > 0 || bytesRead < size;
    for (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { truncated = true; continue; }
      if (!event || event.runId !== run.id || typeof event.message !== "string"
          || !["user", "system", "note", "artifact", "status"].includes(event.kind)) continue;
      if (event.message.length > 1_500) truncated = true;
      messages.push(`${event.kind}: ${redactCredentialsInValue(event.message).slice(0, 1_500)}`);
    }
    if (messages.length > 40) truncated = true;
    const excerpt = messages.slice(-40).join("\n\n");
    details.log = { ...details.log, status: "available", excerpt: excerpt.slice(-20_000),
      truncated: truncated || excerpt.length > 20_000 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") details.log.status = "missing";
  } finally { await file?.close(); }
  return details;
}

function providerSessionId(run: CodeAgentRunRecord, engine: VivaryCodeEngine): string | null {
  if (metadataString(run, "engine") !== engine) return null;
  const id = metadataString(run, engine === "claude-cli" ? "claudeSessionId" : "codexSessionId");
  return id && (engine === "claude-cli"
    ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    : /^[A-Za-z0-9_-]{1,128}$/.test(id)) ? id : null;
}

export async function approveVivaryCodeMessage(input: {
  ownerEmail: string; orgId?: string; runId: string; requestId: string; workspace?: VivaryCodeWorkspace;
  revalidateWorkspace?: () => Promise<VivaryCodeWorkspace | undefined>;
  answers?: Record<string, string[]>; content?: Record<string, unknown>;
}): Promise<VivaryCodeState> {
  const workspace = input.workspace ?? await resolveWorkspace();
  requireOwnedRun(input.runId, input.ownerEmail, input.orgId, workspace);
  if (input.revalidateWorkspace && !sameWorkspace(await input.revalidateWorkspace() ?? { root: "", label: "" }, workspace)) {
    fail("The selected project changed. Review the request again.", { statusCode: 409 });
  }
  const active = activeRuns.get(input.runId);
  if (!active || !sameWorkspace(workspace, active.workspace)) fail("The project connection changed. Stop this turn and send a new message.", { errorCode: "vivary_code_approval_project_changed", statusCode: 409 });
  return resolveCodexRequest({ ...input, projectId: workspace.projectId }, { allow: true, answers: input.answers, content: input.content });
}

export async function denyVivaryCodeMessage(input: {
  ownerEmail: string; orgId?: string; runId: string; requestId: string; projectId?: string;
}): Promise<VivaryCodeState> {
  return resolveCodexRequest(input, { allow: false });
}

async function resolveCodexRequest(input: {
  ownerEmail: string; orgId?: string; runId: string; requestId: string; projectId?: string;
}, decision: CodexApprovalDecision): Promise<VivaryCodeState> {
  await ensureVivaryCodeHostInitialized();
  const active = activeRuns.get(input.runId);
  const pending = active?.requests.get(input.requestId);
  if (!active || !pending || active.stopReason || active.ownerEmail !== input.ownerEmail
      || active.orgId !== input.orgId || active.workspace.projectId !== input.projectId) {
    fail("This request is no longer current.", { errorCode: "vivary_code_approval_stale", statusCode: 409 });
  }
  let response: Record<string, unknown>;
  try { response = codexApprovalResponse(pending.request, decision); }
  catch (error) { fail(error instanceof Error ? error.message : "Check your response.", { statusCode: 400 }); }
  active.requests.delete(input.requestId);
  appendCodeAgentTranscriptEvent({ runId: input.runId, kind: "status", message: decision.allow ? "Codex request allowed." : "Codex request declined.",
    metadata: { requestId: input.requestId, method: pending.request.method } });
  updateCodeAgentRunRecord(input.runId, { needsApproval: active.requests.size > 0,
    status: active.requests.size ? "needs-approval" : "running", phase: active.requests.size ? "action-approval" : "running" });
  pending.resolve(response);
  return getVivaryCodeState(input.ownerEmail, input.runId, active.workspace, input.orgId);
}

function startVivaryCodeRun(input: {
  runId: string;
  message: string;
  engine: VivaryCodeEngine;
  model: string;
  ownerEmail: string;
  orgId?: string;
  workspace: VivaryCodeWorkspace;
  permissionMode: CodePermissionMode;
}): void {
  const controller = new AbortController();
  const activeRun: ActiveRun = {
    controller,
    execution: null,
    ownerEmail: input.ownerEmail,
    orgId: input.orgId,
    stopReason: null,
    workspace: input.workspace,
    permissionMode: input.permissionMode,
    requests: new Map(),
  };
  activeRuns.set(input.runId, activeRun);
  activeRun.execution = executeVivaryCodeRun({
    activeRun,
    message: input.message,
    model: input.model === "default" ? undefined : input.model,
    runId: input.runId,
  });
  void activeRun.execution.catch(() => undefined);
}

async function executeVivaryCodeRun(input: {
  activeRun: ActiveRun;
  message: string;
  model: string | undefined;
  runId: string;
}): Promise<void> {
  // Persist the cleanup target before final verification. The finally block clears it when nothing remains.
  let stopRefusedAt = null as string | null;
  try {
    await executeVivaryCodeWorker({
      runId: input.runId,
      prompt: input.message,
      model: input.model,
      ownerEmail: input.activeRun.ownerEmail,
      orgId: input.activeRun.orgId,
      signal: input.activeRun.controller.signal,
      permissionMode: input.activeRun.permissionMode,
      onRequest: request => {
        if (!supportsCodexRequest(request)) throw new Error("Codex requested an unsupported interaction.");
        if (input.activeRun.controller.signal.aborted) throw new Error("This run is stopping.");
        return new Promise(resolve => {
          input.activeRun.requests.set(request.requestId, { request, resolve });
          updateCodeAgentRunRecord(input.runId, { status: "needs-approval", phase: "action-approval", needsApproval: true });
        });
      },
      onRequestResolved: requestId => {
        const pending = input.activeRun.requests.delete(requestId);
        if (pending && !input.activeRun.controller.signal.aborted && getCodeAgentRunRecord(input.runId)?.phase === "action-approval") updateCodeAgentRunRecord(input.runId, {
          status: input.activeRun.requests.size ? "needs-approval" : "running",
          phase: input.activeRun.requests.size ? "action-approval" : "running", needsApproval: input.activeRun.requests.size > 0 });
      },
      onStopFailed: ({ step, target }) => {
        stopRefusedAt = new Date().toISOString();
        writeCleanupRefusal({ runId: input.runId, target, remaining: [], total: 0, fingerprint: null, hidden: false,
          scan: "unavailable", step, refusedAt: stopRefusedAt, checkedAt: stopRefusedAt, ends: [] });
      },
    });
    if (input.activeRun.stopReason !== null) {
      recordPausedRun(input.runId, "The local code run stopped.", {
        phase: "paused",
        reason: input.activeRun.stopReason,
      });
    }
  } catch (error) {
    if (error instanceof VivaryCodeWorkerCleanupError) {
      const refusal = cleanupRefusalFromFailedStop(input.runId, error, stopRefusedAt);
      stopRefusedAt = null;
      // The credential redaction plugin redacts server output. Process names stay out of the log.
      console.error(`[vivary-code-host] cleanup-unverified run=${input.runId} step=${refusal.step ?? "unknown"} `
        + `scan=${refusal.scan} remaining=${refusal.remaining.length}`);
      // The record is the refusal's source of truth, so it is written before the transcript. Both happen before
      // `finally` frees the host slot, so no send starts beside the leftovers.
      const message = cleanupFailureMessage(refusal);
      writeCleanupRefusal(refusal, { executionError: message });
      try {
        appendCodeAgentTranscriptEvent({ runId: input.runId, kind: "status", message,
          metadata: { status: "errored", phase: "cleanup-unverified" } });
      } catch (failure) { logCleanupRecordFailure(input.runId, failure); }
      return;
    }
    if (input.activeRun.stopReason !== null) {
      recordPausedRun(input.runId, "The local code run stopped.", {
        phase: "paused",
        reason: input.activeRun.stopReason,
      });
      return;
    }
    const message = safeErrorMessage(error);
    appendCodeAgentTranscriptEvent({
      runId: input.runId,
      kind: "status",
      message: `The local code run failed: ${message}`,
      metadata: { status: "errored", phase: "error" },
    });
    updateCodeAgentRunRecord(input.runId, {
      status: "errored",
      phase: "error",
      metadata: {
        executionError: message,
        executionErroredAt: new Date().toISOString(),
      },
    });
  } finally {
    if (stopRefusedAt !== null) clearStopRefusal(input.runId);
    input.activeRun.requests.clear();
    activeRuns.delete(input.runId);
  }
}

export async function stopVivaryCodeRun(input: {
  ownerEmail: string;
  orgId?: string;
  runId: string;
  projectId?: string;
}): Promise<VivaryCodeState> {
  await ensureVivaryCodeHostInitialized();
  const record = listCodeAgentRunRecords(VIVARY_CODE_GOAL_ID).find(run =>
    run.id === input.runId && metadataString(run, "app") === VIVARY_CODE_APP_MARKER
    && metadataString(run, "ownerEmail") === input.ownerEmail
    && metadataString(run, "orgId") === (input.orgId ?? null)
    && metadataString(run, "projectId") === (input.projectId ?? null));
  if (!record) fail("Local Vivary code run not found.", { statusCode: 404 });
  // Cancellation uses the recorded owner and project. A missing folder must not prevent Stop.
  const workspace: VivaryCodeWorkspace = {
    root: record.cwd, label: path.basename(record.cwd),
    projectId: metadataString(record, "projectId") ?? undefined,
    bindingId: metadataString(record, "bindingId") ?? undefined,
    rootId: metadataString(record, "rootId") ?? undefined,
    bindingRevision: metadataNumber(record, "bindingRevision") ?? undefined,
  };

  const activeRun = activeRuns.get(input.runId);
  if (!activeRun || activeRun.ownerEmail !== input.ownerEmail) {
    fail("That local Vivary code run is not active.", {
      errorCode: "vivary_code_run_not_active",
      statusCode: 409,
    });
  }

  // Issue #121. A run whose failed stop is still checking is already ending, and a Stop then would record the worker's
  // failure as the owner's stop.
  if (activeRun.stopReason === null && hostState.cleanup?.runId !== input.runId) {
    activeRun.stopReason = "user";
    recordStoppingRun(
      input.runId,
      "Stop requested from the Vivary workbench.",
      "user",
    );
    activeRun.controller.abort();
  }

  return getVivaryCodeState(input.ownerEmail, input.runId, workspace, input.orgId);
}

export async function getVivaryCodeFiles(
  requestedPath?: string,
  selectedWorkspace?: VivaryCodeWorkspace,
): Promise<VivaryCodeFileState> {
  const workspace = selectedWorkspace ?? await resolveWorkspace();
  const files = await listWorkspaceFiles(workspace.root);
  if (!requestedPath) {
    return {
      workspaceLabel: workspace.label,
      files: files.items,
      file: null,
      truncated: files.truncated,
    };
  }

  const file = await readWorkspaceFile(workspace.root, requestedPath);
  return {
    workspaceLabel: workspace.label,
    files: files.items,
    file,
    truncated: files.truncated,
  };
}

function ownedRuns(ownerEmail: string, orgId: string | undefined, scope: VivaryCodeReadScope) {
  return listCodeAgentRunRecords(VIVARY_CODE_GOAL_ID).filter(
    (run) => isOwnedRun(run, ownerEmail, orgId, scope),
  );
}

function requireOwnedRun(
  runId: string,
  ownerEmail: string,
  orgId: string | undefined,
  scope: VivaryCodeReadScope,
): CodeAgentRunRecord {
  const run = listCodeAgentRunRecords(VIVARY_CODE_GOAL_ID).find(
    (candidate) =>
      candidate.id === runId && isOwnedRun(candidate, ownerEmail, orgId, scope),
  );
  if (!run) {
    fail("Local Vivary code run not found.", {
      errorCode: "vivary_code_run_not_found",
      statusCode: 404,
    });
  }
  return run;
}

export function isVivaryAppRun(
  run: Pick<CodeAgentRunRecord, "goalId" | "cwd" | "metadata">,
  workspace: VivaryCodeWorkspace,
): boolean {
  return (
    run.goalId === VIVARY_CODE_GOAL_ID &&
    run.cwd === workspace.root &&
    metadataString(run, "app") === VIVARY_CODE_APP_MARKER &&
    metadataString(run, "workspaceRoot") === workspace.root &&
    metadataString(run, "projectId") === (workspace.projectId ?? null) &&
    metadataString(run, "bindingId") === (workspace.bindingId ?? null) &&
    metadataString(run, "rootId") === (workspace.rootId ?? null) &&
    metadataNumber(run, "bindingRevision") === (workspace.bindingRevision ?? null)
  );
}

function isVivaryProjectHistoryRun(
  run: Pick<CodeAgentRunRecord, "goalId" | "metadata">,
  project: Pick<VivaryCodeProjectHistory, "projectId" | "bindingId">,
): boolean {
  return run.goalId === VIVARY_CODE_GOAL_ID
    && metadataString(run, "app") === VIVARY_CODE_APP_MARKER
    && metadataString(run, "projectId") === project.projectId
    && metadataString(run, "bindingId") === project.bindingId;
}

export function isOwnedRun(
  run: CodeAgentRunRecord,
  ownerEmail: string,
  orgId: string | undefined,
  scope: VivaryCodeReadScope,
): boolean {
  // Reconnection changes the local root epoch, not the saved conversation.
  // Approval still checks the newly staged workspace tuple with sameWorkspace.
  const belongsToScope = "kind" in scope
    ? false // Unassigned history is Native-only; project-less Code runs belong to Personal workspace.
    : "root" in scope
    ? scope.projectId && scope.bindingId
      ? run.cwd === scope.root
        && metadataString(run, "workspaceRoot") === scope.root
        && isVivaryProjectHistoryRun(run, {
          projectId: scope.projectId,
          bindingId: scope.bindingId,
        })
      : isVivaryAppRun(run, scope)
    : isVivaryProjectHistoryRun(run, scope);
  return belongsToScope && isOwnedIdentity(run, ownerEmail, orgId);
}

function isOwnedIdentity(
  run: CodeAgentRunRecord,
  ownerEmail: string,
  orgId?: string,
): boolean {
  return metadataString(run, "app") === VIVARY_CODE_APP_MARKER
    && metadataString(run, "ownerEmail") === ownerEmail
    && metadataString(run, "orgId") === (orgId ?? null);
}

function assertCodeHostAvailable(): void {
  if (projectReconnectionPending()) {
    fail("Project reconnection is in progress. Retry this coding request after it finishes.", {
      errorCode: "vivary_code_project_reconnecting", statusCode: 409,
    });
  }
  if (hostState.closing) {
    fail("The coding host is shutting down.", { errorCode: "vivary_code_host_closing", statusCode: 503 });
  }
  if (hostState.cleanup) {
    fail(cleanupRefusalMessage(hostState.cleanup), { errorCode: "vivary_code_cleanup_required", statusCode: 409 });
  }
  if (activeRuns.size > 0) {
    fail("A Vivary coding request is active or waiting for approval. Open it, deny it, or stop it.", {
      errorCode: "vivary_code_run_active",
      statusCode: 409,
    });
  }
}

function sameWorkspace(left: VivaryCodeWorkspace, right: VivaryCodeWorkspace): boolean {
  const fields = ["root", "projectId", "bindingId", "rootId", "bindingRevision", "policyRevision"] as const;
  return fields.every(field => left[field] === right[field]);
}

function metadataString(run: Pick<CodeAgentRunRecord, "metadata">, key: string): string | null {
  const value = run.metadata?.[key];
  return typeof value === "string" ? value : null;
}

function metadataNumber(run: Pick<CodeAgentRunRecord, "metadata">, key: string): number | null {
  const value = run.metadata?.[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

const legacyRunDraftIds = new Map<string, { updatedAt: string; draftThreadId: string | null }>();

function runDraftThreadId(run: CodeAgentRunRecord): string | null {
  const projectId = metadataString(run, "projectId");
  const prefix = "vivary-code:" + (projectId ? "project:" + projectId + ":" : "");
  let candidate = metadataString(run, "draftThreadId");
  if (!candidate) {
    let cached = legacyRunDraftIds.get(run.id);
    if (!cached || cached.updatedAt !== run.updatedAt) {
      const first = listCodeAgentTranscriptEvents(run.id).find(event =>
        event.kind === "user" && typeof event.metadata?.draftThreadId === "string");
      cached = { updatedAt: run.updatedAt, draftThreadId: typeof first?.metadata?.draftThreadId === "string"
        ? first.metadata.draftThreadId : null };
      legacyRunDraftIds.set(run.id, cached);
    }
    candidate = cached.draftThreadId;
  }
  return candidate?.startsWith(prefix) && /^[A-Za-z0-9_-]{1,128}$/.test(candidate.slice(prefix.length))
    ? candidate : null;
}

function toRunSummary(run: CodeAgentRunRecord): VivaryCodeRunSummary {
  return {
    id: run.id,
    status: activeRuns.has(run.id) && !isActiveCodeAgentRun(run) ? "running" : run.status,
    phase: run.phase,
    title: run.title,
    updatedAt: run.updatedAt,
    engine: engineFromRun(run),
    engineLabel: engineLabelFromRun(run),
    model: modelFromRun(run),
    draftThreadId: runDraftThreadId(run),
  };
}

function engineLabelFromRun(run: CodeAgentRunRecord): string {
  const engine = metadataString(run, "engine");
  if (engine === "claude-cli") return "Claude Code";
  if (engine === "codex-cli") return "Codex CLI";
  return "Local code agent";
}

function modelFromRun(run: CodeAgentRunRecord): string {
  return metadataString(run, "model")
    ?? (metadataString(run, "engine") === "claude-cli"
      ? VIVARY_CODE_DEFAULT_MODEL
      : "default");
}

function engineFromRun(run: CodeAgentRunRecord): VivaryCodeEngine {
  const engine = metadataString(run, "engine");
  if (engine === "claude-cli" || engine === "codex-cli") return engine;
  fail("This conversation uses an unsupported runtime. Start a new conversation.", {
    errorCode: "vivary_code_historical_engine", statusCode: 409,
  });
}

export function resolveVivaryCodeModel(engine: VivaryCodeEngine, requested?: string, codexModels: readonly string[] = []): string {
  if (engine === "codex-cli") {
    if (!requested || requested === "default") return "default";
    if (codexModels.includes(requested)) return requested;
  } else {
    if (!requested) return VIVARY_CODE_DEFAULT_MODEL;
    if (VIVARY_CODE_MODELS.some(model => model === requested)) return requested;
  }
  fail("Choose a model supported by the selected coding runtime.", {
    errorCode: "vivary_code_model_unsupported", statusCode: 400,
  });
}

function titleFromMessage(message: string): string {
  const firstLine = message.split(/\r?\n/, 1)[0]?.trim() || "Vivary code run";
  return firstLine.length <= 72 ? firstLine : `${firstLine.slice(0, 69)}...`;
}

function recordPausedRun(
  runId: string,
  message: string,
  metadata: Record<string, unknown>,
): void {
  appendCodeAgentTranscriptEvent({
    runId,
    kind: "status",
    message,
    metadata: { status: "paused", ...metadata },
  });
  updateCodeAgentRunRecord(runId, {
    status: "paused",
    phase: typeof metadata.phase === "string" ? metadata.phase : "paused",
    progress: {
      label: "Paused",
      completed: 0,
      total: 1,
      failed: 0,
      percent: 0,
    },
  });
}

function recordStoppingRun(
  runId: string,
  message: string,
  reason: "shutdown" | "user",
): void {
  appendCodeAgentTranscriptEvent({
    runId,
    kind: "status",
    message,
    metadata: { status: "running", phase: "stopping", reason },
  });
  updateCodeAgentRunRecord(runId, {
    status: "running",
    phase: "stopping",
    progress: {
      label: "Stopping",
      completed: 0,
      total: 1,
      percent: 0,
    },
  });
}

/**
 * The engine prompt for one message. A new run and a saved provider session
 * get the raw message. Legacy follow-ups without a provider ID quote the
 * transcript. Every turn gets the full project block, so a resumed session
 * never relies on a block its provider may have compacted away.
 */
export function buildVivaryCodeExecutionPrompt(
  existing: CodeAgentRunRecord | null,
  engine: VivaryCodeEngine,
  message: string,
  projectContext?: ProjectContextBlock,
): string {
  const resumesProviderSession = existing !== null && providerSessionId(existing, engine) !== null;
  const prompt = existing && !resumesProviderSession
    ? buildVivaryCodeFollowUpPrompt(listCodeAgentTranscriptEvents(existing.id), message) : message;
  return projectContext ? `${projectContext}\n\n${prompt}` : prompt;
}

// One note per turn, which Native's transcript shows, says what loaded and
// whether it changed since the run's previous turn.
function recordProjectContextLoad(run: CodeAgentRunRecord, load: ProjectContextLoad): void {
  const previous = metadataString(run, "projectContextRevision");
  const changed = previous !== null && previous !== load.revision;
  appendCodeAgentTranscriptEvent({ runId: run.id, kind: "note",
    message: changed ? `${load.summary} The project context changed since the last turn.` : load.summary,
    metadata: { source: "vivary-project-context", projectContextRevision: load.revision, changed } });
}

export function buildVivaryCodeFollowUpPrompt(
  events: CodeAgentTranscriptEvent[],
  currentMessage: string,
): string {
  const turns = dedupeAdjacentAssistantEvents(events)
    .flatMap((event) => {
      const message = event.message.trim();
      if (!message) return [];
      if (event.kind === "user") return [{ role: "User", message }];
      if (isAssistantEvent(event)) return [{ role: "Assistant", message }];
      return [];
    })
    .slice(-MAX_FOLLOW_UP_EVENTS);
  if (turns.length === 0) return currentMessage;

  const selected: string[] = [];
  let usedChars = 0;
  for (const turn of turns.reverse()) {
    const prefix = `${turn.role}: `;
    const remaining = MAX_FOLLOW_UP_CONTEXT_CHARS - usedChars - prefix.length;
    if (remaining <= 0) break;
    const message = turn.message.slice(
      0,
      Math.min(MAX_FOLLOW_UP_EVENT_CHARS, remaining),
    );
    const rendered = `${prefix}${message}`;
    selected.push(rendered);
    usedChars += rendered.length + 2;
  }

  return [
    "# Previous conversation",
    "This is quoted context from the same Vivary run.",
    "",
    ...selected.reverse(),
    "",
    "# Current request",
    currentMessage,
  ].join("\n");
}

function dedupeAdjacentAssistantEvents(
  events: CodeAgentTranscriptEvent[],
  anchorId?: string,
): CodeAgentTranscriptEvent[] {
  const result: CodeAgentTranscriptEvent[] = [];
  for (const event of events) {
    const previous = result.at(-1);
    if (
      previous &&
      isAssistantEvent(previous) &&
      isAssistantEvent(event) &&
      previous.metadata?.phase === event.metadata?.phase &&
      previous.metadata?.itemId === event.metadata?.itemId &&
      previous.message.trim() === event.message.trim()
    ) {
      if (previous.id !== anchorId) result[result.length - 1] = event;
      continue;
    }
    result.push(event);
  }
  return result;
}

function isAssistantEvent(event: CodeAgentTranscriptEvent): boolean {
  return event.kind === "system" && event.metadata?.role === "assistant";
}

export async function resolveWorkspace(): Promise<VivaryCodeWorkspace> {
  // guard:allow-env-credential - Deployment-level filesystem path for the private preview.
  const configured = process.env.VIVARY_LOCAL_AGENT_WORKSPACE?.trim();
  if (!configured || !path.isAbsolute(configured)) {
    fail("The local Vivary code workspace is not configured.", {
      errorCode: "vivary_code_workspace_unavailable",
      statusCode: 503,
    });
  }

  let root: string;
  try {
    root = await realpath(configured);
    const rootStat = await stat(root);
    if (!rootStat.isDirectory()) {
      throw new Error("Configured workspace is not a directory.");
    }
  } catch {
    fail("The configured local Vivary code workspace is unavailable.", {
      errorCode: "vivary_code_workspace_unavailable",
      statusCode: 503,
    });
  }

  return { root, label: path.basename(root) };
}

async function listWorkspaceFiles(
  workspaceRoot: string,
): Promise<{ items: VivaryCodeFileSummary[]; truncated: boolean }> {
  const items: VivaryCodeFileSummary[] = [];
  const pending = [{ directory: workspaceRoot, depth: 0 }];
  let scanned = 0;

  while (pending.length > 0 && items.length < MAX_LISTED_FILES) {
    const next = pending.shift();
    if (!next) break;
    const entries = await readdir(next.directory, { withFileTypes: true });
    for (const entry of entries) {
      scanned += 1;
      if (scanned > MAX_SCANNED_ENTRIES) {
        return { items, truncated: true };
      }
      if (entry.isSymbolicLink()) continue;

      const absolutePath = path.join(next.directory, entry.name);
      if (entry.isDirectory()) {
        if (next.depth < MAX_SCAN_DEPTH) {
          const directoryRoot = await realpath(absolutePath);
          assertContained(workspaceRoot, directoryRoot);
          pending.push({ directory: directoryRoot, depth: next.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile() || !isAllowedFile(absolutePath)) continue;

      const fileStat = await stat(absolutePath);
      if (fileStat.size > MAX_FILE_BYTES) continue;
      items.push({
        path: toPortableRelativePath(workspaceRoot, absolutePath),
        name: entry.name,
        sizeBytes: fileStat.size,
        updatedAt: fileStat.mtime.toISOString(),
      });
      if (items.length >= MAX_LISTED_FILES) break;
    }
  }

  items.sort((left, right) => left.path.localeCompare(right.path));
  return { items, truncated: pending.length > 0 };
}

async function readWorkspaceFile(
  workspaceRoot: string,
  requestedPath: string,
): Promise<VivaryCodeFileSummary & { content: string }> {
  if (path.isAbsolute(requestedPath)) {
    rejectFilePath();
  }
  const candidate = path.resolve(workspaceRoot, requestedPath);
  assertContained(workspaceRoot, candidate);
  if (!isAllowedFile(candidate)) {
    fail("Vivary can display only .md, .txt, and .json files here.", {
      errorCode: "vivary_code_file_type_blocked",
      statusCode: 400,
    });
  }

  let requestedStat: Awaited<ReturnType<typeof lstat>>;
  try {
    requestedStat = await lstat(candidate);
  } catch {
    fail("The requested workspace file was not found.", {
      errorCode: "vivary_code_file_not_found",
      statusCode: 404,
    });
  }
  if (requestedStat.isSymbolicLink()) rejectFilePath();

  const canonical = await realpath(candidate);
  assertContained(workspaceRoot, canonical);

  const fileStat = await stat(canonical);
  if (!fileStat.isFile()) rejectFilePath();
  if (fileStat.size > MAX_FILE_BYTES) {
    fail("The requested workspace file is larger than 64 KB.", {
      errorCode: "vivary_code_file_too_large",
      statusCode: 413,
    });
  }

  return {
    path: toPortableRelativePath(workspaceRoot, canonical),
    name: path.basename(canonical),
    sizeBytes: fileStat.size,
    updatedAt: fileStat.mtime.toISOString(),
    content: await readFile(canonical, "utf8"),
  };
}

function assertContained(workspaceRoot: string, candidate: string): void {
  const relative = path.relative(workspaceRoot, candidate);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    return;
  }
  rejectFilePath();
}

function rejectFilePath(): never {
  fail("The requested path is outside the local Vivary workspace.", {
    errorCode: "vivary_code_file_path_blocked",
    statusCode: 400,
  });
}

function isAllowedFile(filePath: string): boolean {
  return ALLOWED_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function toPortableRelativePath(workspaceRoot: string, filePath: string): string {
  return path.relative(workspaceRoot, filePath).split(path.sep).join("/");
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return "Unknown local code agent error.";
}
