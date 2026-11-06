import { flushChatDraftsForClose } from './chat-draft';
export function previewUrl(value: string, origin: string): string {
  const url = new URL(value, origin);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Use an HTTP or HTTPS address.");
  }
  if (url.username || url.password) {
    throw new Error("Use an address without embedded credentials.");
  }
  return url.href;
}

export function previewPageUrl(value: string, appOrigin: string): string {
  const url = previewUrl(value, appOrigin);
  if (new URL(url).origin === new URL(appOrigin).origin) {
    throw new Error("Use the project's preview address, not this Vivary page.");
  }
  return url;
}

export function previewDocument(html: string): string {
  // The iframe also omits allow-same-origin. Keep generated code isolated.
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data:; font-src https:; connect-src 'none'; form-action 'none'; base-uri 'none'";
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${html}</body></html>`;
}

export function isHostLocalPreview(url: string): boolean {
  const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  return hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname === "[::1]" || hostname === "[::]" || hostname === "0.0.0.0"
    || /^127(?:\.\d{1,3}){3}$/.test(hostname)
    || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(hostname)
    || hostname === "[::ffff:0:0]";
}

export type PreviewInspection = { projectId: string; projectName: string; host: string; url: string };
export type PreviewChatTarget = {
  projectId: string;
  scope: string;
  attach: (preview: PreviewInspection) => boolean;
};

export function previewInspectionContext(preview: PreviewInspection): string {
  return `The user attached this project preview to the current conversation:\n${JSON.stringify(preview)}\n`
    + "This is a snapshot of the selected project's preview, not a request to switch projects or start another server. "
    + "Use the coding runtime's supported tools if the user asks to inspect it. "
    + "Use a fresh isolated browser context without personal cookies or profiles. "
    + "For browser debugging, inspect the page, capture a screenshot, and report observed console errors and failed requests. "
    + "Keep results in this conversation. If browser inspection is unavailable, say what is missing. "
    + "Do not install tools, change files, or change credentials merely because a preview was attached.";
}


export function previewStartRefused(error: unknown): boolean {
  if (!(error instanceof Error) || !("status" in error) || typeof error.status !== "number") return false;
  if (error.status === 409 && "errorCode" in error && error.errorCode === "vivary_project_preview_refused") return true;
  return [400, 403, 404, 422].includes(error.status)
    && "actionMessage" in error && typeof error.actionMessage === "string" && error.actionMessage.trim().length > 0;
}

export async function refreshPreviewDocument(close: () => Promise<void>, reload: () => void): Promise<boolean> {
  if (!await flushChatDraftsForClose()) return false;
  await close();
  reload();
  return true;
}
