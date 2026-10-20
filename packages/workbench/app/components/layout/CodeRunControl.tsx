import { CodexRequestFields, requestTitle, object } from "./CodexRequestFields";
import { useState } from "react";
import { useNavigate } from "react-router";
import { actionErrorMessage, useActionQuery } from "@agent-native/core/client/hooks";
import { Button } from "@agent-native/toolkit/ui";
import { useConversationRouteHold } from "../../lib/conversation-route-hold";
import { useNativeActionCaller } from "../../lib/native-actions";
import { useProjects } from "../projects/ProjectContext";
import type { VivaryCodeActiveRun, VivaryCodeHostState, VivaryCodePendingApproval } from "../../../server/local-code-agent";

function failureMessage(failure: unknown): string {
  return actionErrorMessage(failure) ?? (failure instanceof Error ? failure.message : "The request could not finish. Try again.");
}

/**
 * The host strip. It lists each running Code conversation with its own approvals and its own Stop, so acting on one
 * never answers or stops another.
 */
export function CodeRunControl() {
  const status = useActionQuery<VivaryCodeHostState>("vivary-code-state", { scope: "host" }, {
    refetchInterval: 1000, retry: false,
  });
  const { call, ready, retrySession } = useNativeActionCaller();
  const { selectProject, catalog, activeProject, checking } = useProjects();
  const activeProjectId = activeProject?.projectId ?? null;
  const navigate = useNavigate();
  const routeHold = useConversationRouteHold({ activeProjectId, checking });
  const [error, setError] = useState<string>();
  const cleanup = status.data?.cleanup;
  // Issue #121. A run stays active while its failed stop's own check runs. The strip shows that check in its place.
  const runs = (status.data?.activeRuns ?? []).filter(run => !(cleanup?.checking && cleanup.run?.id === run.id));
  const recent = status.data?.recentRun;
  // Issue #121. Which cleanup choice is running.
  const [resolving, setResolving] = useState<"end" | "continue" | null>(null);
  const projectLabel = (projectId: string | null) => projectId
    ? catalog?.projects.find(project => project.projectId === projectId)?.displayName ?? "Unavailable project"
    : "Personal workspace";

  async function settle(action: Promise<unknown>) {
    setError(undefined);
    try { await action; }
    catch (failure) { setError(failureMessage(failure)); }
    finally { await status.refetch(); }
  }

  // Issue #121. The buttons keep focus while a choice or a check runs, so they ignore clicks instead of disabling.
  async function resolveCleanup(decision: "end" | "continue") {
    if (!ready || resolving || !cleanup || cleanup.checking) return;
    setResolving(decision);
    setError(undefined);
    try {
      // The version names the list on screen, so the server refuses a choice about a list that changed since.
      const next = await call<VivaryCodeHostState>("vivary-code-cleanup", { decision, version: cleanup.version });
      // The strip closes, so focus moves to the page instead of being lost. Otherwise the server's notice says what
      // End them did.
      if (!next.cleanup) document.getElementById("workbench-content")?.focus();
      await status.refetch();
    } catch (failure) {
      setError(failureMessage(failure));
      await status.refetch();
    } finally { setResolving(null); }
  }

  async function openConversation(target: { id: string; projectId: string | null }) {
    setError(undefined);
    const href = "/?run=" + encodeURIComponent(target.id);
    if (!checking && target.projectId === activeProjectId) {
      navigate(href);
      return;
    }
    // The project change clears the route and the new project restores its saved view, so the target route is held.
    const release = routeHold.hold(target.projectId, href);
    // An older click that fails late leaves a newer click's hold and says nothing, because the owner moved on.
    if (!await selectProject(target.projectId) && release()) {
      setError(runs.some(run => run.id === target.id) ? "The project is unavailable. You can still deny or stop its work here." : "The project is unavailable. Its conversation history is retained.");
    }
  }

  if (!runs.length && !cleanup && !status.error) return null;
  const cleanupHeld = !ready || resolving !== null || cleanup?.checking === true;
  const cleanupRun = cleanup?.run;
  return <section aria-label="Agent work" className="shrink-0 border-b px-4 py-3 text-sm">
    {runs.length > 0 && <ul className="flex max-h-[60vh] flex-col gap-2 overflow-auto" aria-label="Running conversations">
      {runs.map(run => <ActiveRunItem key={run.id} run={run} projectLabel={projectLabel(run.projectId)} ready={ready}
        onOpen={() => void openConversation(run)}
        onStop={() => settle(call("vivary-code-stop", { runId: run.id, projectId: run.projectId ?? undefined }))}
        onDecide={(request, decision) => settle(call(decision.allow ? "vivary-code-approve" : "vivary-code-deny", {
          runId: request.runId, requestId: request.requestId, projectId: request.projectId ?? undefined,
          ...(decision.allow ? { answers: decision.answers, content: decision.content } : {}),
        }))} />)}
    </ul>}
    {cleanup ? <div className={`flex flex-col gap-2${runs.length ? " mt-3" : ""}`} role="region" aria-label="Leftover coding processes">
      <h2 className="font-semibold">{cleanup.heading}</h2>
      {cleanup.remaining.length > 0 && <ul className="max-h-32 overflow-auto break-words">
        {cleanup.remaining.map(leftover => <li key={leftover.pid}>
          {leftover.name} (PID {leftover.pid}{leftover.confirmed ? "" : ", not confirmed from that run"})
        </li>)}
        {cleanup.unlisted > 0 && <li>and {cleanup.unlisted} more not listed</li>}
      </ul>}
      {cleanup.notice && <p className="break-words" role="status">{cleanup.notice}</p>}
      <p className="break-words text-xs text-muted-foreground">{withCommands(cleanup.instruction)}</p>
      <div className="flex flex-wrap items-center gap-2">
        {cleanup.canEnd && <Button size="sm" aria-disabled={cleanupHeld || undefined} onClick={() => void resolveCleanup("end")}>
          {resolving === "end" ? "Ending…" : cleanup.checking ? "Checking…" : "End them"}
        </Button>}
        {cleanup.canContinue && <Button size="sm" variant="outline" aria-disabled={cleanupHeld || undefined}
          onClick={() => void resolveCleanup("continue")}>{resolving === "continue" ? "Continuing…" : "Continue anyway"}</Button>}
        {cleanupRun && <Button variant="ghost" size="sm" onClick={() => void openConversation(cleanupRun)}>Open conversation</Button>}
      </div>
    </div> : !runs.length && recent ? <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1" role="status">{recent.phase === "approval-denied"
        ? "Request denied. No agent work started" : recent.phase === "interrupted"
          ? "Agent work was interrupted" : recent.status === "completed"
            ? "Agent work completed" : recent.status === "errored"
              ? "Agent work failed" : "Agent work stopped"} in {projectLabel(recent.projectId)}: {recent.title}</span>
      <Button variant="ghost" size="sm" onClick={() => void openConversation(recent)}>Open conversation</Button>
    </div> : !runs.length && <div className="flex items-center gap-2">
      <span role="status">Agent status could not be loaded.</span>
      <Button variant="ghost" size="sm" onClick={() => void status.refetch()}>Retry</Button>
    </div>}
    {!ready && <Button size="sm" variant="outline" onClick={retrySession}>Retry session</Button>}
    {error && <p className="mt-2 text-destructive" role="alert">{error}</p>}
  </section>;
}

type ApprovalDecision = { allow: false } | { allow: true; answers: Record<string, string[]>; content: Record<string, unknown> };

/** One running conversation: what it is, where, its pending requests, and a Stop that ends only this run. */
function ActiveRunItem({ run, projectLabel, ready, onOpen, onStop, onDecide }: {
  run: VivaryCodeActiveRun;
  projectLabel: string;
  ready: boolean;
  onOpen: () => void;
  onStop: () => Promise<void>;
  onDecide: (request: VivaryCodePendingApproval, decision: ApprovalDecision) => Promise<void>;
}) {
  const [stopping, setStopping] = useState(false);
  return <li className="flex flex-col gap-2" aria-label={run.title}>
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1" role="status">{run.stopping ? "Stopping" : "Agent working"} in {projectLabel} ({run.engineLabel}): {run.title}</span>
      <Button variant="ghost" size="sm" onClick={onOpen}>Open conversation</Button>
      <Button variant="outline" size="sm" disabled={!ready || stopping || run.stopping}
        aria-label={`Stop ${run.title}`} onClick={() => {
          setStopping(true);
          void onStop().finally(() => setStopping(false));
        }}>{stopping || run.stopping ? "Stopping…" : "Stop"}</Button>
    </div>
    {run.pendingApprovals.map(request => <ApprovalCard key={request.requestId} request={request} ready={ready}
      onDecide={decision => onDecide(request, decision)} />)}
  </li>;
}

/** A Codex request of one run. Its answers stay with this card, so two pending requests never share input. */
function ApprovalCard({ request, ready, onDecide }: {
  request: VivaryCodePendingApproval;
  ready: boolean;
  onDecide: (decision: ApprovalDecision) => Promise<void>;
}) {
  const [working, setWorking] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [content, setContent] = useState<Record<string, unknown>>(() => {
    const values: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(object(object(request.params.requestedSchema).properties))) {
      const field = object(raw);
      if (field.default != null) values[key] = field.default;
      else if (field.type === "boolean") values[key] = false;
      else if (field.type === "array") values[key] = [];
    }
    return values;
  });
  function decide(decision: ApprovalDecision) {
    if (working) return;
    setWorking(true);
    void onDecide(decision).finally(() => setWorking(false));
  }
  return <div className="flex flex-col gap-3 rounded-lg bg-black/5 p-3 dark:bg-black/20" role="region"
    aria-label={`Codex request: ${request.title}`}>
    <h2 className="font-semibold">{requestTitle(request.method)}</h2>
    <p className="text-xs text-muted-foreground">{request.workspaceLabel} · Codex · {request.title}</p>
    <CodexRequestFields request={request} answers={answers} content={content} setAnswers={setAnswers} setContent={setContent} />
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={!ready || working} onClick={() => decide({ allow: true, answers, content })}>
        {request.method.includes("requestApproval") ? "Allow once" : "Continue"}</Button>
      <Button size="sm" variant="outline" disabled={!ready || working} onClick={() => decide({ allow: false })}>Decline</Button>
    </div>
  </div>;
}

/** Issue #121. The server marks commands with backticks. Code spans wrap anywhere, so a long command stays on screen. */
function withCommands(text: string) {
  return text.split("`").map((part, index) => index % 2 ? <code key={index} className="break-all">{part}</code> : part);
}
