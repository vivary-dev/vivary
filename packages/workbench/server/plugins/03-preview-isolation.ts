import { defineNitroPlugin } from "@agent-native/core/server";
import type { H3Event } from "h3";

const FRAME_POLICY = "frame-ancestors 'none'";

export default defineNitroPlugin(nitroApp => {
  nitroApp.hooks.hook("request", (event: H3Event) => {
    // Preparing a header makes immutable redirect Responses writable to the response hook.
    event.res.headers.set("x-frame-options", "DENY");
    event.res.errHeaders.set("x-frame-options", "DENY");
  });
  nitroApp.hooks.hook("response", (response: Response) => {
    response.headers.set("x-frame-options", "DENY");
    // A separate policy enforces this rule even if an existing frame-ancestors directive permits other sites.
    response.headers.append("content-security-policy", FRAME_POLICY);
  });
});
