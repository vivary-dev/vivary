import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { Plugin } from "vite";

const codeWorkerEntry = fileURLToPath(new URL("./server/code-execution-worker.ts", import.meta.url));
const resolveDependency = createRequire(import.meta.url).resolve;

export default {
  // Only the SDK's dynamic worker entry needs tracing, including resources/notices.
  // Tracing peers externalizes competing versions and disrupts Core/app bundling.
  traceDeps: ["@anthropic-ai/claude-agent-sdk*"],
  traceOpts: {
    hooks: {
      traceStart(files: string[]) {
        files.push(resolveDependency("@anthropic-ai/claude-agent-sdk"));
      },
    },
  },
  rollupConfig: {
    plugins: [{
      name: "vivary-code-worker",
      buildStart() {
        this.emitFile({
          type: "chunk",
          id: codeWorkerEntry,
          fileName: "vivary-code-worker.mjs",
          preserveSignature: "strict",
        });
      },
    } satisfies Plugin],
  },
};
