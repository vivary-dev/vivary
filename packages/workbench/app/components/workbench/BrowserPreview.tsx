import { RemoteProjectPreview } from './RemoteProjectPreview';
import { useBrowserHost } from "../layout/BrowserConnection";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { IconWorld, IconRefresh } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useNativeActionCaller } from "@/lib/native-actions";
import { isHostLocalPreview, previewPageUrl, previewStartRefused, type PreviewChatTarget } from "@/lib/workbench-preview";
import { projectPreviewResult, type ProjectPreviewInput, type ProjectPreviewResult, type ProjectPreviewScript } from "../../../shared/project-preview";

type Review = Extract<ProjectPreviewResult, { code: "review" }>;
type Discovery = Extract<ProjectPreviewResult, { code: "discovered" }>;
type Launch = Extract<ProjectPreviewResult, { launchId: string }>;
type Page = { url: string; host: string; embedding: "blocked" | "unknown"; checked: boolean; launchId?: string };
const isLaunch = (result: ProjectPreviewResult): result is Launch => "launchId" in result;

function IsolatedPage({ url, revision }: { url: string; revision: number }) {
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(timer);
  }, [url, revision]);
  const connect = useCallback((element: HTMLIFrameElement | null) => {
    if (!element || !("credentialless" in element)) return;
    // Install isolation before assigning a destination, including the first request.
    element.setAttribute("credentialless", "");
    element.src = previewPageUrl(url, window.location.origin);
  }, [url]);
  return <>
    <p className="preview-load-status shrink-0 px-3 py-1 text-xs text-muted-foreground" data-loaded={loaded} role="status">
      {loaded ? "Frame navigation finished. Check the page below." : slow ? "The page is taking longer to load. It may be unavailable or block embedding." : "Loading the preview…"}
    </p>
    <iframe key={`${url}:${revision}`} ref={connect} title="Running web preview"
      sandbox="allow-scripts allow-forms allow-same-origin" referrerPolicy="no-referrer"
      onLoad={() => setLoaded(true)} className="min-h-32 w-full flex-1 border-0 bg-white" />
  </>;
}

export function BrowserPreview({ projectId, projectName, chatTarget }: {
  projectId: string | null; projectName: string; chatTarget: PreviewChatTarget | null;
}) {
  const { call, ready } = useNativeActionCaller();
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [script, setScript] = useState<ProjectPreviewScript>("dev");
  const [address, setAddress] = useState("http://127.0.0.1:5173/");
  const [host, setHost] = useState("");
  const [run, setRun] = useState<Launch | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [pendingStart, setPendingStart] = useState<{ review: Review; requestId: string } | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [revision, setRevision] = useState(0);
  const [confirmedTarget, setConfirmedTarget] = useState<string | null>(null);
  const [isolated, setIsolated] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const generation = useRef(0);
  const polling = useRef(false);
  const selectionMode = useRef<"managed" | "manual">("managed");
  useEffect(() => {
    mounted.current = true;
    setIsolated("credentialless" in document.createElement("iframe"));
    return () => { mounted.current = false; generation.current += 1; };
  }, []);
  const invoke = useCallback(async (input: ProjectPreviewInput) =>
    projectPreviewResult.parse(await call("vivary-project-preview", input)), [call]);
  const receive = useCallback((result: ProjectPreviewResult) => {
    setHost(result.host);
    if (isLaunch(result)) {
      setRun(result);
      if (result.staleBinding || result.code === "stopped" || !result.processRunning) {
        setPage(current => {
          const sameServer = current?.host === result.host
            && new URL(current.url).origin === new URL(result.url).origin;
          return current?.launchId === result.launchId || sameServer ? null : current;
        });
      } else if (result.code === "ready" && selectionMode.current === "managed") {
        setPage({ url: result.url, host: result.host, embedding: result.embedding, checked: true, launchId: result.launchId });
      }
    } else if (result.code === "idle") setRun(null);
    else if (result.code === "discovered") {
      setDiscovery(result);
      setScript(current => result.scripts.some(item => item.script === current) ? current : result.scripts[0]?.script ?? "dev");
    } else if (result.code === "unsupported") setError(result.reason);
  }, []);

  useEffect(() => {
    if (!projectId || !ready) return;
    const version = generation.current;
    void Promise.allSettled([
      invoke({ operation: "status", projectId }), invoke({ operation: "discover", projectId }),
    ]).then(results => {
      if (!mounted.current || generation.current !== version) return;
      for (const result of results) {
        if (result.status === "fulfilled") receive(result.value);
        else setError(result.reason instanceof Error ? result.reason.message : "The preview could not be loaded.");
      }
    });
  }, [projectId, ready, invoke, receive]);
  useEffect(() => {
    if (!projectId || !ready || !run || run.code === "stopped") return;
    const timer = setInterval(() => {
      if (polling.current || busy) return;
      polling.current = true;
      const version = generation.current;
      void invoke({ operation: "status", projectId }).then(result => {
        if (mounted.current && generation.current === version) receive(result);
      }).catch(() => {
        if (mounted.current && generation.current === version) setError("The preview status could not be checked. Retry before starting another command.");
      }).finally(() => { polling.current = false; });
    }, 2000);
    return () => clearInterval(timer);
  }, [projectId, ready, run?.launchId, run?.code, busy, invoke, receive]);

  async function perform(work: () => Promise<void>) {
    if (busy) return;
    generation.current += 1;
    setBusy(true);
    setError("");
    setNotice("");
    try { await work(); }
    catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : "The preview request failed.");
        setSetupOpen(true);
      }
    }
    finally { if (mounted.current) setBusy(false); }
  }
  function chosenUrl() {
    return previewPageUrl(address.trim(), window.location.origin);
  }
  function reviewCommand(event: FormEvent) {
    event.preventDefault();
    if (!projectId) return;
    void perform(async () => {
      setReview(null);
      const result = await invoke({ operation: "review", projectId, script, url: chosenUrl() });
      if (!mounted.current) return;
      receive(result);
      if (result.code === "review") setReview(result);
    });
  }
  function startCommand(approval: { review: Review; requestId: string }) {
    if (!projectId) return;
    void perform(async () => {
      setPendingStart(approval);
      selectionMode.current = "managed";
      setPage(null);
      try {
        const result = await invoke({ operation: "start", projectId, script: approval.review.script,
          url: approval.review.url, requestId: approval.requestId, acceptedManifestDigest: approval.review.manifestDigest, reviewExpiresAt: approval.review.reviewExpiresAt });
        if (!mounted.current) return;
        receive(result);
        setPendingStart(null);
        setReview(null);
      } catch (cause) {
        // Only an explicit pre-launch refusal releases the saved request. Lost responses keep its identity.
        if (mounted.current && previewStartRefused(cause)) {
          setPendingStart(null);
          setReview(null);
        }
        throw cause;
      }
    });
  }
  function openExisting() {
    if (!projectId) return;
    void perform(async () => {
      const url = chosenUrl();
      selectionMode.current = "manual";
      setPage(null);
      if (!isHostLocalPreview(url)) {
        setPage({ url, host, embedding: "unknown", checked: false });
        setRevision(value => value + 1);
        return;
      }
      const result = await invoke({ operation: "inspect", projectId, url });
      if (!mounted.current) return;
      if (result.code !== "checked") { receive(result); return; }
      setHost(result.host);
      if (!result.reachable) { setPage(null); throw new Error(result.reason ?? "No server is available at this address on the selected host."); }
      setPage({ url: result.url, host: result.host, embedding: result.embedding, checked: true });
      setRevision(value => value + 1);
    });
  }
  const active = run && run.code !== "stopped" && run.pid !== null;
  const hostLocal = page && isHostLocalPreview(page.url);
  const pageKey = JSON.stringify([projectId, page?.host, page?.url]);
  const sameHost = confirmedTarget === pageKey;
  const canEmbed = page && isolated && new URL(page.url).origin !== window.location.origin && page.embedding !== "blocked" && (!hostLocal || sameHost);

  const browserHost = useBrowserHost();
  const [setupOpen, setSetupOpen] = useState(true);
  useEffect(() => {
    if (!browserHost && canEmbed) setSetupOpen(false);
  }, [browserHost, canEmbed, page?.url]);

  if (!projectId) return <section className="p-5 text-sm text-muted-foreground">Connect and select a project before opening its preview.</section>;
  return <section className="preview-page flex h-full min-h-0 flex-col" aria-label="Web preview">
    <div className="preview-controls shrink-0 border-b px-3 py-2">
      <Button size="sm" variant="outline" aria-label="Preview setup and server controls" aria-expanded={setupOpen} aria-controls="preview-setup" onClick={() => setSetupOpen(value => !value)}>Setup</Button>
      {!browserHost && <Button size="sm" variant="outline" aria-label="Refresh page" disabled={!canEmbed} onClick={() => setRevision(value => value + 1)}><IconRefresh className="size-4" aria-hidden />Refresh</Button>}
      {run && run.code !== "stopped" && <Button size="sm" variant="outline" aria-label="Stop preview command" disabled={!ready || busy} onClick={() => void perform(async () => {
        const result = await invoke({ operation: "stop", projectId, launchId: run.launchId });
        if (mounted.current) receive(result);
      })}>Stop</Button>}
    </div>
    {error && <p role="alert" className="preview-action-error shrink-0 border-b px-3 py-2 text-sm text-destructive">{error}</p>}
    <div id="preview-setup" hidden={!setupOpen} className="max-h-[60%] shrink-0 overflow-y-auto border-b border-border p-3 space-y-3">
      <p className="break-words text-xs text-muted-foreground">Preview for {projectName}{host ? ` on ${host}` : " on the connected host"}</p>
      <form onSubmit={reviewCommand} className="space-y-2">
        <label className="block text-xs" htmlFor="preview-address">{browserHost ? "Host preview address for the reviewed command" : "Project preview address"}</label>
        <Input id="preview-address" value={address} disabled={busy || !!pendingStart}
          onChange={event => { setAddress(event.target.value); setReview(null); }} placeholder="http://127.0.0.1:5173/" />
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 text-xs">Project script
            <select className="mt-1 block w-full rounded-md border border-border bg-background p-2" value={script}
              disabled={busy || !!pendingStart || !discovery?.scripts.length}
              onChange={event => { const selected = discovery?.scripts.find(item => item.script === event.target.value); if (selected) { setScript(selected.script); setReview(null); } }}>
              {discovery?.scripts.length ? discovery.scripts.map(item => <option key={item.script} value={item.script}>{item.script}</option>) : <option value="dev">No supported package script</option>}
            </select>
          </label>
          <Button type="submit" size="sm" disabled={!ready || busy || !!active || !!pendingStart || !discovery?.scripts.length}>Review command</Button>
          {!browserHost && <Button type="button" size="sm" variant="outline" disabled={!ready || busy} onClick={openExisting}>Open running page</Button>}
        </div>
      </form>
      {review && <div className="rounded-md border border-border p-3 space-y-2" aria-label="Review preview command">
        <p className="text-sm font-medium">Run this project command?</p>
        <p className="break-all text-xs">{review.folder} on {review.host}</p>
        <pre className="whitespace-pre-wrap break-all text-xs">{review.command}{"\n"}{review.scriptText}</pre>
        <p className="break-all text-xs">Address to check: {review.url}</p>
        <p className="text-xs text-muted-foreground">Review expires at {new Date(review.reviewExpiresAt).toLocaleTimeString()}.</p>
        <details className="text-xs"><summary className="cursor-pointer">Installed launcher</summary><p className="break-all">{review.launcher}</p></details>
        <p className="text-xs text-muted-foreground">This runs project code with your host account's file access. Scripts may run other project files. Opening a preview does not approve this command.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || !!pendingStart} onClick={() => startCommand({ review, requestId: crypto.randomUUID() })}>Approve and start</Button>
          <Button size="sm" variant="ghost" disabled={busy || !!pendingStart} onClick={() => setReview(null)}>Cancel</Button>
        </div>
      </div>}
      {pendingStart && <div role="status" className="text-sm space-y-2"><p>The start request has not been confirmed. Check the same request before starting another.</p><Button size="sm" disabled={busy} onClick={() => startCommand(pendingStart)}>Check start request</Button></div>}
      {run && <div className="space-y-2 text-xs" aria-label="Preview process">
        <p role="status">{run.code === "ready" ? "Server is responding" : run.code === "starting" ? "Starting the project command" : run.code === "stopped" ? "Preview command stopped" : run.reason}{run.pid ? ` · preview owner PID ${run.pid}` : ""}</p>
        {run.staleBinding && <p role="alert">This command belongs to an earlier folder connection. Stop it before starting a preview for the current folder.</p>}
        <details><summary className="cursor-pointer">Command and folder</summary><pre className="mt-1 whitespace-pre-wrap break-all">{run.command}{"\n"}{run.folder}{"\n"}{run.url}</pre>{run.code === "unavailable" && run.logTail && <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all">{run.logTail}</pre>}</details>
      </div>}
      {page && <>
        <p className="break-all text-xs">Requested page: {page.url}</p>
        {!browserHost && hostLocal && <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={sameHost} onChange={event => setConfirmedTarget(event.target.checked ? pageKey : null)} className="mt-0.5" /><span>This browser is running on {page.host}. Host-local addresses open on this device.</span></label>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!chatTarget} onClick={() => {
            if (chatTarget?.attach({ projectId, projectName, host: page.host, url: page.url })) setNotice("Preview attached to this conversation. Add your request and send when ready. Your draft is unchanged.");
            else setError("Open a Code conversation for this project before attaching the preview.");
          }}>Attach preview to chat</Button>
        </div>
        {!chatTarget && <p className="text-xs text-muted-foreground">Open a Code conversation for this project to ask its coding runtime to inspect the page.</p>}
        {!page.checked && <p className="text-xs text-muted-foreground">This external address has not been checked by the host.</p>}
      </>}
      {notice && <p className="text-xs" role="status">{notice}</p>}
      {!browserHost && <p className="shrink-0 border-t border-border px-3 py-2 text-xs text-muted-foreground">Refresh reloads the requested address. Links stay within the isolated preview. Your coding runtime supplies browser inspection tools. Sign-in flows may need a separately authorized browser session.</p>}
    </div>
    {isolated === false ? <p role="alert" className="p-4 text-sm">This browser cannot isolate preview credentials. Open Vivary in a browser that supports credentialless frames before embedding a page.</p>
      : page?.embedding === "blocked" ? <p role="alert" className="p-4 text-sm">The server blocks embedded previews. Ask the coding agent to inspect it in an isolated browser session.</p>
      : browserHost ? <RemoteProjectPreview projectId={projectId} launch={run} onOpen={() => setSetupOpen(false)} />
      : canEmbed ? <IsolatedPage url={page.url} revision={revision} />
      : <div className="m-auto max-w-sm px-6 py-8 text-center text-sm text-muted-foreground"><IconWorld className="mx-auto mb-3 size-7" />{page && hostLocal ? "Confirm this browser is on the selected host to open its local address." : "Review a project command to start it, or open an already running page."}</div>}
  </section>;
}
