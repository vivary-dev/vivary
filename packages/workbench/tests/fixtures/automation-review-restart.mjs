import path from "node:path";
import { pathToFileURL } from "node:url";
const [coreRoot, owner] = process.argv.slice(2);
const load = name => import(pathToFileURL(path.join(coreRoot, "dist", name)).href);
const [{ createResourceScriptEntries }, { runWithRequestContext }, store, { loadResourcesForPrompt }, { closeDbExec }] =
  await Promise.all([load("server/agent-chat/script-entries.js"), load("server/request-context.js"),
    load("resources/store.js"), load("server/agent-chat/prompt-resources.js"), load("db/client.js")]);
const review = (await import("../../actions/vivary-automation-files.ts")).default;
try {
  const entries = await createResourceScriptEntries();
  const read = await runWithRequestContext({ userEmail: owner }, () =>
    entries.resources.run({ action: "read", path: "AGENTS.md", scope: "personal" }, { caller: "tool" }));
  const prompt = await runWithRequestContext({ userEmail: owner }, () =>
    loadResourcesForPrompt(owner, true, "workbench", undefined, { disabledFrameworkGroups: ["workspaceApps"] }));
  const files = (await review.run({ operation: "list" }, { userEmail: owner })).files;
  console.log(JSON.stringify({ proposed: (await store.resourceGetByPath(owner, "AGENTS.md")).content,
    read: String(read), prompt, listed: files.find(file => file.path === "AGENTS.md")?.content }));
} finally {
  await closeDbExec();
}
