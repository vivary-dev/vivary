/**
 * Credential redaction, issue #97. Vivary replaces credentials with a placeholder before text
 * reaches a model, storage, a log, or the screen. Two rules apply.
 *
 * Held values: Vivary knows the credentials it holds. They come from credential-named server
 * environment settings, the Agent-Native secret store, legacy credential settings, and the
 * environments and headers in mcp.config.json. An exact occurrence of a held value, or of its
 * URL-encoded, JSON-escaped, or base64 form, becomes a labeled placeholder such as
 * `[redacted OPENROUTER_API_KEY]`.
 *
 * Patterns: common key formats that Vivary does not hold become `[redacted credential]`. These
 * are `sk-`, Stripe, GitHub, GitLab, `AKIA`, `AIza`, and `xox` tokens, JSON Web Tokens, `Bearer`
 * tokens, URL passwords, and credential-named assignments such as `OPENROUTER_API_KEY=...`.
 *
 * Every rule scans text in linear time, so a long single-line tool result cannot stall the server.
 * A redactor exposes `redact()` and a count only. It never logs or returns a held value. The
 * coding worker receives salted fingerprints instead of values, see `credentialFingerprints`.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";

import { getDbExec } from "@agent-native/core/db";
import { loadMcpConfig } from "@agent-native/core/mcp-client";
import { decryptSecretValue, isEncryptedSecretValue, onAppSecretsChanged, readAppSecret } from "@agent-native/core/secrets";
import { getSettingsEmitter } from "@agent-native/core/settings";

import { isCredentialName } from "./local-runtime-setup.ts";

export type CredentialRedactor = { redact(text: string): string; readonly count: number };
export type HeldCredential = { name: string; value: string };
type McpConfig = ReturnType<typeof loadMcpConfig>;
/** Where held values come from. Stored secrets are name and value pairs as the store keeps them. */
export type CredentialSources = {
  environment: () => Record<string, string | undefined>;
  mcpConfig: () => McpConfig;
  storedSecrets: () => Promise<HeldCredential[]>;
};

/** Shorter values match ordinary text too often, so they are not held. */
const MIN_HELD_LENGTH = 16;
const PATTERN_PLACEHOLDER = "[redacted credential]";
const SCALAR = /^(?:true|false|null|undefined|yes|no|on|off|[+-]?\d+(?:\.\d+)?)$/i;
// A host name ends in a letters-only label, as a top-level domain does, so a dotted token with digits is not one.
const HOST = /^(?=.*[a-z])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}(?::\d{1,5})?$/;
const FILE_URL = /^file:/i;
const LOCAL_PATH = /^(?:\/|~[/\\]|[A-Za-z]:[/\\]|\\\\)/;
const DOTTED_IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const URL_WITH_SCHEME = /^[a-z][a-z0-9+.-]{0,31}:\/\//i;

function placeholderFor(name: string): string {
  const label = name.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64);
  return `[redacted ${label || "credential"}]`;
}

function parsedUrl(text: string): URL | null {
  if (!URL_WITH_SCHEME.test(text)) return null;
  try { return new URL(text); } catch { return null; }
}

function decoded(text: string): string {
  try { return decodeURIComponent(text); } catch { return text; }
}

// Upper-case words joined by "_", so apiKey, api-key, and API_KEY read the same.
function credentialNameWords(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[.-]/g, "_").toUpperCase();
}

const CREDENTIAL_HEADERS = new Set(["AUTHORIZATION", "PROXY_AUTHORIZATION", "COOKIE"]);

function isCredentialField(name: string): boolean {
  const words = credentialNameWords(name);
  return CREDENTIAL_HEADERS.has(words) || isCredentialName(words);
}

// A setting that names a file or folder holds a path, not a secret, even when its name is
// credential-shaped, such as GOOGLE_APPLICATION_CREDENTIALS or PASSWORD_STORE_DIR.
function isPathSetting(name: string): boolean {
  const words = credentialNameWords(name);
  return /(?:^|_)(?:PATH|FILE|DIR)$/.test(words) || words === "GOOGLE_APPLICATION_CREDENTIALS";
}

// The string fields of a JSON bundle whose names are credential-like, with the field name, so a
// token bundle's tokens are held and its expiry time and scope are not.
function credentialLeaves(value: unknown, field: string | null, leaves: Array<[string | null, string]> = [], depth = 0) {
  if (typeof value === "string") {
    if (field === null || isCredentialField(field)) leaves.push([field, value]);
  } else if (value && typeof value === "object" && depth < 8 && leaves.length < 1_000) {
    for (const [name, entry] of Object.entries(value)) {
      credentialLeaves(entry, Array.isArray(value) ? field : name, leaves, depth + 1);
    }
  }
  return leaves;
}

/**
 * The values held for one credential setting. A JSON bundle adds its credential fields, a `Bearer`
 * header adds its token, and a URL adds its password and its credential-named query values, or
 * its whole address when the setting is a webhook. Base URLs, hosts, ports, numbers, booleans,
 * `file:` URLs, paths in path settings, and values under 16 characters are skipped.
 */
function heldValuesOf(name: string, value: string, depth = 0): string[] {
  const text = value.trim();
  if (text.length < MIN_HELD_LENGTH || SCALAR.test(text) || HOST.test(text) || FILE_URL.test(text)
    || (LOCAL_PATH.test(text) && isPathSetting(name))) return [];
  if (depth < 4 && (text.startsWith("{") || text.startsWith("["))) {
    try {
      const leaves = credentialLeaves(JSON.parse(text), null);
      return [text, ...leaves.flatMap(([field, leaf]) => heldValuesOf(field ?? name, leaf, depth + 1))];
    } catch { /* Not JSON. The text itself is held below. */ }
  }
  const bearer = /^Bearer\s+(\S+)$/i.exec(text);
  if (bearer) return [text, ...heldValuesOf(name, bearer[1], depth + 1)];
  const url = parsedUrl(text);
  if (url) {
    const password = url.password ? [url.password, decoded(url.password)].filter(part => part.length >= MIN_HELD_LENGTH) : [];
    const query = [...url.searchParams].flatMap(([key, param]) => isCredentialField(key) ? heldValuesOf(key, param, depth + 1) : []);
    return [...(credentialNameWords(name).includes("WEBHOOK") ? [text] : []), ...password, ...query];
  }
  return [text];
}

/**
 * The forms a held value can take in printed text: the value, its URL-encoded and JSON-escaped
 * forms, and the stable part of its standard and URL-safe base64 at each of the three byte
 * alignments it can have inside a longer base64 string.
 */
function valueForms(value: string): string[] {
  const forms = new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
  const bytes = Buffer.from(value, "utf8");
  for (const offset of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString("base64").replace(/=+$/, "");
    // Leading characters mix in the alignment bytes, and a final partial group mixes in whatever follows.
    const start = [0, 2, 3][offset];
    const end = (offset + bytes.length) % 3 === 0 ? encoded.length : encoded.length - 1;
    const core = encoded.slice(start, end);
    forms.add(core);
    forms.add(core.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  return [...forms].filter(form => form.length >= MIN_HELD_LENGTH);
}

// Each pattern is anchored by a lookbehind or a bounded prefix, so a failed match costs a bounded
// number of steps and a long line is scanned in linear time. The token lookbehind also keeps a
// match out of a longer word, a CSS class such as `.sk-circle`, or a path.
const PREFIXED_TOKEN = new RegExp("(?<![A-Za-z0-9_.-])(?:" + [
  "sk-[A-Za-z0-9_-]{20,}", "(?:sk|rk)_live_[A-Za-z0-9]{16,}", "gh[oprsu]_[A-Za-z0-9]{30,}",
  "github_pat_[A-Za-z0-9_]{22,}", "glpat-[A-Za-z0-9_-]{20,}", "AKIA[0-9A-Z]{16}(?![A-Za-z0-9])",
  "AIza[0-9A-Za-z_-]{35}", "xox[abprs]-[A-Za-z0-9-]{10,}",
  "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}",
].join("|") + ")", "g");
const BEARER_TOKEN = /\b(Bearer[ \t]{1,8})([A-Za-z0-9._~+/-]{16,}=*)/gi;
const URL_PASSWORD = /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/?#]+:)([^\s@/?#]+)(@)/gi;
// A name starts after a character that cannot be part of it, or after an escaped newline or tab in JSON text.
const ASSIGNMENT_HEAD = /(?:(?<=\\[nrt])|(?<![A-Za-z0-9_$.-]))([A-Za-z_][A-Za-z0-9_.-]{0,79})(["']?[ \t]{0,8}[:=][ \t]{0,8}["']?)/g;
const ASSIGNMENT_VALUE = /[^\s"'`,;&<>(){}[\]\\|]+/y;

// A bearer token has a digit or mixed case, and is not a run of hyphenated lower-case words.
function looksLikeToken(value: string): boolean {
  return (/[0-9]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value))) && !/^[a-z]+(?:-[a-z0-9]+)+$/.test(value);
}

// Names that print ordinary data even though a credential word appears in them: identifiers,
// names, paths, addresses, expiry times, pagination cursors, and public, cache, storage, and
// idempotency keys. The withholding rule in local-runtime-setup.ts stays broad on purpose.
const DATA_LAST_WORDS = new Set(["ID", "NAME", "ARN", "PATH", "FILE", "DIR", "URL", "URI", "ENDPOINT", "TYPE", "COUNT",
  "TTL", "EXPIRY", "EXPIRES", "ALIAS", "FINGERPRINT"]);
const DATA_KEY_NAMES = ["PUBLIC_KEY", "PRIMARY_KEY", "CACHE_KEY", "OBJECT_KEY", "S3_KEY", "IDEMPOTENCY_KEY"];
// A pagination token: a TOKEN name with a whole PAGE, NEXT, CONTINUATION, or CURSOR word before it.
const PAGINATION_WORDS = new Set(["PAGE", "NEXT", "CONTINUATION", "CURSOR"]);

// A webhook setting's whole URL is the credential, so its value is redacted even though names
// that end in URL and values with a scheme are otherwise left alone.
function isWebhookName(name: string): boolean {
  return credentialNameWords(name).split("_").some(part => part === "WEBHOOK" || part === "WEBHOOKS");
}

function isPrintedCredentialName(name: string): boolean {
  const words = credentialNameWords(name);
  const parts = words.split("_").filter(Boolean);
  const last = parts.at(-1) ?? "";
  // A lone "key" names ordinary data too often, such as a storage key or a map key.
  if (words === "KEY" || words === "KEYS" || DATA_LAST_WORDS.has(last) || (last === "AT" && parts.at(-2) === "EXPIRES")
    || (last === "TOKEN" && parts.slice(0, -1).some(part => PAGINATION_WORDS.has(part))) || DATA_KEY_NAMES.some(key => words === key || words.endsWith(`_${key}`))) return false;
  return isCredentialName(words);
}

/**
 * Whether the value of a credential-named assignment is a credential. Code reads such as
 * `apiKey: process.env.API_KEY`, URLs, and paths in path settings are not. Outside an
 * environment-style name, a value needs a letter and a digit, which random keys almost always have.
 */
function assignedCredential(name: string, value: string): boolean {
  if (value.length < MIN_HELD_LENGTH || SCALAR.test(value) || HOST.test(value) || FILE_URL.test(value)
    || DOTTED_IDENTIFIER.test(value) || URL_WITH_SCHEME.test(value) || (LOCAL_PATH.test(value) && isPathSetting(name))) return false;
  return /^[A-Z][A-Z0-9_]*$/.test(name) || (/[0-9]/.test(value) && /[A-Za-z]/.test(value));
}

// Each value run is read at most once: after a credential-named head its run is consumed whether
// or not it is redacted, and any other head resumes the scan right after its separator.
function redactAssignments(text: string): string {
  let output = "";
  let cursor = 0;
  ASSIGNMENT_HEAD.lastIndex = 0;
  for (let head = ASSIGNMENT_HEAD.exec(text); head; head = ASSIGNMENT_HEAD.exec(text)) {
    const valueStart = head.index + head[0].length;
    const webhook = isWebhookName(head[1]);
    if (!webhook && !isPrintedCredentialName(head[1])) {
      ASSIGNMENT_HEAD.lastIndex = Math.max(valueStart, head.index + 1);
      continue;
    }
    ASSIGNMENT_VALUE.lastIndex = valueStart;
    const value = ASSIGNMENT_VALUE.exec(text)?.[0] ?? "";
    if ((webhook && URL_WITH_SCHEME.test(value)) || (isPrintedCredentialName(head[1]) && assignedCredential(head[1], value))) {
      output += text.slice(cursor, valueStart) + PATTERN_PLACEHOLDER;
      cursor = valueStart + value.length;
    }
    ASSIGNMENT_HEAD.lastIndex = Math.max(valueStart + value.length, head.index + 1);
  }
  return cursor === 0 ? text : output + text.slice(cursor);
}

/** The pattern rules alone. Every redactor applies them after its held values. */
export function redactCredentialPatterns(text: string): string {
  return redactAssignments(text
    .replace(PREFIXED_TOKEN, PATTERN_PLACEHOLDER)
    .replace(BEARER_TOKEN, (match, prefix: string, token: string) => looksLikeToken(token) ? prefix + PATTERN_PLACEHOLDER : match)
    .replace(URL_PASSWORD, `$1${PATTERN_PLACEHOLDER}$3`));
}

// Held forms are found by one rolling hash over a 16-character window. A window whose hash bits
// match a form is confirmed by `matches`, an exact comparison on the server and a salted digest in
// the coding worker. The scan is linear in the text length whatever the number of held forms.
const PREFIX_LENGTH = MIN_HELD_LENGTH;
const WINDOW_BITS = 20;
type WindowEntry = { length: number; placeholder: string; matches: (text: string, start: number) => boolean };

// A polynomial hash modulo 2^32. Collisions only cost a confirmation, never a wrong match.
function prefixWindow(text: string, base: number): number {
  let hash = 0;
  for (let index = 0; index < PREFIX_LENGTH; index++) hash = (Math.imul(hash, base) + text.charCodeAt(index)) | 0;
  return hash >>> (32 - WINDOW_BITS);
}

function windowScanner(base: number, entries: Array<WindowEntry & { window: number }>): (text: string) => string {
  const byWindow = new Map<number, WindowEntry[]>();
  // Longest first within a window, so a value wins over a shorter value it starts with.
  for (const entry of [...entries].sort((a, b) => b.length - a.length)) {
    const bucket = byWindow.get(entry.window);
    if (bucket) bucket.push(entry);
    else byWindow.set(entry.window, [entry]);
  }
  const windowBits = new Uint32Array(2 ** WINDOW_BITS / 32);
  for (const window of byWindow.keys()) windowBits[window >>> 5] |= 1 << (window & 31);
  let power = 1;
  for (let step = 1; step < PREFIX_LENGTH; step++) power = Math.imul(power, base);
  return text => {
    if (byWindow.size === 0) return text;
    let output = "";
    let cursor = 0;
    let hash = 0;
    for (let index = 0; index < text.length; index++) {
      if (index >= PREFIX_LENGTH) hash = (hash - Math.imul(text.charCodeAt(index - PREFIX_LENGTH), power)) | 0;
      hash = (Math.imul(hash, base) + text.charCodeAt(index)) | 0;
      const start = index - PREFIX_LENGTH + 1;
      if (start < cursor) continue;
      const window = hash >>> (32 - WINDOW_BITS);
      if ((windowBits[window >>> 5] & (1 << (window & 31))) === 0) continue;
      const hit = byWindow.get(window)?.find(entry => start + entry.length <= text.length && entry.matches(text, start));
      if (!hit) continue;
      output += text.slice(cursor, start) + hit.placeholder;
      cursor = start + hit.length;
    }
    return cursor === 0 ? text : output + text.slice(cursor);
  };
}

type HeldForms = { forms: Map<string, string>; count: number; longest: number };

function heldForms(held: HeldCredential[]): HeldForms {
  const forms = new Map<string, string>();
  const values = new Set<string>();
  for (const { name, value } of held) {
    const valueFormList = values.has(value) ? [] : valueForms(value);
    if (valueFormList.length === 0) continue;
    values.add(value);
    for (const form of valueFormList) if (!forms.has(form)) forms.set(form, placeholderFor(name));
  }
  return { forms, count: values.size, longest: Math.max(0, ...[...forms.keys()].map(form => form.length)) };
}

function redactorFor({ forms, count }: HeldForms): CredentialRedactor {
  const base = randomInt(2 ** 30, 2 ** 31) * 2 + 1;
  const scan = windowScanner(base, [...forms].map(([form, placeholder]) => ({
    length: form.length, placeholder, window: prefixWindow(form, base),
    matches: (text: string, start: number) => text.startsWith(form, start),
  })));
  return { count, redact: text => redactCredentialPatterns(scan(text)) };
}

/** A redactor for these held values. Each value must already be selected, see the sources below. */
export function createCredentialRedactor(held: HeldCredential[]): CredentialRedactor {
  return redactorFor(heldForms(held));
}

function environmentCredentials(environment: Record<string, string | undefined>): HeldCredential[] {
  return Object.entries(environment).flatMap(([name, value]) => {
    if (typeof value !== "string" || !isCredentialName(name.toUpperCase())) return [];
    return heldValuesOf(name, value).map(held => ({ name, value: held }));
  });
}

function mcpCredentials(config: McpConfig): HeldCredential[] {
  if (!config) return [];
  return Object.values(config.servers).flatMap(server => {
    if (server.type === "http") {
      return Object.entries(server.headers ?? {}).flatMap(([name, value]) =>
        isCredentialField(name) ? heldValuesOf(name, value).map(held => ({ name, value: held })) : []);
    }
    return environmentCredentials(server.env ?? {});
  });
}

/** Everything in the secret store is a credential, so its values are held whatever their names. */
function storedCredential(name: string, value: string): HeldCredential[] {
  return heldValuesOf(name, value).map(held => ({ name, value: held }));
}

async function readStoredSecrets(): Promise<HeldCredential[]> {
  const db = getDbExec();
  const held: HeldCredential[] = [];
  // Only the identifying columns are selected. readAppSecret decrypts each value.
  const secrets = await db.execute({ sql: "SELECT scope, scope_id, key FROM app_secrets", args: [] })
    .then(result => result.rows ?? []).catch(() => []);
  for (const row of secrets) {
    const ref = { scope: String(row.scope), scopeId: String(row.scope_id), key: String(row.key) };
    const secret = await readAppSecret(ref as Parameters<typeof readAppSecret>[0]).catch(() => null);
    if (typeof secret?.value === "string") held.push({ name: ref.key, value: secret.value });
  }
  // Legacy credential settings, keyed u:<email>:credential:<NAME> or o:<org>:credential:<NAME>.
  const settings = await db.execute({ sql: "SELECT key, value FROM settings WHERE key LIKE ?", args: ["%:credential:%"] })
    .then(result => result.rows ?? []).catch(() => []);
  for (const row of settings) {
    let stored: unknown;
    try { stored = (JSON.parse(String(row.value)) as { value?: unknown } | null)?.value; } catch { continue; }
    if (typeof stored !== "string") continue;
    let value = stored;
    if (isEncryptedSecretValue(stored)) {
      try { value = decryptSecretValue(stored); } catch { continue; }
    }
    held.push({ name: String(row.key).split(":credential:").at(-1) ?? "credential", value });
  }
  return held;
}

export const defaultCredentialSources: CredentialSources = {
  environment: () => process.env,
  mcpConfig: () => { try { return loadMcpConfig(); } catch { return null; } },
  storedSecrets: readStoredSecrets,
};

let current: HeldForms = { forms: new Map(), count: 0, longest: 0 };
let currentRedactor = redactorFor(current);
let storedHeld: HeldCredential[] = [];
let refreshSequence = 0;

function applyHeld(held: HeldCredential[]): void {
  current = heldForms(held);
  currentRedactor = redactorFor(current);
}

/**
 * Reload the held values. Settings from the environment and MCP configuration apply at once.
 * Stored secrets apply when the database answers, and a failed read keeps the last stored set.
 * Vivary refreshes at startup, after each secret write, before each Native chat send, and before
 * each Code send.
 */
export async function refreshHeldCredentials(sources: CredentialSources = defaultCredentialSources): Promise<void> {
  const sequence = ++refreshSequence;
  const configured = [...environmentCredentials(sources.environment()), ...mcpCredentials(sources.mcpConfig())];
  applyHeld([...configured, ...storedHeld]);
  const stored = await sources.storedSecrets()
    .then(secrets => secrets.flatMap(({ name, value }) => storedCredential(name, value)), () => storedHeld);
  if (sequence !== refreshSequence) return;
  storedHeld = stored;
  applyHeld([...configured, ...stored]);
}

/**
 * Refresh the held set whenever a stored secret or a legacy credential setting changes, so a run
 * that starts right after a save, such as a scheduled automation, redacts the new value. Returns a
 * function that stops watching.
 */
export function watchHeldCredentialSources(sources: CredentialSources = defaultCredentialSources): () => void {
  const refresh = () => { void refreshHeldCredentials(sources).catch(() => undefined); };
  const stopSecrets = onAppSecretsChanged(refresh);
  const settings = getSettingsEmitter();
  const onSettings = (event: { key?: unknown } | undefined) => {
    if (typeof event?.key === "string" && event.key.includes(":credential:")) refresh();
  };
  settings.on("settings", onSettings);
  return () => { stopSecrets(); settings.off("settings", onSettings); };
}

/** Redact held values and patterns with the current held set. */
export function redactCredentials(text: string): string {
  return currentRedactor.redact(text);
}

/** Redact every string in a plain object or array, such as a request shown on an approval card. */
export function redactCredentialsInValue<T>(value: T, depth = 0): T {
  if (typeof value === "string") return redactCredentials(value) as T;
  if (!value || typeof value !== "object" || depth > 32) return value;
  if (Array.isArray(value)) return value.map(entry => redactCredentialsInValue(entry, depth + 1)) as T;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactCredentialsInValue(entry, depth + 1)])) as T;
}

/** How many distinct values are held. Values themselves are never exposed. */
export function heldCredentialCount(): number {
  return current.count;
}

/**
 * How many trailing characters a streamed delta keeps back so the longest held form, and the
 * name before it, can be redacted whole. At least 256 and at most 16,384.
 */
export function heldCredentialHoldback(): number {
  return Math.min(16_384, Math.max(256, current.longest + 256));
}

const redactedStream = Symbol("vivary.redactedStream");

/**
 * Redact every write to a process stream, which also covers console output. A chunk that holds
 * no credential is written unchanged. Other encodings pass through untouched.
 */
export function redactStreamWrites(stream: NodeJS.WritableStream & { [redactedStream]?: true }): void {
  if (stream[redactedStream]) return;
  const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    const encoding = typeof rest[0] === "string" ? rest[0] : undefined;
    if (encoding && !/^utf-?8$/i.test(encoding)) return write(chunk, ...rest);
    const text = typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : null;
    if (text === null) return write(chunk, ...rest);
    const redacted = redactCredentials(text);
    return write(redacted === text ? chunk : redacted, ...rest);
  }) as typeof stream.write;
  stream[redactedStream] = true;
}

// Fingerprints let the coding worker find held values without receiving them. The host sends a
// fresh salt, a random odd rolling-hash base, and for each held form its length, the top 20 bits
// of the rolling hash of its first 16 characters, a salted SHA-256 digest, and its placeholder.
// The worker confirms a window hit by length and digest. Anything that can read the worker can
// test guesses against a digest, so a weak held value can be found by a dictionary search.
const MAX_FINGERPRINTS = 4_096;
const MAX_FINGERPRINT_LENGTH = 16_384;

export type CredentialFingerprint = { length: number; window: number; digest: string; placeholder: string };
export type CredentialFingerprints = { salt: string; base: number; entries: CredentialFingerprint[] };

function saltedDigest(salt: string, text: string): string {
  return createHash("sha256").update(salt).update(text, "utf8").digest("hex");
}

/** Fingerprints of the current held set, with a fresh salt and base for one coding run. */
export function credentialFingerprints(): CredentialFingerprints {
  const salt = randomBytes(16).toString("hex");
  const base = randomInt(2 ** 30, 2 ** 31) * 2 + 1;
  const entries = [...current.forms].filter(([form]) => form.length <= MAX_FINGERPRINT_LENGTH).slice(0, MAX_FINGERPRINTS)
    .map(([form, placeholder]) => ({
      length: form.length, window: prefixWindow(form, base), digest: saltedDigest(salt, form), placeholder,
    }));
  return { salt, base, entries };
}

const FINGERPRINT_KEYS = ["salt", "base", "entries"];
const FINGERPRINT_ENTRY_KEYS = ["length", "window", "digest", "placeholder"];
const hasOnlyKeys = (value: object, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

/** A fingerprint set as the worker accepts it. Any other field, such as a value, is refused. */
export function isCredentialFingerprints(value: unknown): value is CredentialFingerprints {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasOnlyKeys(value, FINGERPRINT_KEYS)) return false;
  const { salt, base, entries } = value as Partial<CredentialFingerprints>;
  return typeof salt === "string" && /^[0-9a-f]{32}$/.test(salt)
    && typeof base === "number" && Number.isInteger(base) && base > 0 && base < 2 ** 32 && base % 2 === 1
    && Array.isArray(entries) && entries.length <= MAX_FINGERPRINTS
    && entries.every(entry => !!entry && typeof entry === "object" && !Array.isArray(entry) && hasOnlyKeys(entry, FINGERPRINT_ENTRY_KEYS)
      && Number.isInteger(entry.length) && entry.length >= MIN_HELD_LENGTH && entry.length <= MAX_FINGERPRINT_LENGTH
      && Number.isInteger(entry.window) && entry.window >= 0 && entry.window < 2 ** WINDOW_BITS
      && typeof entry.digest === "string" && /^[0-9a-f]{64}$/.test(entry.digest)
      && typeof entry.placeholder === "string" && /^\[redacted [A-Za-z0-9_.:-]{1,64}\]$/.test(entry.placeholder));
}

/** The worker's redactor: held values found by fingerprint, then the pattern rules. */
export function createFingerprintRedactor(fingerprints: CredentialFingerprints): CredentialRedactor {
  const { salt, base } = fingerprints;
  const scan = windowScanner(base, fingerprints.entries.map(entry => ({
    length: entry.length, placeholder: entry.placeholder, window: entry.window,
    matches: (text: string, start: number) => saltedDigest(salt, text.slice(start, start + entry.length)) === entry.digest,
  })));
  return { redact: text => redactCredentialPatterns(scan(text)), count: new Set(fingerprints.entries.map(entry => entry.placeholder)).size };
}
