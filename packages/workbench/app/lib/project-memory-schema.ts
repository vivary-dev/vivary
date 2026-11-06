import { z } from "zod";

import { projectFileIdSchema, projectFilePathSchema, projectFileVersionSchema } from "./project-file-schema.ts";

// A line break or control character would split a frontmatter line or the
// heading, so the one-line fields refuse them.
// C0 and C1 controls and the Unicode line and paragraph separators. The
// context block escapes them, which would lengthen a field past its limit.
const singleLine = (value: string) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
// Fact text may hold tabs and line or page breaks, which agents receive as
// spaces. Every other control is escaped there, so the panel refuses it.
const noEscapedControls = (value: string) => !/[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/.test(value);

/** Field limits for a fact saved in the panel. The context block renders a fact within them uncut. */
export const FACT_LIMITS = { title: 120, text: 500, source: 200 } as const;

/** The fact's title. It also names the file once, when the fact is first saved. */
export const factTitleSchema = z.string().trim().min(1).max(FACT_LIMITS.title)
  .refine(singleLine, "Use one line for the title.")
  .refine(value => !value.startsWith("#"), "Start the title with a word, not #.");

/** The confirmed statement. Markdown is allowed. The cap keeps one fact from crowding out the rest. */
export const factTextSchema = z.string().trim().min(1).max(FACT_LIMITS.text)
  .refine(noEscapedControls, "Remove control characters from the text.");

/**
 * Where the fact came from. Tropo keeps a double-quoted frontmatter value
 * verbatim without unescaping, so quotation marks and backslashes are
 * refused instead of escaped.
 */
export const factSourceSchema = z.string().trim().min(1).max(FACT_LIMITS.source)
  .refine(singleLine, "Use one line for the source.")
  .refine(value => !/["\\]/.test(value), "Remove quotation marks and backslashes from the source.");

export const projectMemoryInputSchema = z.strictObject({ projectId: projectFileIdSchema });

export const projectMemoryWriteInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    projectId: projectFileIdSchema,
    operation: z.literal("remember"),
    title: factTitleSchema,
    text: factTextSchema,
    source: factSourceSchema,
  }),
  z.strictObject({
    projectId: projectFileIdSchema,
    operation: z.literal("correct"),
    path: projectFilePathSchema,
    expectedVersion: projectFileVersionSchema,
    title: factTitleSchema,
    text: factTextSchema,
    source: factSourceSchema,
  }),
  z.strictObject({
    projectId: projectFileIdSchema,
    operation: z.literal("forget"),
    path: projectFilePathSchema,
    expectedVersion: projectFileVersionSchema,
  }),
]);
export type ProjectMemoryWriteInput = z.infer<typeof projectMemoryWriteInputSchema>;

export const WORKSPACE_ROLES = ["law", "map", "record", "memory", "boundary"] as const;
export type WorkspaceRole = typeof WORKSPACE_ROLES[number];
export type WorkspaceRoles = Readonly<Record<WorkspaceRole, readonly string[]>>;

/**
 * What the workspace's .gitignore rules make private, from the engine.
 * `private` lists memory folders a new fact would be ignored in, and
 * `privateFiles` lists ignored law, state, and fact files. `ignoreFiles` names
 * every .gitignore consulted, existing or not. `policy` is "gitignore" when
 * any of them exists. `.git/info/exclude` and global Git excludes are not read.
 */
export type MemoryPrivacy = {
  policy: "gitignore" | "none";
  private: readonly string[];
  privateFiles: readonly string[];
  ignoreFiles: readonly string[];
  /** Files about to be created that the rules would ignore. Empty unless the caller asked. */
  privateCandidates: readonly string[];
  /**
   * Every memory folder file the engine checked. Project memory loads,
   * corrects, or forgets no other fact file, so a file past the listing
   * bounds or created after the check fails closed.
   */
  checkedFiles: readonly string[];
  /**
   * True when the engine's matching budget ran out. It then treated every
   * path it had not decided as private.
   */
  limited?: boolean;
};

/** Said wherever privacy is described when the engine's matching budget ran out. */
export const PRIVACY_LIMITED_TEXT = "The .gitignore rules were too costly to check in full, so Vivary treated "
  + "the files it had not checked yet as private and did not load them. Simpler rules let it check every file.";

/**
 * The original engine's answer for one project, read through the creator
 * bridge. `memory` is always the effective list: the role's paths, or the
 * engine's default. `protected` lists the declared private, runtime, and
 * capability storage paths, which memory, law, and state never use.
 */
export type WorkspaceContextPaths =
  | { status: "thin"; roles: WorkspaceRoles; state: string; memory: readonly string[];
      memoryAssigned: boolean; protected: readonly string[]; privacy: MemoryPrivacy }
  | { status: "plain"; memory: readonly string[]; protected: readonly string[]; privacy: MemoryPrivacy }
  | { status: "invalid"; message: string };

/** The engine's answer, or why Vivary could not ask for it. */
export type MemorySettings = WorkspaceContextPaths | { status: "unavailable"; message: string };

/** Why a memory folder is not used. A closed set, so every refusal has fixed wording. */
export type LocationProblem = "reserved" | "boundary" | "private" | "non-portable" | "not-folder" | "linked" | "blocked";

export type MemoryLocation =
  | { path: string; status: "ready" }
  | { path: string; status: "absent" }
  | { path: string; status: "refused"; problem: LocationProblem };

/** One fact as read from its owning file. `path` is its identity. */
export type MemoryFact = {
  path: string;
  title: string;
  text: string;
  /** null when the file has no usable source. Note check reports it. */
  source: string | null;
  /** YYYY-MM-DD, or null when missing or malformed. */
  confirmed: string | null;
  version: string;
  updatedAt: string;
  /** True when a field is longer than FACT_LIMITS, so agents receive a shortened copy. Only hand edits do this. */
  shortenedForAgents: boolean;
};

export type SkippedFactFile = { path: string; reason: "linked" | "too-large" | "binary" | "unsupported" | "private" | "unreadable"
  | "no-permission" | "not-checked" | "unsupported-name" | "read-limit" };

/** The latest message that loaded this project's context in this app session. It is not stored. */
export type ProjectContextLastLoad = {
  at: string;
  surface: "code" | "full-chat";
  factCount: number;
  revision: string;
};

export type ProjectMemoryView = {
  project: { id: string; label: string };
  settings: MemorySettings;
  /** One row per effective memory folder, in role order. Empty when settings are unavailable. */
  locations: readonly MemoryLocation[];
  /** The folder a new fact is saved in, or null when no folder can take one. */
  writeLocation: string | null;
  /** Every readable fact, newest confirmation first. */
  facts: readonly MemoryFact[];
  skipped: readonly SkippedFactFile[];
  /** True when a folder held more files than one read lists. */
  truncated: boolean;
  /** The exact block the next message receives. Runs use the same renderer. */
  preview: string;
  /** The preview's revision, comparable with `lastLoad.revision`. */
  previewRevision: string;
  lastLoad: ProjectContextLastLoad | null;
};

export type ProjectMemoryWriteResult =
  | { code: "remembered" | "corrected"; fact: MemoryFact }
  | { code: "forgotten"; path: string }
  | {
      code: "conflict";
      /** `exists`: a fact file with this title's name exists. Correct that fact instead. */
      reason: "exists" | "changed" | "renamed-or-deleted" | "project-changed";
      path: string;
      current?: MemoryFact;
    }
  | { code: "unavailable"; reason: LocationProblem | "settings" | "title" | "too-long" | "not-a-fact"
      | "not-checked" | "unsupported-name" | "locked" | "permission" | "file";
      message: string };

export const LOCATION_PROBLEM_TEXT: Readonly<Record<LocationProblem, string>> = {
  reserved: "This folder belongs to Vivary private, runtime, or semantic-search data, or to Git. Choose another memory folder.",
  boundary: "This folder is inside a boundary path. Choose a memory folder that can be versioned.",
  private: "This project's .gitignore rules ignore this folder, so Vivary does not load or save facts here.",
  "not-folder": "This path is a file. Vivary keeps one file per fact, so the memory path must be a folder.",
  linked: "This path goes through a link. Vivary does not follow links for memory.",
  "non-portable": "This path has a part Windows cannot use: a trailing dot or space, a device name such as CON or NUL, a colon, or a control character.",
  blocked: "Vivary skips this path. It goes through a folder Vivary skips, such as node_modules, build, .git, or .ssh, has an empty or relative part, or has a name containing secret or credential.",
};

export const EFFECTIVE_WHEN_TEXT =
  "Code and Full chat read this project's instructions, state, and facts when each message starts. "
  + "A change applies to your next message, including in open conversations. "
  + "A reply already in progress keeps what it started with.";

/** The sentence under the Memory heading. Paths come from the engine, so the panel never spells a default. */
export function storageSentence(view: Pick<ProjectMemoryView, "settings" | "writeLocation" | "locations">): string {
  const { settings } = view;
  if (settings.status === "unavailable" || settings.status === "invalid") {
    return `Vivary could not read this project's memory settings. ${settings.message}`;
  }
  if (!view.writeLocation && view.locations.length > 0) {
    return "No memory folder can hold facts. Each one is refused for the reason shown below.";
  }
  const folder = `${view.writeLocation ?? settings.memory[0]}/`;
  if (settings.status === "plain") {
    return `Stored in ${folder} in this project folder. This folder has no thin workspace settings (.vivary/workspace.toml), so the default applies.`;
  }
  return settings.memoryAssigned
    ? `Stored in ${folder}, assigned by the memory role in .vivary/workspace.toml.`
    : `Stored in ${folder} in this project folder. This is the default because .vivary/workspace.toml assigns no memory folder.`;
}

/** Which rule decided private folders, for the panel. */
export function privacySentence(settings: MemorySettings): string | null {
  if (settings.status !== "thin" && settings.status !== "plain") return null;
  const sentence = settings.privacy.policy === "gitignore"
    ? "Vivary does not load or save facts, instructions, or state that this project's .gitignore files ignore."
    : "No .gitignore file applies to these folders and files, so none of them is treated as private.";
  return settings.privacy.limited ? `${sentence} ${PRIVACY_LIMITED_TEXT}` : sentence;
}

/**
 * The slug part of a fact's file name: lowercase ASCII letters and digits
 * joined by single hyphens, at most 80 characters. Empty for a title in a
 * script without Latin letters or digits. Shared by the server, which names
 * the file, and the panel, which compares names.
 */
export function factSlug(title: string): string {
  return title.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");
}

/** Whether two titles name the same fact file. A title without a slug names its file by its exact text. */
export function sameFactFile(left: string, right: string): boolean {
  const leftSlug = factSlug(left);
  return leftSlug ? leftSlug === factSlug(right) : left === right;
}

export type MemoryEditorKind = "remember" | "correct" | "forget";

/** The notice after a write conflict, by what the owner was doing. Only Remember and Correct have a draft. */
export function conflictNotice(kind: MemoryEditorKind,
  reason: "exists" | "changed" | "renamed-or-deleted" | "project-changed", path: string): string {
  if (reason === "exists") {
    return `A fact file named ${path} already exists. Correct that fact, or change the title to save a new one.`;
  }
  if (reason === "changed") return "This fact changed after you opened it. Review the current version.";
  if (reason === "renamed-or-deleted") {
    return kind === "forget" ? "This fact file was already removed or renamed. Memory was reloaded."
      : kind === "correct" ? "This fact file was removed or renamed. Memory was reloaded. "
        + "Your draft is kept as a new fact. Save it to remember it again."
      : "The memory folder changed. Memory was reloaded. Your draft is kept.";
  }
  return kind === "forget" ? "The project changed. Memory was reloaded. Nothing was forgotten."
    : "The project changed. Memory was reloaded. Your draft is kept.";
}

/** Shown before every forget. */
export function forgetDisclosure(path: string): string {
  return `Forget removes ${path}. Agents stop receiving it from your next message. `
    + "Earlier conversation transcripts, Codex thread history, Git history and other file versions, "
    + "and backups may still contain it. Vivary does not erase those.";
}
