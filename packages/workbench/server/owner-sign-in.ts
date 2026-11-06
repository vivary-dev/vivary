import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  MAX_SESSION_TOKEN_LENGTH,
  SESSION_TOKEN_PATTERN,
  VIVARY_OWNER_SESSION_STORAGE_KEY,
} from "../shared/owner-session.ts";

export const VIVARY_OWNER_SIGN_IN_HEADER = "x-vivary-owner-sign-in";
export const VIVARY_OWNER_SIGN_IN_FILE = "owner-sign-in.txt";

const SECRET_PATTERN = /^[\w-]{43}$/;

export type VivaryOwnerSignIn = {
  redeem: (presented: string | undefined) => boolean;
};

type VivaryOwnerSignInOptions = {
  origin: string;
  dataDir: string;
  createSecret?: () => string;
  saveFile?: (file: string, contents: string) => void;
};

// Standalone local and private-proxy launches have no desktop parent to vouch
// for the owner. Reading this owner-only file on the host is the proof, and
// each saved address creates one owner session.
export function createVivaryOwnerSignIn({
  origin,
  dataDir,
  createSecret = () => randomBytes(32).toString("base64url"),
  saveFile = saveOwnerOnlyFile,
}: VivaryOwnerSignInOptions): VivaryOwnerSignIn {
  const file = path.join(dataDir, VIVARY_OWNER_SIGN_IN_FILE);
  let currentDigest: Buffer | null = null;
  const issue = () => {
    const secret = createSecret();
    currentDigest = digest(secret);
    saveFile(file, `${origin}/sign-in#${secret}\n`);
  };
  issue();

  return {
    redeem(presented) {
      if (!currentDigest || presented === undefined || !SECRET_PATTERN.test(presented)) return false;
      if (!timingSafeEqual(digest(presented), currentDigest)) return false;
      // Clear the match first so a failure below can never leave this secret valid.
      currentDigest = null;
      try {
        issue();
      } catch {
        process.stderr.write(
          "[vivary-local-access] Owner signed in, but the next sign-in address could not be saved. Restart Vivary to create one.\n",
        );
      }
      return true;
    },
  };
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

// Synchronous so the local access plugin saves the first address before the server answers requests.
function saveOwnerOnlyFile(file: string, contents: string): void {
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

// Served at every Native sign-in route. The page holds no secret. The secret
// arrives in the address fragment, which browsers never send to a server. The
// referrer policy comes before the script so the session request already uses
// it. No script comes before this one, including any Native adds to the head,
// so it removes the secret from the address bar and history before other code runs.
const signInPage = (keepSession: boolean) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <script>${signInScript(keepSession)}</script>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in to Vivary</title>
  <style>body{color-scheme:light dark;font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:34rem;padding:0 1rem}</style>
</head>
<body>
  <h1>Sign in to Vivary</h1>
  <div id="help" hidden>
    <p>Open the current one-time sign-in address from ${VIVARY_OWNER_SIGN_IN_FILE} in the Vivary data folder on the computer that runs Vivary.</p>
    <p>Each address works once. After you use one, Vivary saves a new address in the same file.</p>
  </div>${keepSession ? `
  <div id="storage-blocked" hidden>
    <p>This browser blocks site storage. Vivary needs it to stay signed in through the private proxy. Allow site data for this address, then open the sign-in address again.</p>
  </div>` : ""}
  <noscript><p>Vivary needs JavaScript to finish signing in. Turn on JavaScript, then open the address from ${VIVARY_OWNER_SIGN_IN_FILE} again.</p></noscript>
</body>
</html>`;

// The private proxy never returns cookies to Vivary, so its page also keeps the
// owner session token in browser storage for the app to send as a header. The
// local page keeps the cookie session and never touches storage.
const signInScript = (keepSession: boolean) => `
    (() => {
      const takeSecret = () => {
        const secret = location.hash.slice(1);
        if (location.hash) history.replaceState(null, "", location.pathname);
        return secret;
      };
      const firstSecret = takeSecret();
      const keepSession = ${keepSession};
      const storageKey = ${JSON.stringify(VIVARY_OWNER_SESSION_STORAGE_KEY)};
      const isSessionToken = (value) => typeof value === "string" && value.length > 0
        && value.length <= ${MAX_SESSION_TOKEN_LENGTH} && ${SESSION_TOKEN_PATTERN}.test(value);
      const withStorage = (use) => {
        if (!keepSession) return null;
        try {
          return use(localStorage);
        } catch {
          return null;
        }
      };
      const storageWorks = () => withStorage((storage) => {
        storage.setItem(storageKey + ":check", "1");
        storage.removeItem(storageKey + ":check");
        return true;
      }) === true;
      // This script runs before the body is parsed.
      const show = (id) => {
        const reveal = () => {
          for (const message of ["help", "storage-blocked"]) {
            // The local page has no storage-blocked message.
            const element = document.getElementById(message);
            if (element) element.hidden = message !== id;
          }
        };
        if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", reveal);
        else reveal();
      };
      const readSession = async (headers) => {
        try {
          const response = await fetch("/_agent-native/auth/session", { headers, credentials: "same-origin", cache: "no-store" });
          if (!response.ok) return undefined;
          // Native answers 200 with an error body when there is no session.
          const body = await response.json();
          return typeof body === "object" && body !== null && !("error" in body) ? body : null;
        } catch {
          return undefined;
        }
      };
      const signIn = async (secret) => {
        if (secret && !${SECRET_PATTERN}.test(secret)) return show("help");
        // The proxy drops cookies, so a session this browser cannot store is useless and must not spend the secret.
        if (keepSession && !storageWorks()) return show("storage-blocked");
        const stored = withStorage((storage) => storage.getItem(storageKey));
        const headers = {};
        // Vivary checks a stored session before the secret, so a valid one never spends the secret.
        if (isSessionToken(stored)) headers["x-vivary-session"] = stored;
        if (secret) headers[${JSON.stringify(VIVARY_OWNER_SIGN_IN_HEADER)}] = secret;
        const session = await readSession(headers);
        if (session) {
          if (isSessionToken(session.token)) withStorage((storage) => storage.setItem(storageKey, session.token));
          location.replace("/");
          return;
        }
        // A failed check proves nothing, so only an answer of no session forgets the stored one.
        if (session === null) withStorage((storage) => storage.removeItem(storageKey));
        show("help");
      };
      // Opening an address in a tab already on this page changes only the fragment, which does not reload the page.
      addEventListener("hashchange", () => signIn(takeSecret()));
      return signIn(firstSecret);
    })();
  `;

export const VIVARY_OWNER_SIGN_IN_HTML: Record<"local" | "private-proxy", string> = {
  local: signInPage(false),
  "private-proxy": signInPage(true),
};
