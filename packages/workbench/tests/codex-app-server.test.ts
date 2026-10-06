import assert from "node:assert/strict";
import { createCodeAgentRunRecord, executeCodeAgentRun, getCodeAgentRunRecord } from "@agent-native/core/code-agents";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

type Request = { requestId: string; method: string; params: Record<string, unknown> };
const workbench = fileURLToPath(new URL("../", import.meta.url));
// guard:allow-env-credential - Disposable test paths and fixture behavior, not credentials.
const core = process.env.VIVARY_CORE_TEST_ROOT ?? path.join(workbench, "node_modules/@agent-native/core");
const { runCodexAppServer } = await import(pathToFileURL(path.join(core, "dist/cli/codex-app-server-executor.js")).href);

async function fixture(t: { after(fn: () => Promise<void>): void }, mode = "complete") {
  const root = await mkdtemp(path.join(tmpdir(), "vivary app server "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, "fake codex app server.mjs");
  const receipt = path.join(root, "messages.json");
  await writeFile(script, `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
// guard:allow-env-credential - Disposable test paths and fixture behavior, not credentials.
const mode=process.env.FIXTURE_MODE, messages=[];
const emit=message=>process.stdout.write(JSON.stringify(message)+"\\n");
const reply=(id,result)=>emit({id,result});
const notify=(method,params)=>emit({method,params});
const threadId="native-thread-1", turnId="native-turn-1";
const scope={threadId,turnId};
const done=(status="completed")=>notify("turn/completed",{threadId,turn:{id:turnId,status,items:[]}});
const request=(method,params={})=>emit({id:17,method,params:{...scope,itemId:"item-1",...params}});
const rl=createInterface({input:process.stdin});
rl.on("line",line=>{
 const message=JSON.parse(line); messages.push(message);
// guard:allow-env-credential - Disposable test paths and fixture behavior, not credentials.
 writeFileSync(process.env.FIXTURE_RECEIPT,JSON.stringify({pid:process.pid,args:process.argv.slice(2),messages}));
 if (message.method==="initialize") reply(message.id,{});
 if (message.method==="thread/start" || message.method==="thread/resume") {
  const p=message.params;
  reply(message.id,{thread:{id:threadId},cwd:p.cwd,model:mode==="bad-model"?"other-model":p.model,
   modelProvider:"openai",approvalPolicy:p.approvalPolicy,approvalsReviewer:"user",
   sandbox:p.sandbox==="read-only"?{type:"readOnly",networkAccess:false}:p.sandbox==="danger-full-access"?{type:"dangerFullAccess"}:
   {type:"workspaceWrite",networkAccess:false,writableRoots:mode==="wide-roots"?["/outside-project"]:[]}});
 }
 if (message.method==="thread/read") {
  const id=message.params.threadId;
  const parent=mode==="child-unrelated"?"foreign-root":mode==="child-cycle"?id:id==="grandchild-1"?"child-1":threadId;
  const response={thread:{id,parentThreadId:id==="foreign-root"?null:parent}};
  if(mode==="child-root-during-lookup") setTimeout(()=>reply(message.id,response),30); else reply(message.id,response);
 }
 if(message.method==="thread/turns/list") {
  reply(message.id,{data:[{id:"v2-child-turn",status:mode==="v2-failed"?"failed":"completed",
   ...(mode==="v2-failed"?{error:{message:"Native child failed."}}:{}),
   items:mode==="v2-failed"?[]:[{id:"v2-final",type:"agentMessage",phase:"final_answer",text:"Native child result."}]}]});
 }
 if (message.method==="turn/start") {
  reply(message.id,{turn:{id:turnId,status:"inProgress",items:[]}});
  notify("turn/started",{threadId,turn:{id:turnId,status:"inProgress",items:[]}});
  notify("item/completed",{...scope,item:{id:"commentary-1",type:"agentMessage",phase:"commentary",text:"Reading the project."}});
  if(mode.startsWith("v2-")) {
   notify("item/completed",{...scope,item:{id:"native-start-1",type:"subAgentActivity",kind:"started",agentThreadId:"v2-child",agentPath:"/root/native_check"}});
   if(mode==="v2-live") {
    notify("turn/started",{threadId:"v2-child",turn:{id:"v2-child-turn",status:"inProgress",items:[]}});
    notify("item/completed",{threadId:"v2-child",turnId:"v2-child-turn",item:{id:"v2-final",type:"agentMessage",phase:"final_answer",text:"Native child result."}});
    notify("turn/completed",{threadId:"v2-child",turn:{id:"v2-child-turn",status:"completed",items:[]}});
   }
   notify("item/completed",{...scope,item:{id:"different-native-complete-2",type:"subAgentActivity",kind:"completed",agentThreadId:"v2-child",agentPath:"/root/native_check"}});
   done();
  }
  else if(mode.startsWith("child-") || mode==="grandchild") {
   const childId=mode==="grandchild"?"grandchild-1":"child-1";
   notify("item/started",{...scope,item:{id:"spawn-1",type:"collabAgentToolCall",tool:"spawnAgent",status:"inProgress",senderThreadId:threadId,receiverThreadIds:[],agentsStates:{}}});
   notify("turn/started",{threadId:childId,turn:{id:"child-turn-1",status:"inProgress",items:[]}});
   notify("item/started",{...scope,item:{id:"shared-item",type:"fileChange",status:"inProgress",changes:[{path:"root.txt",diff:"+root"}]}});
   notify("item/started",{threadId:childId,turnId:"child-turn-1",item:{id:"shared-item",type:"fileChange",status:"inProgress",changes:[{path:"child.txt",diff:"+child"}]}});
   emit({id:17,method:mode==="child-file"?"item/fileChange/requestApproval":"item/commandExecution/requestApproval",
    params:{threadId:childId,turnId:mode==="child-stale"?"wrong-turn":"child-turn-1",itemId:"shared-item",command:"read child fixture"}});
   if(mode==="child-root-during-lookup") done();
   if(mode==="child-resolved") setTimeout(()=>{notify("serverRequest/resolved",{threadId:childId,requestId:17});notify("turn/completed",{threadId:childId,turn:{id:"child-turn-1",status:"completed",items:[]}});done();},40);
  }
  else if(mode==="command" || mode==="readonly-request") request("item/commandExecution/requestApproval",{command:"echo fixture",cwd:process.cwd(),reason:"Command access"});
  else if(mode==="file") {
   notify("item/started",{...scope,item:{id:"item-1",type:"fileChange",status:"inProgress",changes:[]}});
   notify("item/fileChange/patchUpdated",{...scope,itemId:"item-1",changes:[{path:"note.txt",diff:"+approved",kind:{type:"add"}}]});
   request("item/fileChange/requestApproval",{reason:"Write note"});
  } else if(mode==="permissions") request("item/permissions/requestApproval",{cwd:process.cwd(),permissions:{network:{enabled:true}}});
  else if(mode==="nullable-elicitation") request("mcpServer/elicitation/request",{turnId:null,serverName:"fixture",mode:"form",message:"Name",requestedSchema:{type:"object",properties:{name:{type:"string"}}}});
  else if(mode==="resolved") { request("item/tool/requestUserInput",{questions:[]}); notify("serverRequest/resolved",{threadId,requestId:17}); done(); }
  else if(mode==="unsupported") request("unknown/request",{});
  else if(mode==="abort" || mode==="disconnect") { if(mode==="disconnect") process.exit(2); }
  else {
   notify("item/completed",{...scope,item:{id:"collab-1",type:"collabAgentToolCall",tool:"spawnAgent",status:"completed",senderThreadId:threadId,receiverThreadIds:["child-1"],agentsStates:{"child-1":{status:"running"}}}});
   notify("item/completed",{...scope,item:{id:"final-1",type:"agentMessage",phase:"final_answer",text:"Done."}});
   notify("turn/completed",{threadId:"child-1",turn:{id:"child-turn-1",status:"completed",items:[]}});
   done();
  }
 }
 if(message.method==="turn/interrupt") { reply(message.id,{}); done("interrupted"); }
 if(message.id===17 && ("result" in message || "error" in message)) {
  if(mode.startsWith("child-") || mode==="grandchild") {
   const childId=mode==="grandchild"?"grandchild-1":"child-1";
   notify("item/completed",{...scope,item:{id:"spawn-1",type:"collabAgentToolCall",tool:"spawnAgent",status:"completed",senderThreadId:threadId,receiverThreadIds:[childId],agentsStates:{[childId]:{status:"running"}}}});
   if(mode==="child-after-root") done();
   setTimeout(()=>{
    notify("item/completed",{threadId:childId,turnId:"child-turn-1",item:{id:"child-final",type:"agentMessage",phase:"final_answer",text:"Child finished."}});
    notify("turn/completed",{threadId:childId,turn:{id:"child-turn-1",status:"completed",items:[]}});
    if(mode!=="child-after-root" && mode!=="child-root-during-lookup") setTimeout(()=>done(),40);
   },60);
  } else done();
 }
});
`);
  const calls: Request[] = [];
  const resolved: string[] = [];
  const notifications: { method: string; params: Record<string, unknown> }[] = [];
  const options = {
    command: process.execPath, argsPrefix: [script], env: { ...process.env, FIXTURE_MODE: mode, FIXTURE_RECEIPT: receipt },
    cwd: root, prompt: "Read the project.", model: "gpt-6-astra", permissionMode: "normal",
    onRequest: async (request: Request) => { calls.push(request); return { decision: "accept" }; },
    onRequestResolved: (requestId: string) => { resolved.push(requestId); },
    onNotification: (method: string, params: Record<string, unknown>) => { notifications.push({ method, params }); },
  };
  return { root, options, calls, resolved, notifications,
    receipt: async () => JSON.parse(await readFile(receipt, "utf8")) };
}

test("Native Code records Codex continuity on the existing run", async t => {
  const f = await fixture(t);
  const native = await mkdtemp(path.join(tmpdir(), "vivary-codex-session-record-"));
  const previous = process.env.AGENT_NATIVE_CODE_AGENTS_HOME;
  process.env.AGENT_NATIVE_CODE_AGENTS_HOME = native;
  t.after(async () => {
    if (previous === undefined) delete process.env.AGENT_NATIVE_CODE_AGENTS_HOME;
    else process.env.AGENT_NATIVE_CODE_AGENTS_HOME = previous;
    await rm(native, { recursive: true, force: true });
  });
  const run = createCodeAgentRunRecord({ title: "Fixture", goalId: "vivary-local-code", cwd: f.root,
    permissionMode: "auto-edit", metadata: { engine: "codex-cli" } });
  const codexCli = { ...f.options, permissionMode: "normal" as const, configMode: "native" as const };
  const first = await executeCodeAgentRun({ runId: run.id, prompt: "First question", model: "gpt-6-astra", codexCli,
    streamToolOutputToStdout: false });
  assert.equal(first?.metadata?.codexSessionId, "native-thread-1");
  assert.equal(first?.metadata?.providerSessionMode, "new-session");
  assert.equal(getCodeAgentRunRecord(run.id)?.metadata?.codexSessionId, "native-thread-1");
  const second = await executeCodeAgentRun({ runId: run.id, prompt: "Follow up", codexCli,
    streamToolOutputToStdout: false });
  assert.equal(second?.metadata?.codexSessionId, "native-thread-1");
  assert.equal(second?.metadata?.providerSessionMode, "native-resume");
  assert.equal((await f.receipt()).messages.some(message => message.method === "thread/start"), false);
});

test("app-server starts a bounded native thread and preserves commentary and agent notifications", async t => {
  const f = await fixture(t);
  let session;
  const result = await runCodexAppServer({ ...f.options, onThread: value => { session = value; } });
  assert.equal(result.status, "completed");
  assert.deepEqual(session, { threadId: "native-thread-1", model: "gpt-6-astra" });
  const receipt = await f.receipt();
  assert.deepEqual(receipt.args, ["app-server", "--listen", "stdio://"]);
  const setup = receipt.messages.find(message => message.method === "thread/start").params;
  assert.equal(setup.approvalPolicy, "on-request");
  assert.equal(setup.approvalsReviewer, "user");
  assert.equal(setup.sandbox, "workspace-write");
  assert.deepEqual(setup.config.sandbox_workspace_write.writable_roots, []);
  assert.equal(receipt.messages.find(message => message.method === "turn/start").params.collaborationMode.mode, "default");
  assert.ok(f.notifications.some(({params}) => params.item?.phase === "commentary"));
  assert.ok(f.notifications.some(({params}) => params.item?.type === "collabAgentToolCall"));
  assert.throws(() => process.kill(receipt.pid, 0), { code: "ESRCH" });
});

test("follow-up resumes the exact native session and applies the selected mode", async t => {
  const f = await fixture(t);
  const result = await runCodexAppServer({ ...f.options, threadId: "native-thread-1", permissionMode: "yolo" });
  assert.equal(result.status, "completed");
  const messages = (await f.receipt()).messages;
  assert.equal(messages.some(message => message.method === "thread/start"), false);
  const resumed = messages.find(message => message.method === "thread/resume").params;
  assert.equal(resumed.threadId, "native-thread-1");
  assert.equal(resumed.sandbox, "danger-full-access");
  assert.equal(resumed.approvalPolicy, "never");
  assert.deepEqual(messages.find(message => message.method === "turn/start").params.sandboxPolicy, { type: "dangerFullAccess" });
});

test("command approval waits for a decision and replies using the original wire ID", async t => {
  const f = await fixture(t, "command");
  let answer;
  const decision = new Promise(resolve => { answer = resolve; });
  let settled = false;
  const result = runCodexAppServer({ ...f.options, onRequest: async request => {
    f.calls.push(request); return decision;
  } }).then(value => { settled = true; return value; });
  for (let i = 0; i < 100 && !f.calls.length; i++) await delay(10);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].requestId, /^[a-f0-9-]{36}$/);
  await delay(50);
  assert.equal(settled, false);
  answer({ decision: "decline" });
  assert.equal((await result).status, "completed");
  assert.deepEqual((await f.receipt()).messages.find(message => message.id === 17).result, { decision: "decline" });
  assert.deepEqual(f.resolved, [f.calls[0].requestId]);
});

test("file approval includes the exact observed patch", async t => {
  const f = await fixture(t, "file");
  assert.equal((await runCodexAppServer(f.options)).status, "completed");
  assert.deepEqual(f.calls[0].params.item.changes, [{ path: "note.txt", diff: "+approved", kind: { type: "add" } }]);
});

test("permission requests grant only the callback response", async t => {
  const f = await fixture(t, "permissions");
  const response = { permissions: {}, scope: "turn" };
  assert.equal((await runCodexAppServer({ ...f.options, onRequest: async request => {
    f.calls.push(request); return response;
  } })).status, "completed");
  assert.deepEqual((await f.receipt()).messages.find(message => message.id === 17).result, response);
});

test("read-only denies unexpected action approval without asking the host", async t => {
  const f = await fixture(t, "readonly-request");
  assert.equal((await runCodexAppServer({ ...f.options, permissionMode: "read-only" })).status, "completed");
  assert.equal(f.calls.length, 0);
  assert.deepEqual((await f.receipt()).messages.find(message => message.id === 17).result, { decision: "decline" });
});

test("resolved server requests are cleared once and do not block turn completion", async t => {
  const f = await fixture(t, "resolved");
  const result = await runCodexAppServer({ ...f.options, onRequest: request => {
    f.calls.push(request); return new Promise(() => {});
  } });
  assert.equal(result.status, "completed");
  assert.deepEqual(f.resolved, [f.calls[0].requestId]);
});

test("Stop interrupts the active turn before terminating the child", async t => {
  const f = await fixture(t, "abort");
  const controller = new AbortController();
  const result = await runCodexAppServer({ ...f.options, signal: controller.signal,
    onNotification: method => { if (method === "turn/started") controller.abort(); } });
  assert.equal(result.status, "interrupted");
  const receipt = await f.receipt();
  assert.deepEqual(receipt.messages.find(message => message.method === "turn/interrupt").params,
    { threadId: "native-thread-1", turnId: "native-turn-1" });
  assert.throws(() => process.kill(receipt.pid, 0), { code: "ESRCH" });
});

for (const mode of ["wide-roots", "bad-model"]) test(`effective ${mode} mismatch refuses the turn`, async t => {
  const f = await fixture(t, mode);
  assert.equal((await runCodexAppServer(f.options)).status, "failed");
  assert.equal((await f.receipt()).messages.some(message => message.method === "turn/start"), false);
});

test("unsupported requests and disconnections fail visibly", async t => {
  for (const mode of ["unsupported", "disconnect"]) {
    const f = await fixture(t, mode);
    const result = await runCodexAppServer(f.options);
    assert.equal(result.status, "failed");
    assert.ok(result.error);
    assert.equal(f.calls.length, 0);
  }
});


test("MCP elicitation accepts a nullable turn correlation", async t => {
  const f = await fixture(t, "nullable-elicitation");
  const result = await runCodexAppServer({ ...f.options, onRequest: async request => {
    f.calls.push(request); return { action: "decline" };
  } });
  assert.equal(result.status, "completed");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].params.turnId, null);
  assert.deepEqual((await f.receipt()).messages.find(message => message.id === 17).result, { action: "decline" });
});


for (const mode of ["child-early", "grandchild", "child-file"]) test(`${mode} verifies ancestry before presenting native approval`, async t => {
  const f = await fixture(t, mode);
  const result = await runCodexAppServer(f.options);
  assert.equal(result.status, "completed");
  assert.equal(f.calls.length, 1);
  const childId = mode === "grandchild" ? "grandchild-1" : "child-1";
  assert.equal(f.calls[0].params.agentThreadId, childId);
  assert.equal(f.calls[0].params.turnId, "child-turn-1");
  if (mode === "child-file") assert.equal(f.calls[0].params.item.changes[0].path, "child.txt");
  const messages = (await f.receipt()).messages;
  assert.ok(messages.some(message => message.method === "thread/read" && message.params.threadId === childId && message.params.includeTurns === false));
  assert.equal(f.notifications.some(({params}) => params.item?.id === "child-final"), false);
  assert.ok(f.notifications.some(({params}) => params.item?.agentsStates?.[childId]?.status === "completed"));
  assert.ok(f.notifications.some(({params}) => params.item?.agentsStates?.[childId]?.message === "Child finished."));
});

for (const mode of ["child-unrelated", "child-cycle", "child-stale"]) test(`${mode} refuses foreign or stale requests`, async t => {
  const f = await fixture(t, mode);
  const result = await runCodexAppServer(f.options);
  assert.equal(result.status, "failed");
  assert.equal(f.calls.length, 0);
});

test("root completion waits for a verified active child", async t => {
  const f = await fixture(t, "child-after-root");
  const result = await runCodexAppServer(f.options);
  assert.equal(result.status, "completed");
  assert.ok(f.notifications.some(({params}) => params.item?.agentsStates?.["child-1"]?.status === "completed"));
  assert.equal(f.notifications.filter(event => event.method === "turn/completed").length, 1);
});

test("child request resolution clears only its request and child completion does not finish the root", async t => {
  const f = await fixture(t, "child-resolved");
  const result = await runCodexAppServer({ ...f.options, onRequest: request => {
    f.calls.push(request); return new Promise(() => {});
  } });
  assert.equal(result.status, "completed");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.resolved, [f.calls[0].requestId]);
  assert.equal(f.notifications.filter(event => event.method === "turn/completed").length, 1);
});


test("root completion during ancestry verification waits for the child and its approval", async t => {
  const f = await fixture(t, "child-root-during-lookup");
  const result = await runCodexAppServer(f.options);
  assert.equal(result.status, "completed");
  assert.equal(f.calls.length, 1);
  assert.ok(f.notifications.some(({params}) => params.item?.agentsStates?.["child-1"]?.status === "completed"));
  assert.equal(f.notifications.filter(event => event.method === "turn/completed").length, 1);
});


for (const mode of ["v2-summary", "v2-live", "v2-failed"]) test(`${mode} retains actual native activity identity and contained child output`, async t => {
  const f = await fixture(t, mode);
  const result = await runCodexAppServer(f.options);
  assert.equal(result.status, "completed");
  const activities = f.notifications.filter(({params}) => params.item?.type === "subAgentActivity");
  assert.ok(activities.some(({params}) => params.item.id === "native-start-1" && params.item.agentPath === "/root/native_check"));
  assert.ok(activities.some(({params}) => params.item.id === "different-native-complete-2" && params.item.agentThreadId === "v2-child"));
  const last = activities.at(-1).params.agentState;
  assert.equal(last.status, mode === "v2-failed" ? "errored" : "completed");
  assert.equal(last.message, mode === "v2-failed" ? "Native child failed." : "Native child result.");
  assert.equal(f.notifications.some(({params}) => params.item?.id === "v2-final"), false);
  const reads = (await f.receipt()).messages.filter(message => message.method === "thread/turns/list");
  assert.equal(reads.length, mode === "v2-live" ? 0 : 1);
  if (reads.length) assert.deepEqual(reads[0].params, { threadId: "v2-child", limit: 1, sortDirection: "desc", itemsView: "summary" });
});
