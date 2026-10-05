import { defineNitroPlugin } from "@agent-native/core/server";
import { monitorEventLoopDelay } from "node:perf_hooks";

// Opt-in diagnostics for the built-app responsiveness probe. No timer or histogram
// exists in ordinary launches. Measurements are from the server, not the driver.
export default defineNitroPlugin(nitroApp => {
  if (process.env.VIVARY_PERF_METRICS !== "1") return; // guard:allow-env-credential - Opt-in performance diagnostics, not a credential.
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const timer = setInterval(() => {
    console.log("VIVARY_PERF_METRICS " + JSON.stringify({ at: Date.now(), pid: process.pid,
      rssBytes: process.memoryUsage().rss, eventLoopMs: { p50: delay.percentile(50) / 1e6,
        p90: delay.percentile(90) / 1e6, max: delay.max / 1e6 } }));
    delay.reset();
  }, 1000);
  timer.unref();
  nitroApp.hooks.hook("close", () => { clearInterval(timer); delay.disable(); });
});
