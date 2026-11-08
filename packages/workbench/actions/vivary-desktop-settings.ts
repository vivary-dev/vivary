import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";
import { desktopHostAvailable } from "../server/desktop-host";
import { readDesktopSettings } from "../server/desktop-presence";
import { VIVARY_LOCAL_OWNER_EMAIL } from "../shared/owner-session";

export default defineAction({
  description: "Read desktop-only preferences stored beside the local workbench data.",
  schema: z.strictObject({}),
  http: { method: "GET" },
  readOnly: true,
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  run: (_input, context) => {
    if (context?.userEmail?.trim().toLowerCase() !== VIVARY_LOCAL_OWNER_EMAIL) {
      fail("Desktop settings are unavailable.", { statusCode: 403 });
    }
    if (!desktopHostAvailable()) {
      fail("Open the desktop app to read desktop settings.", { statusCode: 409 });
    }
    return readDesktopSettings();
  },
});
