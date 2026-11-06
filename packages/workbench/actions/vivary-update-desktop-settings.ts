import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";
import { desktopHostAvailable } from "../server/desktop-host";
import { updateDesktopSettings } from "../server/desktop-presence";
import { VIVARY_LOCAL_OWNER_EMAIL } from "../shared/owner-session";

const writeSchema = z.strictObject({
  discord: z.strictObject({
    enabled: z.boolean(),
    applicationId: z.string().max(20),
  }),
});

export default defineAction({
  description: "Update desktop-only preferences stored beside the local workbench data.",
  schema: writeSchema,
  http: { method: "POST" },
  readOnly: false,
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  run: async (input, context) => {
    if (context?.userEmail?.trim().toLowerCase() !== VIVARY_LOCAL_OWNER_EMAIL) {
      fail("Desktop settings are unavailable.", { statusCode: 403 });
    }
    if (!desktopHostAvailable()) {
      fail("Open the desktop app to change desktop settings.", { statusCode: 409 });
    }
    return updateDesktopSettings(input);
  },
});
