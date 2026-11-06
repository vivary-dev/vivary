import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fail, type ActionRunContext } from "@agent-native/core/action";
import { getSetting, mutateSetting, deleteSettingIfValue } from "@agent-native/core/settings";
import { z } from "zod";
import { workspacePatternChoices } from "../shared/workspace-patterns.ts";
import { adoptionDigest, adoptionInput, adoptionPreset, adoptionReport, adoptionRecoveryReport, adoptionPrivacyRequest,
  type AdoptionInput, type AdoptionResult } from "../shared/project-adoption";
import { resolveLocalProjectWorkspace } from "./project-services.mjs";
import { runOriginalCommand, runAdoptionCommand, sameOriginalWorkspace } from "./original-runtime";

const workspaceSchema = z.strictObject({
  root: z.string(), label: z.string(), actorId: z.string(), projectId: z.string(),
  rootId: z.string(), bindingId: z.string(), locationRef: z.string(),
  bindingRevision: z.number().int().positive(), policyRevision: z.number().int().positive(),
  verificationKind: z.literal("local-stat-revalidated-v1"),
});
const common = {
  version: z.literal(1), operationId: z.string().uuid(), orgId: z.string(),
  dispatchId: z.string().uuid().optional(),
  workspace: workspaceSchema, preset: adoptionPreset,
  patternChoices: workspacePatternChoices.optional(), planHash: adoptionDigest,
  createdAt: z.number(), report: adoptionReport,
};
const savedSchema = z.discriminatedUnion("stage", [
  z.strictObject({ ...common, stage: z.literal("review") }),
  z.strictObject({ ...common, stage: z.literal("approved") }),
  z.strictObject({ ...common, stage: z.literal("privacy-approved") }),
  z.strictObject({ ...common, stage: z.literal("privacy-completed"), replayed: z.boolean() }),
  z.strictObject({ ...common, stage: z.literal("completed"), replayed: z.boolean() }),
  z.strictObject({ ...common, stage: z.literal("rejected"), message: z.string() }),
  z.strictObject({ ...common, stage: z.literal("recovery-review"), recovery: adoptionRecoveryReport }),
  z.strictObject({ ...common, stage: z.literal("recovery-approved"), recovery: adoptionRecoveryReport }),
  z.strictObject({ ...common, stage: z.literal("recovered") }),
]);
type Saved = z.infer<typeof savedSchema>;
const recordBase = (record: Saved) => z.object(common).parse(record);
const hash = (value: unknown) => "sha256:" + createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pendingMessage = "The previous request may have written files. Retry that request to check completion, or review recovery. Do not delete its recovery records.";
function refuse(message: string): never {
  return fail(message, { statusCode: 409, errorCode: "vivary_adoption_refused" });
}
const unresolved = (record: Saved) => ["approved", "privacy-approved", "recovery-review", "recovery-approved"].includes(record.stage);
const privacyPendingMessage = "The ignore-file change could not be confirmed. Retry this same request. If the folder or ignore rules changed, restore the reviewed state before retrying. Setup has not been approved.";

function present(record: Saved): AdoptionResult {
  if (record.stage === "privacy-completed") return { code: "privacy-prepared", projectId: record.workspace.projectId, replayed: record.replayed };
  if (record.stage === "completed") return { code: "applied", projectId: record.workspace.projectId, replayed: record.replayed };
  if (record.stage === "recovered") return { code: "recovered", projectId: record.workspace.projectId };
  if (record.stage === "rejected") return { code: "refused", message: record.message };
  const review = { projectId: record.workspace.projectId, operationId: record.operationId,
    planHash: record.planHash, displayName: record.workspace.label, folder: record.workspace.root,
    preset: record.preset, patternChoices: record.patternChoices, report: record.report };
  if (record.stage === "privacy-approved") return { code: "privacy-pending", ...review, message: privacyPendingMessage };
  if (record.stage === "recovery-review" || record.stage === "recovery-approved") {
    return { code: "recovery-preview", ...review, recovery: record.recovery, approved: record.stage === "recovery-approved" };
  }
  return record.stage === "review" ? { code: "preview", ...review }
    : { code: "pending", ...review, message: pendingMessage };
}

function parseOutput(output: Awaited<ReturnType<typeof runOriginalCommand>>): unknown {
  try { return JSON.parse(output.stdout); }
  catch { return null; }
}
const creatorError = z.object({ ok: z.literal(false), error: z.string() });
const preMutationRefusal = creatorError.extend({
  attempt_status: z.literal("refused_before_mutation"), root: z.string(),
  plan_hash: adoptionDigest, request_id: z.string().uuid(),
});
const completed = z.object({ ok: z.literal(true), mode: z.literal("applied"), root: z.string(),
  plan_hash: adoptionDigest, request_id: z.string().uuid(), replayed: z.boolean() });
const privacyPrepared = completed.extend({ mode: z.literal("privacy-prepared") });
const recovered = z.object({ ok: z.literal(true), mode: z.literal("recovered"), root: z.string(),
  plan_hash: adoptionDigest, recovery_plan_hash: adoptionDigest, recovered: z.literal(true) });

export function createProjectAdoptionService(dependencies = {
  resolveWorkspace: resolveLocalProjectWorkspace, preview: runOriginalCommand, execute: runAdoptionCommand,
  get: getSetting, mutate: mutateSetting, remove: deleteSettingIfValue,
}) {
  // Native settings serialize state; the creator owns cross-process filesystem exclusion.
  const active = new Set<string>();
  return async (raw: AdoptionInput, context?: ActionRunContext): Promise<AdoptionResult> => {
    const input = adoptionInput.parse(raw);
    if (!context?.userEmail || !context.orgId || !["http", "frontend"].includes(context.caller)) {
      return fail("Only the workspace owner can review and approve setup.", { statusCode: 403 });
    }
    const workspace = await dependencies.resolveWorkspace(context, input.projectId);
    const key = "vivary-private:adoption-v1:" + hash([context.orgId, workspace.actorId, input.projectId]);
    if (active.has(key)) return refuse("Setup is already running for this project. Wait, then retry the same request.");
    active.add(key);
    try {
      let stored = await dependencies.get(key, { bypassCache: true });
      let previous = stored === null ? null : savedSchema.parse(stored);
      if (previous && stored !== null && (previous.orgId !== context.orgId || !sameOriginalWorkspace(previous.workspace, workspace))) {
        if (unresolved(previous)) {
          return refuse("An approved setup belongs to an earlier folder connection. Its result must be resolved before setting up this connection. Recovery records have been preserved.");
        }
        if (!await dependencies.remove(key, stored)) refuse("The setup request changed. Reopen it.");
        stored = null;
        previous = null;
      }
      if (input.operation === "resume") return previous ? present(previous) : { code: "idle" };
      async function currentWorkspace() {
        const current = await dependencies.resolveWorkspace(context, input.projectId);
        if (!sameOriginalWorkspace(current, workspace)) refuse("Project access changed. Review the folder again.");
        return current;
      }
      if (input.operation === "preview") {
        if (input.patternChoices && input.preset !== "auto") {
          return refuse("Guidance changes keep the installed workspace type. Review them with automatic type.");
        }
        if (previous && unresolved(previous)) return present(previous);
        const output = await dependencies.preview({ projectId: input.projectId,
          command: { verb: "adopt",
            ...(input.patternChoices ? { patternChoices: input.patternChoices }
              : input.preset === "auto" ? {} : { preset: input.preset }) } }, context);
        const value = parseOutput(output);
        const parsed = adoptionReport.safeParse(value);
        if (!parsed.success || output.exitCode === null || ![0, 1].includes(output.exitCode)) {
          const error = creatorError.safeParse(value);
          return { code: "refused", message: error.success ? error.data.error
            : "The runtime did not return a complete setup preview. Update the runtime and try again." };
        }
        const report = parsed.data;
        await currentWorkspace();
        if (report.root !== workspace.root) refuse("The preview returned another folder.");
        const record: Saved = { version: 1, stage: "review", operationId: randomUUID(),
          orgId: context.orgId, workspace, preset: input.preset,
          patternChoices: input.patternChoices,
          createdAt: Date.now(), report,
          planHash: hash({ orgId: context.orgId, workspace, preset: input.preset,
            patternChoices: input.patternChoices, report }) };
        await dependencies.mutate(key, current => {
          if (!isDeepStrictEqual(current, stored)) refuse("The setup review changed. Reopen it.");
          return record;
        });
        return present(record);
      }
      if (!previous || previous.operationId !== input.operationId || previous.planHash !== input.acceptedPlanHash
        || previous.orgId !== context.orgId || !sameOriginalWorkspace(previous.workspace, workspace)) {
        return refuse("This approval does not match the current project and preview. Review the folder again.");
      }
      let record = previous;
      async function save(next: Saved) {
        await currentWorkspace();
        await dependencies.mutate(key, current => {
          if (!isDeepStrictEqual(current, record)) refuse("The setup request changed. Reopen it.");
          return next;
        });
        record = next;
      }
      if (input.operation === "cancel") {
        if (record.stage !== "review") refuse("An approved request cannot be cancelled. Check its result or recovery.");
        if (!await dependencies.remove(key, stored ?? record)) refuse("The setup request changed. Reopen it.");
        return { code: "idle" };
      }
      if (input.operation === "prepare-privacy") {
        const firstAttempt = record.stage === "review";
        if (record.stage === "privacy-completed" || record.stage === "rejected") return present(record);
        if (!firstAttempt && record.stage !== "privacy-approved") refuse("Resolve the existing setup request before preparing privacy.");
        const preparation = record.report.privacy_preparation;
        if (!preparation?.required || !preparation.ready || record.report.conflicts.length > 0) {
          refuse(preparation?.reason ?? "This preview does not authorize privacy preparation. Review the folder again.");
        }
        const privacyRequest = adoptionPrivacyRequest.parse({ schema: "vivary.adopt-privacy-request.v1",
          root_hash: preparation.root_hash, before_hash: preparation.before_hash, after_hash: preparation.after_hash });
        if (firstAttempt) {
          if (Date.now() - record.createdAt > 30 * 60_000) refuse("This preview expired. Prepare a new preview.");
          await save({ ...recordBase(record), stage: "privacy-approved", dispatchId: randomUUID() });
        } else {
          await save({ ...record, dispatchId: randomUUID() });
        }
        const output = await dependencies.execute({ verb: "adopt-prepare-privacy", planHash: record.report.plan_hash,
          requestId: record.operationId, privacyRequest, ...(record.preset === "auto" ? {} : { preset: record.preset }) }, workspace, context);
        const value = parseOutput(output);
        const result = privacyPrepared.safeParse(value);
        if (output.exitCode === 0 && result.success && result.data.root === workspace.root
          && result.data.plan_hash === record.report.plan_hash && result.data.request_id === record.operationId) {
          await save({ ...recordBase(record), stage: "privacy-completed", replayed: result.data.replayed });
          return present(record);
        }
        const refusal = preMutationRefusal.safeParse(value);
        if (firstAttempt && refusal.success && refusal.data.root === workspace.root
          && refusal.data.plan_hash === record.report.plan_hash && refusal.data.request_id === record.operationId) {
          await save({ ...recordBase(record), stage: "rejected", message: "The folder or privacy inputs changed. Prepare a new preview." });
          return present(record);
        }
        const error = creatorError.safeParse(value);
        const pending = present(record);
        if (pending.code !== "privacy-pending") refuse("The privacy preparation request changed. Reopen it.");
        return { ...pending, message: error.success ? `${error.data.error}. ${privacyPendingMessage}` : privacyPendingMessage };
      }
      if (record.stage === "privacy-approved" || record.stage === "privacy-completed") {
        return refuse("Finish privacy preparation, then review a new setup plan before applying setup.");
      }
      if (input.operation === "apply") {
        if (record.stage === "recovery-approved" || record.stage === "recovered") {
          return refuse("Recovery was approved. Finish recovery before preparing a new setup plan.");
        }
        const firstAttempt = record.stage === "review";
        if (firstAttempt) {
          if (Date.now() - record.createdAt > 30 * 60_000) refuse("This preview expired. Prepare a new preview.");
          if (!record.report.request_replay.ready || record.report.conflicts.length > 0) {
            return refuse(record.report.request_replay.reason ?? "Resolve the setup conflicts before applying.");
          }
          await save({ ...recordBase(record), stage: "approved", dispatchId: randomUUID() });
        } else if (record.stage !== "rejected") {
          await save({ ...record, dispatchId: randomUUID() });
        }
        if (record.stage === "rejected") return present(record);
        const output = await dependencies.execute({ verb: "adopt-apply", planHash: record.report.plan_hash,
          requestId: record.operationId,
          ...(record.patternChoices ? { patternChoices: record.patternChoices }
            : record.preset === "auto" ? {} : { preset: record.preset }) }, workspace, context);
        const value = parseOutput(output);
        const result = completed.safeParse(value);
        if (output.exitCode === 0 && result.success && result.data.root === workspace.root
          && result.data.plan_hash === record.report.plan_hash && result.data.request_id === record.operationId) {
          await save({ ...recordBase(record), stage: "completed", replayed: result.data.replayed });
          return present(record);
        }
        const error = creatorError.safeParse(value);
        const refusal = preMutationRefusal.safeParse(value);
        if (firstAttempt && refusal.success && refusal.data.root === workspace.root
          && refusal.data.plan_hash === record.report.plan_hash && refusal.data.request_id === record.operationId) {
          const message = refusal.data.error.startsWith("plan hash mismatch:")
            ? "The folder or setup inputs changed. Prepare a new preview."
            : `${refusal.data.error}. Prepare a new preview.`;
          await save({ ...recordBase(record), stage: "rejected", message });
          return present(record);
        }
        return { ...presentPending(record), message: error.success ? `${error.data.error}. ${pendingMessage}` : pendingMessage };
      }
      if (!unresolved(record)) return refuse("There is no incomplete approved setup request to recover.");
      if (input.operation === "preview-recovery") {
        const output = await dependencies.execute({ verb: "adopt-recovery-preview", transactionHash: record.report.plan_hash, requestId: record.operationId }, workspace, context);
        const value = parseOutput(output);
        const result = adoptionRecoveryReport.safeParse(value);
        if (output.exitCode !== 0 || !result.success) {
          const error = creatorError.safeParse(value);
          return { ...presentPending(record), message: error.success ? `${error.data.error}. ${pendingMessage}` : pendingMessage };
        }
        if (result.data.root !== workspace.root || result.data.plan_hash !== record.report.plan_hash) refuse("Recovery returned another transaction.");
        await save({ ...recordBase(record), stage: record.stage === "recovery-approved" ? "recovery-approved" : "recovery-review", recovery: result.data });
        return present(record);
      }
      if (record.stage !== "recovery-review" && record.stage !== "recovery-approved") refuse("Review recovery before confirming it.");
      const recovery = record.recovery;
      if (input.operation !== "recover" || input.acceptedRecoveryHash !== recovery.recovery_plan_hash) {
        return refuse("The recovery preview changed. Review it again before confirming.");
      }
      await save({ ...recordBase(record), stage: "recovery-approved", recovery });
      const output = await dependencies.execute({ verb: "adopt-recover", transactionHash: record.report.plan_hash, requestId: record.operationId,
        planHash: recovery.recovery_plan_hash }, workspace, context);
      const result = recovered.safeParse(parseOutput(output));
      if (output.exitCode !== 0 || !result.success || result.data.root !== workspace.root
        || result.data.plan_hash !== record.report.plan_hash || result.data.recovery_plan_hash !== recovery.recovery_plan_hash) {
        return { ...presentPending(record), message: "Recovery could not be confirmed. Review recovery again; no completed setup should be undone." };
      }
      await save({ ...recordBase(record), stage: "recovered" });
      return present(record);
    } finally { active.delete(key); }
  };
}

function presentPending(record: Saved): Extract<AdoptionResult, { code: "pending" }> {
  return { code: "pending", projectId: record.workspace.projectId, operationId: record.operationId,
    planHash: record.planHash, displayName: record.workspace.label, folder: record.workspace.root,
    preset: record.preset, report: record.report, message: pendingMessage };
}
export const projectAdoptionService = createProjectAdoptionService();
