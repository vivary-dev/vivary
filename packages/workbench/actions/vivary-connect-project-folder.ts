import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";
import { chooseDesktopProjectFolder } from "../server/desktop-host";
import { connectLocalProjectFolder, getLocalProjectAccess } from "../server/project-services.mjs";

export default defineAction({
  description: "Open the system folder chooser and connect the chosen local project.",
  schema: z.strictObject({}),
  requiresAuth: true,
  agentTool: false,
  mcpTool: false,
  toolCallable: false,
  audit: { recordInputs: false, target: () => ({ visibility: "private" }) },
  run: async (_input, context) => {
    if ((await getLocalProjectAccess(context)).code !== "catalog") {
      fail("Project folder access is unavailable.", { statusCode: 403 });
    }
    let folder: string | null;
    try {
      folder = await chooseDesktopProjectFolder();
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        // Keep chooser expiry non-retryable: a 408 response can replay the request.
        fail(error.message, { statusCode: 409 });
      }
      fail("The folder chooser could not finish. Close it and try again in the desktop app.", {
        statusCode: 409,
      });
    }
    if (folder === null) return { code: "cancelled" as const };
    try {
      return await connectLocalProjectFolder(context, folder);
    } catch {
      fail("The folder could not be connected. Choose an available folder that does not overlap another project.", {
        statusCode: 409,
      });
    }
  },
});
