// Prepare handoff (A083) and handoff freshness (A084). The agent writes the
// narrative as one fenced reply in its own conversation. Vivary validates that
// reply, fills every fact itself, and writes one marked block at the end of the
// project's designated state document through the conflict-aware file owner.
// Freshness compares recorded versions on request. It runs no timer and calls
// no model.
import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { fail, type ActionRunContext } from "@agent-native/core/action";
import { getDbExec } from "@agent-native/core/db";
import { z } from "zod";
import type { ProjectFileIdentity } from "../app/lib/project-file-schema.ts";
import { redactCredentialsInValue, refreshHeldCredentials } from "./credential-redaction";
import { conversationReferenceSchema, linkedConversations } from "./linked-conversations";
import { observeProjectVersion } from "./managed-projects.mjs";
import { projectFileService, sameProject } from "./project-files";
import { projectMemory, type StateDocument } from "./project-memory";
import type { HistoryItem } from "./linked-history";
import type { ConversationReference } from "../shared/linked-conversation";
import type { HandoffCheck, HandoffFacts, HandoffFreshness, HandoffInput, HandoffPrepareResult, HandoffProposal,
  HandoffRecord, HandoffSaveInput, HandoffSaveResult, HandoffUnavailable, ProjectVersion, StaleReason } from "../shared/handoff";

const BLOCK_START = "<!-- vivary:handoff -->";
const BLOCK_END = "<!-- /vivary:handoff -->";
/** The delivered request carries this marker, so Save finds it in the conversation. */
const REQUEST_MARKER = "vivary-handoff-request:";
const OFFERED_EVIDENCE = 20;

type Observation = { kind: "plain" } | { kind: "unknown" }
  | { kind: "git"; head: string | null; ref: string | null; entries: Array<{ path: string; state: string }> | null };
type Ready = Extract<StateDocument, { status: "ready" }>;
type Dependencies = {
  conversations: Pick<typeof linkedConversations, "scope" | "record" | "load" | "completedPrefix" | "progression" | "linkFor">;
  state: (context: ActionRunContext | undefined, projectId: string) => Promise<StateDocument>;
  files: Pick<typeof projectFileService, "get" | "save">;
  observe: (workspace: { projectId: string; root: string }) => Promise<Observation>;
  now: () => Date;
};
const defaults: Dependencies = {
  conversations: linkedConversations,
  state: (context, projectId) => projectMemory.stateDocument(context, projectId),
  files: projectFileService,
  observe: workspace => observeProjectVersion(workspace),
  now: () => new Date(),
};

const field = z.string().trim().min(1).max(2_000);
const items = z.array(field).min(1).max(50);
const proposalSchema = z.strictObject({
  requestId: z.string(), goal: field, decisions: items, changes: items,
  checks: z.array(z.strictObject({ name: field, outcome: z.enum(["passed", "failed", "not-run"]),
    evidenceEventId: z.string().min(1).max(128).nullable() })).min(1).max(50),
  unfinished: items, risks: items, nextAction: field,
});
const requestSchema = z.strictObject({
  requestId: z.string().uuid(), conversation: conversationReferenceSchema, documentVersion: z.string(),
  project: z.custom<ProjectFileIdentity>(value => typeof value === "object" && value !== null),
  state: z.enum(["pending", "failed"]), message: z.string().nullable(),
  /** A failed write can succeed for the same request. A conflict or damaged marker cannot. */
  retryable: z.boolean().optional(),
  /** The project version observed at Prepare, which the agent's reply describes. */
  version: z.custom<ProjectVersion>(value => typeof value === "object" && value !== null).optional(),
});
const rowSchema = z.strictObject({
  version: z.literal(1), owner: z.string(), orgId: z.string(), projectId: z.string(), bindingId: z.string(), path: z.string(),
  request: requestSchema.nullable(),
  saved: z.custom<HandoffRecord>(value => typeof value === "object").nullable(),
});
type Row = z.infer<typeof rowSchema>;

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sameReference = (left: ConversationReference, right: ConversationReference) => left.kind === right.kind && left.id === right.id;
// Model text never opens or closes an HTML comment, so it cannot recreate a block
// marker, and never spans lines in a list item. Stripping repeats because one
// pass can join the leftover characters into a new marker.
function clean(value: string): string {
  let text = value, previous;
  do { previous = text; text = text.replace(/<!--|--!?>/g, ""); } while (text !== previous);
  return text.replace(/\s+/g, " ").trim();
}

function unavailable(document: Exclude<StateDocument, { status: "ready" }>): HandoffUnavailable {
  const file = document.path ?? "STATE.md";
  const message = {
    "no-state-role": "This project has no designated state document. Prepare handoff writes to the state file, such as STATE.md, that a Vivary workspace names in .vivary/workspace.toml.",
    "state-missing": `The designated state document ${file} does not exist. Create it, then prepare the handoff.`,
    "state-uneditable": `The designated state document ${file} ${document.reason === "state-uneditable" ? {
      "too-large": "is too large for editing", binary: "is not a text file", linked: "is linked", unsupported: "has an unsupported file type",
      unreadable: "could not be read as an editable file",
    }[document.blockedReason] : "cannot be edited"}. Inspect it in Files or your editor, then check again.`,
    "state-private": `The designated state document ${file} is private or protected, so Vivary does not write a handoff there.`,
    "settings-unavailable": "Vivary could not read this project's workspace settings, so it cannot find the state document.",
  }[document.reason];
  return { status: "unavailable", reason: document.reason, message };
}

export function versionLine(project: ProjectVersion, file: string): string {
  if (project.kind === "plain") return "Not a Git repository. Vivary compares the project file listing.";
  if (project.kind === "unknown") return "Project version unknown.";
  const where = `Git commit ${project.head ?? "none yet"} on ${project.ref ? `branch ${project.ref}` : "a detached HEAD"}.`;
  if (project.dirty === null) return `${where} Working tree state unknown.`;
  if (!project.dirty) return `${where} Clean working tree besides ${file}.`;
  return `${where} Dirty working tree: ${project.dirtyCount} ${project.dirtyCount === 1 ? "entry" : "entries"} besides ${file}.`;
}

function requestMessage(requestId: string, file: string, project: ProjectVersion, history: HistoryItem[]): string {
  const evidence = history.filter(item => item.role !== "User").slice(-OFFERED_EVIDENCE)
    .map(item => `- ${item.id}: ${String(redactCredentialsInValue(clean(item.text))).slice(0, 100)}`);
  return [
    `Prepare handoff (${REQUEST_MARKER}${requestId})`,
    "",
    "Review the actual project and this conversation. Then reply with exactly one fenced code block whose info string is vivary-handoff. It holds one JSON object with exactly these keys:",
    `- requestId: "${requestId}"`,
    "- goal: one sentence.",
    "- decisions, changes, unfinished, risks: non-empty arrays of short strings. Write \"None\" when there is nothing to report.",
    "- checks: a non-empty array of objects with name, outcome and evidenceEventId. outcome is passed, failed or not-run. A passed or failed check names the ID of the completed conversation event that shows its result. A not-run check uses null.",
    "- nextAction: the next concrete action.",
    "",
    `Do not edit ${file} yourself, and do not clean, stash, commit or discard anything. Vivary writes the handoff at the end of ${file} when the owner clicks Save handoff, and adds the facts it records:`,
    versionLine(project, file),
    "",
    evidence.length ? "Recent completed events you can cite:" : "This conversation has no completed events to cite yet.",
    ...evidence,
  ].join("\n");
}

/**
 * The completed agent text after the request, up to the next user message.
 * `continued` means a later user message follows, so the completed history
 * already holds work the reply does not describe.
 */
function replyTo(history: HistoryItem[], requestId: string): { text: string; continued: boolean } | null {
  const index = history.findIndex(item => item.role === "User" && item.text.includes(REQUEST_MARKER + requestId));
  if (index < 0) return null;
  const reply: string[] = [];
  let continued = false;
  for (const item of history.slice(index + 1)) {
    if (item.role === "User") { continued = true; break; }
    if (item.role === "Assistant") reply.push(item.text);
  }
  return reply.length ? { text: reply.join("\n\n"), continued } : null;
}

function proposalFrom(reply: string, requestId: string, history: HistoryItem[]): { proposal: HandoffProposal } | { problems: string[] } {
  const blocks = [...reply.matchAll(/```vivary-handoff[^\S\n]*\n([\s\S]*?)\n```/g)];
  if (blocks.length !== 1) return { problems: [blocks.length
    ? "The reply has more than one vivary-handoff block. It must have exactly one."
    : "The reply has no vivary-handoff block."] };
  let value: unknown;
  try { value = JSON.parse(blocks[0][1]); } catch { return { problems: ["The vivary-handoff block is not valid JSON."] }; }
  const parsed = proposalSchema.safeParse(value);
  if (!parsed.success) return { problems: parsed.error.issues.map(issue => `${issue.path.join(".") || "block"}: ${issue.message}`) };
  const problems: string[] = [];
  if (parsed.data.requestId !== requestId) problems.push(`requestId: The block names a different request. Use ${requestId}.`);
  const events = new Set(history.map(item => item.id));
  parsed.data.checks.forEach((check: HandoffCheck, index) => {
    const at = `checks.${index}.evidenceEventId`;
    if (check.outcome === "not-run") {
      if (check.evidenceEventId !== null) problems.push(`${at}: A not-run check names no evidence. Use null.`);
    } else if (!check.evidenceEventId) problems.push(`${at}: A ${check.outcome} check names the completed event that shows its result.`);
    else if (!events.has(check.evidenceEventId)) problems.push(`${at}: Event ${check.evidenceEventId} is not a completed event in this conversation.`);
  });
  return problems.length ? { problems } : { proposal: parsed.data };
}

function renderBlock(record: HandoffRecord): string {
  const { facts } = record, list = (values: string[]) => values.map(value => `- ${clean(value)}`).join("\n");
  const linked = facts.linked ? [`**Linked source:** ${facts.linked.source.kind} conversation ${facts.linked.source.id}, completed event ${facts.linked.boundaryId ?? "none"}.`, ""] : [];
  return [BLOCK_START, "## Handoff", "",
    `Saved by Vivary at ${record.savedAt} from ${facts.conversation.ref.kind} conversation ${facts.conversation.ref.id}, through completed event ${facts.conversation.boundaryId ?? "none"}. Request ${record.requestId}.`, "",
    `**Goal:** ${clean(record.goal)}`, "",
    `**Project version:** ${versionLine(facts.project, facts.path)}`, "",
    "**Decisions**", "", list(record.decisions), "",
    "**Changes**", "", list(record.changes), "",
    "**Checks**", "", record.checks.map(check => `- ${check.outcome}: ${clean(check.name)}${check.evidenceEventId ? ` (event ${clean(check.evidenceEventId)})` : ""}`).join("\n"), "",
    "**Unfinished work**", "", list(record.unfinished), "",
    "**Risks**", "", list(record.risks), "",
    ...linked,
    `**Next action:** ${clean(record.nextAction)}`,
    BLOCK_END].join("\n");
}

const appendBlock = (content: string, block: string) =>
  content + (content === "" ? "" : content.endsWith("\n") ? "\n" : "\n\n") + block + "\n";

/**
 * Keep the one marked block at the end of the document. A block that is
 * already last is replaced in place. When text was added after it, the old
 * block and the line break that ended it are removed, that text stays where it
 * is, and the new block is appended. Every other byte stays. null means
 * damaged markers.
 */
function placeBlock(content: string, block: string): string | null {
  const starts = content.split(BLOCK_START).length - 1, ends = content.split(BLOCK_END).length - 1;
  if (!starts && !ends) return appendBlock(content, block);
  const start = content.indexOf(BLOCK_START), end = content.indexOf(BLOCK_END);
  if (starts !== 1 || ends !== 1 || end < start) return null;
  const before = content.slice(0, start), after = content.slice(end + BLOCK_END.length);
  if (after.trim() === "") return before + block + after;
  return appendBlock(before + after.replace(/^\r?\n/, ""), block);
}

function compareProject(saved: ProjectVersion, current: ProjectVersion): { reasons: StaleReason[]; verifiable: boolean } {
  if (saved.kind === "unknown" || current.kind === "unknown") return { reasons: [], verifiable: false };
  if (saved.kind !== current.kind) return { reasons: ["tree-changed"], verifiable: true };
  const reasons: StaleReason[] = [];
  if (saved.head !== current.head || saved.ref !== current.ref) reasons.push("head-moved");
  if (saved.kind === "git" && (saved.dirty === null || current.dirty === null)) return { reasons, verifiable: false };
  if (saved.dirtyDigest !== current.dirtyDigest) reasons.push("tree-changed");
  if (saved.filesDigest !== current.filesDigest) reasons.push("files-changed");
  return { reasons, verifiable: !saved.truncated && !current.truncated };
}

export function createHandoffService(overrides: Partial<Dependencies> = {}) {
  const dependencies = { ...defaults, ...overrides };
  const { conversations } = dependencies;

  async function readRow(document: Ready, owner: string, orgId: string): Promise<Row | null> {
    const { rows } = await getDbExec().execute({ sql: "SELECT record_json FROM vivary_handoff_records WHERE project_id = ? AND binding_id = ? AND path = ?",
      args: [document.project.projectId, document.project.bindingId, document.path] });
    if (!rows.length) return null;
    const row = rowSchema.parse(JSON.parse(String(rows[0].record_json)));
    if (row.owner !== owner || row.orgId !== orgId) fail("This project's handoff belongs to another owner.", { statusCode: 403 });
    return row;
  }
  async function writeRow(row: Row): Promise<void> {
    await getDbExec().execute({ sql: `INSERT INTO vivary_handoff_records (project_id, binding_id, path, record_json) VALUES (?, ?, ?, ?)
      ON CONFLICT (project_id, binding_id, path) DO UPDATE SET record_json = excluded.record_json`,
    args: [row.projectId, row.bindingId, row.path, JSON.stringify(row)] });
  }

  /** The verified owner, conversation and designated document, in that order. */
  async function open(context: ActionRunContext | undefined, input: HandoffInput) {
    const identity = await conversations.scope(context, input.projectId);
    const record = await conversations.record(input.conversation, identity);
    // A linked target is checked as every linked read checks it. An unfinished or mismatched link refuses.
    await conversations.load(context, input.projectId, input.conversation);
    const document = await dependencies.state(context, input.projectId);
    if (document.status === "ready" && (identity.history?.bindingId !== document.project.bindingId
      || identity.history?.rootId !== document.project.rootId)) fail("The project changed. Retry.", { statusCode: 409 });
    return { identity, record, document };
  }

  async function projectVersion(context: ActionRunContext | undefined, document: Ready): Promise<ProjectVersion> {
    const none = { head: null, ref: null, dirty: null, dirtyCount: 0, dirtyDigest: "", filesDigest: "", truncated: false };
    const observed = await dependencies.observe(document.workspace).catch((): Observation => ({ kind: "unknown" }));
    if (observed.kind === "unknown") return { ...none, kind: "unknown" };
    if (observed.kind === "git") {
      if (!observed.entries) return { ...none, kind: "git", head: observed.head, ref: observed.ref };
      const entries = observed.entries.filter(entry => entry.path !== document.path)
        .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
      // Metadata only. A changed size or modified time of an already-dirty file is a new version.
      // The observer refuses a directory entry, such as Git's single entry for a new untracked
      // directory, so a project holding one has no entries here and reads Unverifiable, never Fresh.
      const files = await Promise.all(entries.map(async entry => {
        const info = await lstat(path.join(document.workspace.root, entry.path)).catch(() => null);
        return [entry.path, info ? [info.size, info.mtimeMs] : null];
      }));
      return { kind: "git", head: observed.head, ref: observed.ref, dirty: entries.length > 0, dirtyCount: entries.length,
        dirtyDigest: digest(entries), filesDigest: digest(files), truncated: false };
    }
    const listing = await dependencies.files.get(context, document.project.projectId);
    if (listing.code !== "listing") return { ...none, kind: "unknown" };
    return { ...none, kind: "plain", truncated: listing.truncated,
      filesDigest: digest(listing.files.filter(file => file.path !== document.path).map(file => [file.path, file.sizeBytes, file.updatedAt])) };
  }

  async function conversationReasons(context: ActionRunContext | undefined, projectId: string, identity: Awaited<ReturnType<typeof conversations.scope>>, covered: HandoffFacts["conversation"]): Promise<StaleReason[]> {
    try {
      const record = await conversations.record(covered.ref, identity);
      const at = await conversations.completedPrefix(covered.ref, record, covered.boundaryId, covered.boundaryBytes);
      if (at.digest !== covered.prefixDigest) return ["history-changed"];
      const current = await conversations.progression(context, projectId, covered.ref, covered.boundaryId);
      // Older records did not observe stopped, failed or live trailing turns, so they cannot establish Fresh.
      if (!covered.progressionDigest) return ["history-changed"];
      return current.digest !== covered.progressionDigest ? ["events-appended"] : [];
    } catch { return ["history-changed"]; }
  }

  return {
    /** Gather facts, record one pending request per document, and return the message for this conversation. Writes no project file. */
    async prepare(context: ActionRunContext | undefined, input: HandoffInput): Promise<HandoffPrepareResult> {
      const { identity, record, document } = await open(context, input);
      if (document.status !== "ready") return unavailable(document);
      const existing = await readRow(document, identity.owner, identity.orgId);
      const prefix = await conversations.completedPrefix(input.conversation, record);
      const progression = await conversations.progression(context, input.projectId, input.conversation, prefix.boundaryId);
      const project = await projectVersion(context, document);
      const requestId = randomUUID();
      await refreshHeldCredentials();
      const facts: HandoffFacts = { requestId, path: document.path, documentVersion: document.file.version, project,
        conversation: { ref: input.conversation, boundaryId: prefix.boundaryId, boundaryBytes: prefix.boundaryBytes, prefixDigest: prefix.digest, progressionDigest: progression.digest },
        linked: await conversations.linkFor(input.conversation) };
      await writeRow({ version: 1, owner: identity.owner, orgId: identity.orgId, projectId: document.project.projectId,
        bindingId: document.project.bindingId, path: document.path, saved: existing?.saved ?? null,
        request: { requestId, conversation: input.conversation, documentVersion: document.file.version, project: document.project,
          state: "pending", message: null, version: project } });
      return { code: "prepared", requestId, facts, message: requestMessage(requestId, document.path, project, prefix.items) };
    },

    /**
     * Validate the agent's completed reply from the conversation itself, then
     * write through the file owner. A refused reply changes nothing. A conflict
     * marks the request failed. A failed write is retryable only when an authorized
     * reread confirms the original file version and binding. Unknown write outcomes
     * and conflicts require inspection and a new Prepare.
     */
    async save(context: ActionRunContext | undefined, input: HandoffSaveInput): Promise<HandoffSaveResult> {
      const { identity, record, document } = await open(context, input);
      if (document.status !== "ready") return unavailable(document);
      const row = await readRow(document, identity.owner, identity.orgId);
      const request = row?.request;
      if (!row || !request || request.requestId !== input.requestId || !sameReference(request.conversation, input.conversation))
        return { code: "refused", problems: ["This handoff request is not pending in this conversation. Prepare the handoff again."] };
      if (request.state === "failed" && !request.retryable)
        return { code: "refused", problems: ["This handoff request cannot be retried safely. Inspect the state document and prepare the handoff again."] };
      const prefix = await conversations.completedPrefix(input.conversation, record);
      const progression = await conversations.progression(context, input.projectId, input.conversation, prefix.boundaryId);
      const reply = replyTo(prefix.items, request.requestId);
      if (reply === null) return { code: "refused", problems: ["The agent has not finished replying to this handoff request in this conversation. Wait for its reply, then click Save handoff."] };
      // Completed history excludes trailing stopped, failed and active turns. Their user requests still count.
      if (reply.continued || progression.continued) return { code: "refused", problems: ["The conversation continued after the handoff reply, so the reply does not describe the newer work. Click Update handoff to prepare it again."] };
      const validated = proposalFrom(reply.text, request.requestId, prefix.items);
      if ("problems" in validated) return { code: "refused", problems: validated.problems };
      const failed = async <T extends HandoffSaveResult & { message: string }>(result: T, retryable = false): Promise<T> => {
        await writeRow({ ...row, request: { ...request, state: "failed", message: result.message, retryable } });
        return result;
      };
      const kept = `The previous version of ${document.path} is kept.`;
      const conflict = (reason: "changed" | "renamed-or-deleted" | "project-changed") => failed({ code: "conflict" as const, reason, message: {
        changed: `${document.path} changed after Prepare. Its current text is kept. Prepare the handoff again.`,
        "renamed-or-deleted": `${document.path} was renamed or deleted after Prepare. Prepare the handoff again.`,
        "project-changed": `The project folder binding changed after Prepare. ${kept} Prepare the handoff again.`,
      }[reason] });
      if (!sameProject(request.project, document.project)) return conflict("project-changed");
      if (document.file.version !== request.documentVersion) return conflict("changed");
      // A change while the agent replied is not in its narrative, so freshness reports it.
      const project = request.version ?? await projectVersion(context, document);
      await refreshHeldCredentials();
      const proposal = redactCredentialsInValue(validated.proposal) as HandoffProposal;
      const facts: HandoffFacts = { requestId: request.requestId, path: document.path, documentVersion: request.documentVersion, project,
        conversation: { ref: input.conversation, boundaryId: prefix.boundaryId, boundaryBytes: prefix.boundaryBytes, prefixDigest: prefix.digest, progressionDigest: progression.digest },
        linked: await conversations.linkFor(input.conversation) };
      const savedAt = dependencies.now().toISOString();
      const content = placeBlock(document.file.content, renderBlock({ ...proposal, facts, savedVersion: "", savedAt }));
      if (content === null) return failed({ code: "failed" as const,
        message: `${document.path} has damaged vivary:handoff markers. Fix or remove them by hand. ${kept}` });
      const uncertain = async (): Promise<HandoffSaveResult> => {
        const result = { code: "failed" as const,
          message: `Vivary could not confirm that the handoff was saved. ${document.path} may have changed. Inspect it in Files or your editor, then prepare the handoff again.` };
        // If record storage is also unavailable, the pending row/file version still prevent Fresh. Preserve the
        // truthful response even when the failure status itself cannot be recorded.
        try { return await failed(result); } catch { return result; }
      };
      let result;
      try {
        result = await dependencies.files.save(context, { projectId: document.project.projectId, path: document.path,
          expectedVersion: request.documentVersion, content, expectedProject: request.project });
      } catch {
        // The file owner can throw after its rename. Retry is safe only when a fresh authorized read proves that
        // the same binding still holds the exact original version. Matching handoff text alone never proves success.
        const current = await dependencies.state(context, input.projectId).catch(() => null);
        return current?.status === "ready" && sameProject(current.project, request.project) && current.file.version === request.documentVersion
          ? failed({ code: "failed" as const, message: `Vivary could not write ${document.path}. ${kept}` }, true)
          : uncertain();
      }
      if (result.code === "conflict") return conflict(result.reason);
      const saved: HandoffRecord = { ...proposal, facts, savedVersion: result.file.version, savedAt };
      try { await writeRow({ ...row, request: null, saved }); }
      catch { return uncertain(); }
      return { code: "saved", record: saved };
    },

    /** Compare the saved handoff with the current document, project and conversation. No timer or model is involved. */
    async freshness(context: ActionRunContext | undefined, input: HandoffInput): Promise<HandoffFreshness> {
      const { identity, document } = await open(context, input);
      if (document.status !== "ready") return unavailable(document);
      const row = await readRow(document, identity.owner, identity.orgId);
      if (row?.request?.state === "failed") return { status: "failed", requestId: row.request.requestId,
        conversation: row.request.conversation, message: row.request.message ?? "The handoff was not saved.",
        retryable: row.request.retryable === true, covered: row.saved };
      if (row?.request) return { status: "pending", requestId: row.request.requestId, conversation: row.request.conversation, covered: row.saved };
      if (!row?.saved) return { status: "none", path: document.path };
      const covered = row.saved;
      const reasons: StaleReason[] = [];
      if (document.file.version !== covered.savedVersion) reasons.push("document-edited");
      const project = compareProject(covered.facts.project, await projectVersion(context, document));
      reasons.push(...project.reasons, ...await conversationReasons(context, input.projectId, identity, covered.facts.conversation));
      return { status: reasons.length ? "out-of-date" : project.verifiable ? "fresh" : "unverifiable", covered, reasons };
    },
  };
}

export const handoffs = createHandoffService();
