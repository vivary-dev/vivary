import type { ActionRunContext } from "@agent-native/core/action";
import { z } from "zod";

import { workspacePreset } from "../shared/workspace-patterns.ts";
import {
  PROJECT_READ_MAX_RESULT_CHARS, PUBLIC_REVIEW_PACKS, PUBLIC_REVIEW_RULES, READ_BOUNDS,
  type Bounded, type ProjectReadOperation, type ProjectReadOwnerInput, type ProjectReadReport,
  type ProjectReadResult, type ProjectReadToolInput, type ProjectRef, type UnavailableReason,
} from "../app/lib/project-read-schema.ts";
import {
  ORIGINAL_RUN_FAILURES, runProjectRead, type OriginalRunFailure, type ProjectReadCommand,
} from "./original-runtime.ts";
import { resolveNativeChatProject } from "./native-chat-project.ts";

const NOTICE = "Observations only. They do not authorize repairs, installs, or commands.";

const UNAVAILABLE: Record<UnavailableReason, string> = { target_unavailable: "No shared note in this project has this id.",
  privacy_policy_unavailable: "Vivary cannot tell this folder's private files apart, so find, check, review, and impact stay off for it. They need a Git repository on a host with Git installed, or a Vivary workspace.",
  path_refused: "Vivary refused to read this project folder. The folder may be a link, or its path may have changed.",
  work_limit_exceeded: "This project is larger than Vivary reads in one pass, or check found more than 200 findings.",
  producer_unavailable: "The original component for this report is unavailable in this installation.",
  timeout: "The original command exceeded its 30-second limit.",
  queue_timeout: "Earlier original commands are still running. Try again when they finish.",
  output_limit: "The original command produced more output than Vivary reads.",
  runtime_unavailable: "The bundled Vivary runtime is unavailable or could not start on this host.",
  app_data_unavailable: "Vivary's application data on this host is missing or unsafe to use, so the original command did not run.",
  unreadable_output: "The original command did not return a readable report.",
};
// find refuses a question with the same reason it refuses a folder.
const FIND_PATH_REFUSED = "Vivary refused this question or this project folder. A question cannot contain a file or URL path, credential-like text, control characters, or the folder's own path.";

const RUN_FAILURES: Record<OriginalRunFailure, UnavailableReason> = {
  [ORIGINAL_RUN_FAILURES.queueTimeout]: "queue_timeout",
  [ORIGINAL_RUN_FAILURES.timeout]: "timeout",
  [ORIGINAL_RUN_FAILURES.outputLimit]: "output_limit",
  [ORIGINAL_RUN_FAILURES.runtimeUnavailable]: "runtime_unavailable",
  [ORIGINAL_RUN_FAILURES.dataUnavailable]: "app_data_unavailable",
  [ORIGINAL_RUN_FAILURES.receiptPath]: "app_data_unavailable",
};

const count = z.number().int().nonnegative();
// A source path is shown and linked inside the project grant, so anything
// that could leave the project makes the whole report unreadable.
const sourcePath = z.string().min(1).max(512).refine(value => !value.startsWith("/") && !value.includes("\\")
  && !value.includes("\0") && !/^[A-Za-z]:/.test(value) && !value.split("/").includes(".."));
// Tropo bounds an omission's kind and reason to 64 code points. Fitting never
// drops omission rows, so that bound is what keeps them inside the result cap.
const omissionText = z.string().max(128);
const omissions = z.array(z.object({ kind: omissionText, reason: omissionText, count }));
const refusal = z.object({ schema: z.literal("vivary.read-refusal/v0"),
  reason: z.enum(["privacy_policy_unavailable", "path_refused", "work_limit_exceeded", "producer_unavailable",
    "target_unavailable"]) });

// Doctor, check, find, review, and impact follow the `--public` schemas. Every
// field is required except a review finding's `field`, and only a note's type
// and a hit's snippet may be null.
const outputs = {
  doctor: z.object({ schema: z.literal("vivary.doctor-result/v0"), ok: z.boolean(), errors: z.array(z.string()),
    warnings: z.array(z.string()) }),
  check: z.object({ schema: z.literal("vivary.check-result/v0"), checked: count, clean: count, errors: count, warnings: count,
    findings: z.array(z.object({ path: sourcePath, line: count, level: z.enum(["error", "warning"]),
      code: z.string(), message: z.string() })),
    strict: z.boolean(), complete: z.boolean(), omissions }),
  find: z.object({ schema: z.literal("vivary.find-result/v0"), query: z.string(), k: count, budget: count,
    estimated_tokens: count, complete: z.boolean(), omissions,
    results: z.array(z.object({ id: z.string(), type: z.string().nullable(), path: sourcePath, reason: z.string(),
      snippet: z.string().nullable() })) }),
  capabilities: z.object({ preset: workspacePreset, default_capabilities: z.array(z.string()),
    available_capabilities: z.array(z.object({ id: z.string(), label: z.string(), default: z.boolean(),
      requires_approval: z.boolean(), network: z.union([z.boolean(), z.string()]),
      install_status: z.enum(["installed", "not-installed", "incompatible", "probe-failed"]),
      missing_install: z.array(z.string()) })) }),
  // The logs helper already keeps only safe receipt fields; their values stay untrusted.
  // `log` covers the whole file and is null when there is no log yet.
  receipts: z.object({ log: z.object({ total: count, failed: count, invalid_lines: count }).nullable(),
    records: z.array(z.record(z.string(), z.unknown())) }),
  // A rule outside the closed table makes the whole report unreadable, so the
  // panel never shows a finding it has no sentence for.
  review: z.object({ schema: z.literal("vivary.review-result/v0"), pack: z.enum(PUBLIC_REVIEW_PACKS), reviewed: count,
    warnings: count, notes: count, complete: z.boolean(), omissions,
    findings: z.array(z.object({ severity: z.enum(["warn", "info"]), rule: z.enum(PUBLIC_REVIEW_RULES), id: z.string(),
      type: z.string().nullable(), path: sourcePath, field: z.string().optional() })
      .refine(finding => (finding.rule === "broken-edge") === (finding.field !== undefined))) }),
  impact: z.object({ schema: z.literal("vivary.impact-result/v0"), target: z.string(), impacted: count,
    complete: z.boolean(), omissions,
    nodes: z.array(z.object({ id: z.string(), distance: z.number().int().positive(), via: z.string(),
      type: z.string().nullable(), path: sourcePath })) }),
};

function bounded<T>(values: readonly T[]): Bounded<T> {
  return { items: values.slice(0, READ_BOUNDS.items), total: values.length };
}

const stringOr = <T>(value: unknown, fallback: T) => typeof value === "string" ? value : fallback;
const numberOrNull = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;

// Each operation names its original command and projects that command's
// parsed output. `null` means the output was not this command's report.
const operations: { [Operation in ProjectReadOperation]: {
  command: (input: ProjectReadToolInput) => ProjectReadCommand;
  report: (stdout: unknown, input: ProjectReadToolInput) => ProjectReadReport | null;
} } = {
  doctor: {
    command: () => ({ verb: "doctor" }),
    report: stdout => {
      const parsed = outputs.doctor.safeParse(stdout);
      if (!parsed.success) return null;
      const { ok, errors, warnings } = parsed.data;
      return { operation: "doctor", ok, errors: bounded(errors), warnings: bounded(warnings) };
    },
  },
  check: {
    command: () => ({ verb: "check" }),
    report: stdout => {
      const parsed = outputs.check.safeParse(stdout);
      if (!parsed.success) return null;
      const data = parsed.data;
      return { operation: "check", checked: data.checked, clean: data.clean, errorCount: data.errors,
        warningCount: data.warnings, strict: data.strict, complete: data.complete,
        findings: bounded(data.findings.map(({ path, line, level, code, message }) => ({ path, line, level, code, message }))),
        omissions: data.omissions.slice(0, READ_BOUNDS.items) };
    },
  },
  find: {
    command: input => ({ verb: "find", query: input.query ?? "", k: input.k ?? 5, budget: input.budget ?? 1_200 }),
    report: stdout => {
      const parsed = outputs.find.safeParse(stdout);
      if (!parsed.success) return null;
      const data = parsed.data;
      return { operation: "find", query: data.query, k: data.k, budget: data.budget,
        estimatedTokens: data.estimated_tokens, complete: data.complete,
        results: bounded(data.results.map(({ id, type, path, reason, snippet }) => ({ id, type, path, reason, snippet }))),
        omissions: data.omissions.slice(0, READ_BOUNDS.items) };
    },
  },
  capabilities: {
    command: input => ({ verb: "capabilities", preset: input.preset ?? "coding" }),
    report: stdout => {
      const parsed = outputs.capabilities.safeParse(stdout);
      if (!parsed.success) return null;
      const data = parsed.data;
      return { operation: "capabilities", preset: data.preset,
        defaults: data.default_capabilities.slice(0, READ_BOUNDS.items),
        capabilities: bounded(data.available_capabilities.map(capability => ({ id: capability.id,
          label: capability.label, isDefault: capability.default, requiresApproval: capability.requires_approval,
          network: capability.network, installStatus: capability.install_status,
          missing: capability.missing_install.slice(0, READ_BOUNDS.items) }))) };
    },
  },
  receipts: {
    command: input => ({ verb: "logs", failedOnly: input.failedOnly ?? false }),
    report: (stdout, input) => {
      const failedOnly = input.failedOnly ?? false;
      const parsed = outputs.receipts.safeParse(stdout);
      if (!parsed.success) return null;
      const { log, records } = parsed.data;
      if (!log) {
        return { operation: "receipts", scope: "application", failedOnly, logPresent: false, total: 0, failed: 0, invalidLines: 0,
          records: { items: [], total: 0 } };
      }
      // The log lists oldest first. Newest first lets bounding and fitting drop the oldest.
      return { operation: "receipts", scope: "application", failedOnly, logPresent: true, total: log.total,
        failed: log.failed, invalidLines: log.invalid_lines,
        records: { total: failedOnly ? log.failed : log.total, items: [...records].reverse().slice(0, READ_BOUNDS.items)
          .map(record => ({
            timestamp: stringOr(record.timestamp, "unknown time"),
            tool: stringOr(record.tool, "unknown tool"),
            command: stringOr(record.command, "unknown command"),
            ok: record.ok === true, exitCode: numberOrNull(record.exit_code), durationMs: numberOrNull(record.duration_ms),
            source: stringOr(record.receipt_source, null),
            ...(typeof record.error_type === "string" ? { errorType: record.error_type } : {}),
          })) } };
    },
  },
  review: {
    command: input => ({ verb: "review", pack: input.pack ?? "structure" }),
    report: (stdout, input) => {
      const parsed = outputs.review.safeParse(stdout);
      if (!parsed.success || parsed.data.pack !== (input.pack ?? "structure")) return null;
      const data = parsed.data;
      return { operation: "review", pack: data.pack, reviewed: data.reviewed, warnings: data.warnings, notes: data.notes,
        complete: data.complete,
        findings: bounded(data.findings.map(({ severity, rule, id, type, path, field }) =>
          ({ severity, rule, id, type, path, ...(field === undefined ? {} : { field }) }))),
        omissions: data.omissions.slice(0, READ_BOUNDS.items) };
    },
  },
  impact: {
    command: input => ({ verb: "impact", nodeId: input.nodeId! }),
    report: (stdout, input) => {
      const parsed = outputs.impact.safeParse(stdout);
      if (!parsed.success || parsed.data.target !== input.nodeId) return null;
      const data = parsed.data;
      return { operation: "impact", target: data.target, impacted: data.impacted, complete: data.complete,
        nodes: bounded(data.nodes.map(({ id, distance, via, type, path }) => ({ id, distance, via, type, path }))),
        omissions: data.omissions.slice(0, READ_BOUNDS.items) };
    },
  },
};

function json(stdout: string): unknown {
  try { return JSON.parse(stdout); } catch { return undefined; }
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Host paths never leave the server: the project root reads as `.` and the
// application data directory as `<app data>`. Python and the facade may spell
// a Windows path with forward slashes and a lowercase drive, so each path
// matches either separator in any case. Control characters become spaces,
// which also caps what one character costs in JSON, and a cut never splits a
// surrogate pair.
function textFor(hostPaths: { root: string; dataDir: string }): (value: string) => string {
  const replacements = [[hostPaths.root, "."], [hostPaths.dataDir, "<app data>"]]
    .sort((left, right) => right[0].length - left[0].length)
    .map(([hostPath, label]) => [new RegExp(hostPath.split(/[\\/]/).map(escapeRegExp).join("[\\\\/]"), "gi"), label] as const);
  return value => {
    const redacted = replacements.reduce((current, [pattern, label]) => current.replace(pattern, label), value)
      .replace(/\p{Cc}/gu, " ");
    if (redacted.length <= READ_BOUNDS.text) return redacted;
    const cut = redacted.slice(0, READ_BOUNDS.text - 1);
    return (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut) + "…";
  };
}

// Every string in a report passes through `text` here except a `path`, which
// must stay whole to link. Only check and review findings, find results, and
// impact nodes carry a `path`, and their output schemas accept only a
// project-relative one. A test pins that no other report field is named `path`.
function redacted<T>(value: T, text: (value: string) => string, key?: string): T {
  if (typeof value === "string") return (key === "path" ? value : text(value)) as T;
  if (Array.isArray(value)) return value.map(item => redacted(item, text)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redacted(item, text, name)])) as T;
  }
  return value;
}

function unavailable(project: ProjectRef, operation: ProjectReadOperation, reason: UnavailableReason): ProjectReadResult {
  return { status: "unavailable", project, operation, reason,
    message: operation === "find" && reason === "path_refused" ? FIND_PATH_REFUSED : UNAVAILABLE[reason] };
}

// Lists shrink from their longest until the pretty result fits the tool's
// result limit, so a truncated string never reaches the model. Totals stay true.
function fitted(project: ProjectRef, report: ProjectReadReport): ProjectReadResult {
  const result: ProjectReadResult = { status: "reported", project, notice: NOTICE, report };
  const lists = Object.values(report).filter((value): value is Bounded<unknown> =>
    typeof value === "object" && value !== null && "items" in value && "total" in value);
  while (lists.length > 0 && JSON.stringify(result, null, 2).length > PROJECT_READ_MAX_RESULT_CHARS) {
    const longest = lists.reduce((left, right) => right.items.length > left.items.length ? right : left);
    if (longest.items.length === 0) break;
    longest.items.pop();
  }
  return result;
}

async function read(run: typeof runProjectRead, context: ActionRunContext | undefined, projectId: string,
  input: ProjectReadToolInput): Promise<ProjectReadResult> {
  const operation = operations[input.operation];
  const output = await run(projectId, operation.command(input), context);
  if ("failure" in output) return unavailable(output.project, input.operation, RUN_FAILURES[output.failure]);
  const stdout = json(output.stdout);
  const refused = refusal.safeParse(stdout);
  if (refused.success) return unavailable(output.project, input.operation, refused.data.reason);
  const report = operation.report(stdout, input);
  return report
    ? fitted(output.project, redacted(report, textFor(output.hostPaths)))
    : unavailable(output.project, input.operation, "unreadable_output");
}

/**
 * The project reads behind the Details panel and the Native agent tool. Both
 * return the same result: access refusals throw, and whether the original
 * command produced a report is part of the value.
 */
export function createProjectRead(dependencies: {
  run: typeof runProjectRead;
  chatProject: (context: ActionRunContext | undefined) => Promise<{ projectId: string; projectContext: ActionRunContext }>;
} = { run: runProjectRead, chatProject: resolveNativeChatProject }) {
  return {
    forOwner: (context: ActionRunContext | undefined, { projectId, ...input }: ProjectReadOwnerInput) =>
      read(dependencies.run, context, projectId, input),
    forChat: async (context: ActionRunContext | undefined, input: ProjectReadToolInput) => {
      const { projectId, projectContext } = await dependencies.chatProject(context);
      return read(dependencies.run, projectContext, projectId, input);
    },
  };
}

export const projectRead = createProjectRead();
