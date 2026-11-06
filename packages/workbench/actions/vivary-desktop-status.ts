import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";
import { desktopHostAvailable } from "../server/desktop-host";
import { VIVARY_LOCAL_OWNER_EMAIL } from "../shared/owner-session";

export default defineAction({
  description: "Read the local desktop capabilities available to this window.",
  schema: z.strictObject({}),
  http: { method: "GET" },
  readOnly: true,
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  run: (_input, context) => {
    if (context?.userEmail?.trim().toLowerCase() !== VIVARY_LOCAL_OWNER_EMAIL) {
      fail("Desktop access is unavailable.", { statusCode: 403 });
    }
    return { folderPicker: desktopHostAvailable() };
  },
});
