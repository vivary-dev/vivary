import { createHash } from "node:crypto";
import path from "node:path";

import type { GovernedInput } from "../app/lib/project-evaluate-schema.ts";
import type { LocalProjectWorkspace } from "./project-services.mjs";

export type BoundActor = { kind: "human" | "agent"; id: string };
export type HostPaths = { root: string; dataDir: string };

const STRATO_REQUEST_SCHEMA = "vivary.strato-decision-request/v0";
const STRATO_POLICY_VERSION = "vivary.strato-policy/v0";
const EXO_REQUEST_SCHEMA = "vivary.exo-control-request/v0";
const AUTHORITY_CLASS = "contributor";

/**
 * "agent_" + sha256("vivary.native-agent/v1\0" + ownerActorId + "\0" + projectId), 70 ASCII bytes.
 * One id per owner and project, so claims survive across chats and never cross projects.
 */
export function projectAgentActorId(ownerActorId: string, projectId: string): string {
  return "agent_" + createHash("sha256")
    .update("vivary.native-agent/v1\0" + ownerActorId + "\0" + projectId).digest("hex");
}

export type EvidenceCodecRefusal = "foreign_path" | "unencodable_evidence" | "unsupported_root";
const CODEC_MESSAGES: Record<EvidenceCodecRefusal, string> = {
  foreign_path: "A project path leaves the project.",
  unencodable_evidence: "The evidence cannot be shown without a host path.",
  unsupported_root: "The project root is a Windows device path, which the codec does not spell.",
};

/** A string the codec cannot carry without changing what it means. */
export class EvidenceCodecError extends Error {
  constructor(readonly reason: EvidenceCodecRefusal) { super(CODEC_MESSAGES[reason]); }
}

/** The host's path rules. Tests pass `path.win32` or `path.posix` to check another host's roots. */
export type PathFlavor = Pick<typeof path, "sep" | "join" | "isAbsolute">;

const drivePrefix = /^[A-Za-z]:/;

/** Core's `canonical.normalize_path`: forward slashes, lowercase drive letter, no trailing slash. Capsules use it. */
export function coreCanonicalPath(value: string): string {
  let spelled = value.replaceAll("\\", "/");
  if (drivePrefix.test(spelled)) spelled = spelled[0].toLowerCase() + spelled.slice(1);
  return spelled.length > 1 ? spelled.replace(/\/+$/, "") : spelled;
}

// Python's casefold differs from toLowerCase for a few characters, such as
// U+00DF. A root spelled with one never matches Core's scope spelling here, and
// encodeEvidence refuses such output as unencodable instead of guessing.
const fold = (segment: string) => segment.toLowerCase().normalize("NFC");
// Close to casefold, for detection only: U+00DF upper-cases to "SS".
const looseFold = (text: string) => text.replaceAll("\\", "/").toUpperCase().toLowerCase().normalize("NFC");
const collapse = (segments: string[]) => segments.reduce<string[]>((kept, segment) => {
  if (segment === "..") kept.pop();
  else if (segment !== "" && segment !== ".") kept.push(segment);
  return kept;
}, []);

/** Core's `control_scope._normalize_scope_path` for an absolute path. Claim scopes use it. */
export function coreScopePath(value: string): string {
  const spelled = value.replaceAll("\\", "/");
  if (drivePrefix.test(spelled)) {
    const segments = collapse(spelled.slice(2).split("/")).map(fold);
    return fold(spelled.slice(0, 2)) + (spelled.slice(2).startsWith("/") ? "/" + segments.join("/") : segments.join("/"));
  }
  if (spelled.startsWith("//")) {
    const parts = spelled.split("/").filter(Boolean);
    if (parts.length >= 2 && (parts[0] === "?" || parts[0] === ".")) {
      const device = parts.slice(1);
      const joined = device.join("/");
      if (drivePrefix.test(joined)) return coreScopePath(joined.length === 2 ? joined + "/" : joined);
      if (fold(device[0]) === "unc" && device.length >= 3) return coreScopePath("//" + device.slice(1).join("/"));
    }
    if (parts.length >= 2) return "//" + [...parts.slice(0, 2), ...collapse(parts.slice(2))].map(fold).join("/");
  }
  return "/" + collapse(spelled.split("/")).join("/");
}

type Spelling = "canonical" | "scope";

/**
 * Every position in a Strato or Exo request or result that holds an absolute
 * path, and the one spelling Core writes there. "*" is any array index.
 *
 * Capsule, Core `capsule_compile.py`: `$defs/absolute_path` (130-140) types
 * `task.scope` (174), `task.required_checks[].cwd` (194), and
 * `required_checks[].cwd` (746). Checkout paths pass the same canonical check
 * (`_is_normalized_content_path`, 881-882) and fill `claims[].subject_path`
 * (2683, 2782, 2829, 2841, 2976), conflict `sides[].path` (schema 339, from
 * `workspace_model.py` 585), `unknowns[].path` (`workspace_model.py` 554, 574),
 * and omission `path` and `subject_path` (1310, 3240, 3255, 3266).
 * Strato, `strato.py` 240-250: the decision echoes the request's `scope`, which
 * the server fills from `task.scope`.
 * Exo, `exo.py` 48-55 and 760-790: `normalize_scope` (`control_scope.py`
 * 134-143) spells every claim scope in `request_claim` (331-354),
 * `release_claim` (364-411), `expire_leases` (414-444), and `create_handoff`
 * (`control_handoffs.py` 120, 150). Receipts, verdicts, leases, and execution
 * logs hold no absolute path.
 * Not covered: a capsule task filter with `field: "path"` holds a path in
 * `task.filters[*].equals` or `includes`, and its claim repeats it in
 * `claims[*].selection.matched_filters[*].value` (`capsule_compile.py`
 * 143-162, 255-266). A trail cannot name a position that depends on a sibling
 * field, so these pass as text. That is safe only while no Strato or Exo
 * output echoes a capsule, which none does today.
 */
export const PATH_POSITIONS: readonly { at: string; spelling: Spelling }[] = [
  { at: "capsule.task.scope.*", spelling: "canonical" },
  { at: "capsule.task.required_checks.*.cwd", spelling: "canonical" },
  { at: "capsule.required_checks.*.cwd", spelling: "canonical" },
  { at: "capsule.claims.*.subject_path", spelling: "canonical" },
  { at: "capsule.conflicts.*.sides.*.path", spelling: "canonical" },
  { at: "capsule.unknowns.*.path", spelling: "canonical" },
  { at: "capsule.unknowns.*.subject_path", spelling: "canonical" },
  { at: "capsule.omissions.*.path", spelling: "canonical" },
  { at: "capsule.omissions.*.subject_path", spelling: "canonical" },
  { at: "capsule.omissions.*.omitted.*.subject_path", spelling: "canonical" },
  { at: "input.capsule.task.scope.*", spelling: "canonical" },
  { at: "input.capsule.task.required_checks.*.cwd", spelling: "canonical" },
  { at: "input.capsule.required_checks.*.cwd", spelling: "canonical" },
  { at: "input.capsule.claims.*.subject_path", spelling: "canonical" },
  { at: "input.capsule.conflicts.*.sides.*.path", spelling: "canonical" },
  { at: "input.capsule.unknowns.*.path", spelling: "canonical" },
  { at: "input.capsule.unknowns.*.subject_path", spelling: "canonical" },
  { at: "input.capsule.omissions.*.path", spelling: "canonical" },
  { at: "input.capsule.omissions.*.subject_path", spelling: "canonical" },
  { at: "input.capsule.omissions.*.omitted.*.subject_path", spelling: "canonical" },
  { at: "scope.paths.*", spelling: "canonical" },
  { at: "state.claims.*.scope.paths.*", spelling: "scope" },
  { at: "result.claim.scope.paths.*", spelling: "scope" },
  { at: "result.claims.*.scope.paths.*", spelling: "scope" },
  { at: "result.conflicts.*.scope.paths.*", spelling: "scope" },
  { at: "result.expired.*.claim.scope.paths.*", spelling: "scope" },
  { at: "result.handoff.scope.paths.*", spelling: "scope" },
];

type Trail = (string | number)[];
const positions = PATH_POSITIONS.map(({ at, spelling }) => ({ steps: at.split("."), spelling }));
const spellingAt = (trail: Trail): Spelling | undefined => positions.find(({ steps }) => steps.length === trail.length
  && steps.every((step, index) => step === "*" ? typeof trail[index] === "number" : step === trail[index]))?.spelling;

// Node's realpath never returns a device path for an ordinary folder, and
// Core's two normalizers disagree on one, so such a root is refused by name.
const devicePath = /^[\\/]{2}[?.][\\/]/;
function rootSpellings(root: string): Record<Spelling, string> {
  if (devicePath.test(root)) throw new EvidenceCodecError("unsupported_root");
  return { canonical: coreCanonicalPath(root), scope: coreScopePath(root) };
}
const below = (spelled: string) => spelled.endsWith("/") ? spelled : spelled + "/";

/** Maps every string, keys included. A key is never a path position. */
function mapStrings(value: unknown, map: (text: string, spelling: Spelling | undefined) => string, trail: Trail): unknown {
  if (typeof value === "string") return map(value, spellingAt(trail));
  if (Array.isArray(value)) return value.map((item, index) => mapStrings(item, map, [...trail, index]));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [map(key, undefined), mapStrings(item, map, [...trail, key])]));
  }
  return value;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The same spelling rule as the project read redaction: either separator, any case.
const anySpelling = (hostPath: string) => new RegExp(hostPath.split(/[\\/]/).map(escapeRegExp).join("[\\\\/]"), "gi");

/**
 * Encodes a whole Strato or Exo document for the model. At a path position the
 * project root in that position's spelling reads as "." and a descendant as
 * "./" plus the remainder, byte for byte, so decoding restores claim ids and
 * capsule fingerprints. A path position in any other spelling of the root
 * cannot come back unchanged and is refused. Every other string is text: the
 * root and the data directory are redacted, and text is never decoded.
 */
export function encodeEvidence(value: unknown, hostPaths: HostPaths): unknown {
  const roots = rootSpellings(hostPaths.root);
  const redactions = [[hostPaths.root, "."], [hostPaths.dataDir, "<app data>"]]
    .sort((left, right) => right[0].length - left[0].length)
    .map(([hostPath, label]) => [anySpelling(hostPath), label] as const);
  const hostSpellings = [coreCanonicalPath(hostPaths.root), coreCanonicalPath(hostPaths.dataDir)].map(looseFold);
  const text = (entry: string) => {
    const redacted = redactions.reduce((current, [pattern, label]) => current.replace(pattern, label), entry);
    // A root spelled in a case this module cannot reproduce still fails closed.
    if (hostSpellings.some(spelled => looseFold(redacted).includes(spelled))) throw new EvidenceCodecError("unencodable_evidence");
    return redacted;
  };
  return mapStrings(value, (entry, spelling) => {
    if (!spelling) return text(entry);
    const root = roots[spelling];
    if (entry === root) return ".";
    if (entry.startsWith(below(root))) return "./" + entry.slice(below(root).length);
    if (entry === "." || entry.startsWith("./") || text(entry) !== entry) throw new EvidenceCodecError("unencodable_evidence");
    return entry;
  }, []);
}

/**
 * Reverses encodeEvidence for caller evidence placed at `at` in a request
 * document. Only path positions change: "." becomes the root in the
 * position's spelling, and "./" plus a remainder that stays inside the project
 * becomes a descendant. Text is passed through byte for byte.
 */
export function decodeEvidence(value: unknown, root: string, at: string, flavor: PathFlavor = path): unknown {
  const roots = rootSpellings(root);
  return mapStrings(value, (entry, spelling) => {
    if (!spelling) return entry;
    if (entry === ".") return roots[spelling];
    if (!entry.startsWith("./")) return entry;
    const remainder = entry.slice(2);
    if (remainder.includes("\0") || remainder.split(/[\\/]/).includes("..") || flavor.isAbsolute(remainder)) {
      throw new EvidenceCodecError("foreign_path");
    }
    return below(roots[spelling]) + remainder;
  }, at.split("."));
}

type Evidence = Record<string, unknown>;

/**
 * Builds the whole Strato or Exo document. Only this function writes
 * server-owned fields, and nothing in the caller's input can name one.
 */
export function governedDocument(input: GovernedInput, workspace: LocalProjectWorkspace, actor: BoundActor, now: Date,
  flavor: PathFlavor = path): string {
  const at = now.toISOString();
  const decoded = (value: unknown, position: string) => decodeEvidence(value, workspace.root, position, flavor);
  if (input.operation === "decide") {
    const capsule = decoded(input.capsule, "capsule") as Evidence;
    const task = capsule.task as Evidence | undefined;
    const capsuleWorkspace = capsule.workspace as Evidence | undefined;
    // Native has no capsule producer, so the fingerprint is the capsule's own
    // and Strato's workspace match checks only that the capsule agrees with itself.
    return JSON.stringify({
      schema: STRATO_REQUEST_SCHEMA, policy_version: STRATO_POLICY_VERSION, actor, authority_class: AUTHORITY_CLASS,
      workspace: { fingerprint: capsuleWorkspace?.fingerprint },
      scope: { project: workspace.projectId, paths: Array.isArray(task?.scope) ? task.scope : [] },
      requested_at: at, decision_at: at, capsule,
      ...("receipt" in input && input.receipt !== undefined ? { receipt: input.receipt } : {}),
      ...("verdict" in input && input.verdict !== undefined ? { verdict: input.verdict } : {}),
      ...(input.state ? { state: input.state } : {}),
      ...(input.limits ? { limits: input.limits } : {}),
    });
  }
  const control = (state: unknown, request: Evidence) =>
    JSON.stringify({ schema: EXO_REQUEST_SCHEMA, operation: input.operation, state: decoded(state, "state"), input: request });
  switch (input.operation) {
    case "claim": return control(input.state, {
      scope: { project: workspace.projectId, paths: input.paths.map(entry => flavor.join(workspace.root, entry)) },
      actor, now: at, authority_class: AUTHORITY_CLASS, ...(input.lease ? { lease: input.lease } : {}),
    });
    case "release": return control(input.state, { claim_id: input.claim_id, actor });
    case "expire_leases": return control(input.state, { now: at });
    case "dependencies": return control(input.state, { task_id: input.task_id });
    case "task_view": case "complete": return control(input.state, {});
    case "handoff": return control(input.state, {
      claim_id: input.claim_id, receipt: input.receipt, capsule: decoded(input.capsule, "input.capsule"),
      from_actor: actor, workspace_revision: input.workspace_revision, created_at: at, to_authority_class: AUTHORITY_CLASS,
      to_actor: input.to_actor === "me" ? { kind: "human", id: workspace.actorId }
        : { kind: "agent", id: projectAgentActorId(workspace.actorId, workspace.projectId) },
    });
    case "record_execution": return control(input.state, { receipt: input.receipt, capsule: decoded(input.capsule, "input.capsule") });
  }
}
