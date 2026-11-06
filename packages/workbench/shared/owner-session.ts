// Every local access session, including a paired browser, uses this email.
export const VIVARY_LOCAL_OWNER_EMAIL = "owner@local.vivary.test";

// The private proxy sign-in page saves the owner session token under this key,
// and the app reads it back because that proxy never returns cookies.
export const VIVARY_OWNER_SESSION_STORAGE_KEY = "vivary:owner-session";

export const SESSION_TOKEN_PATTERN = /^[^\s\u0000-\u001f\u007f]+$/;
export const MAX_SESSION_TOKEN_LENGTH = 4096;

export function isValidSessionToken(token: unknown): token is string {
  return typeof token === "string"
    && token.length > 0
    && token.length <= MAX_SESSION_TOKEN_LENGTH
    && SESSION_TOKEN_PATTERN.test(token);
}
