import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { refreshPreviewDocument } from '@/lib/workbench-preview';
import { Button } from '@/components/ui/button';
import { useNativeActionCaller } from '@/lib/native-actions';
import { projectPreviewResult } from '../../../shared/project-preview';

import { previewHandoff as handoff } from '../../../shared/remote-preview';
// Credentialless storage belongs to the entire app document, not the React component or iframe.
let documentPreview: { id: string; identity: string | null; blocked: boolean; close: (() => Promise<void>) | null } | undefined;
function currentDocument() {
  if (!documentPreview) {
    const state = { id: crypto.randomUUID(), identity: null, blocked: false, close: null };
    documentPreview = state;
    window.addEventListener('pageshow', event => { if (event.persisted && documentPreview) { documentPreview.blocked = true; void documentPreview.close?.().catch(() => undefined); } });
    window.addEventListener('pagehide', () => { if (documentPreview) documentPreview.blocked = true; });
  }
  return documentPreview;
}
export function RemoteProjectPreview({ projectId, launch, onOpen }: { projectId: string; onOpen: () => void; launch: Extract<z.infer<typeof projectPreviewResult>, { launchId: string }> | null }) {
  const { call, ready } = useNativeActionCaller();
  const [frame, setFrame] = useState<{ origin: string; ticket: string; nonce: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(false);
  const [saved, setSaved] = useState(false);
  const iframe = useRef<HTMLIFrameElement | null>(null);
  const alive = useRef(true);
  const sequence = useRef(0);
  async function close() {
    const state = currentDocument();
    if (iframe.current) { iframe.current.hidden = true; iframe.current.src = 'about:blank'; }
    setFrame(null);
    await call('vivary-remote-preview', { operation: 'close', documentId: state.id });
  }
  useEffect(() => {
    alive.current = true;
    const restored = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      currentDocument().blocked = true; setReload(true);
      void close().catch(() => setError('Preview access could not be closed. Reconnect before refreshing.'));
    };
    const leaving = () => {
      currentDocument().blocked = true;
      if (iframe.current) { iframe.current.hidden = true; iframe.current.src = 'about:blank'; }
      void fetch('/_agent-native/actions/vivary-remote-preview', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation: 'close', documentId: currentDocument().id }), keepalive: true }).catch(() => undefined);
    };
    window.addEventListener('pageshow', restored); window.addEventListener('pagehide', leaving);
    return () => {
      alive.current = false; sequence.current++;
      window.removeEventListener('pageshow', restored); window.removeEventListener('pagehide', leaving);
      const pending = close(); currentDocument().close = () => pending;
      void pending.catch(() => undefined);
    };
  }, []);
  useEffect(() => {
    sequence.current++;
    setFrame(null); setError('');
    const state = currentDocument();
    const identity = launch ? `${projectId}:${launch.launchId}` : null;
    setReload(state.blocked || !!state.identity && state.identity !== identity);
    if (state.identity) void close().catch(() => setError('Preview access could not be closed. Reconnect before refreshing.'));
  }, [projectId, launch?.launchId, launch?.code, launch?.staleBinding]);
  useEffect(() => {
    if (!frame) return;
    let delivered = false;
    const receive = (event: MessageEvent) => {
      if (delivered || event.source !== iframe.current?.contentWindow || event.origin !== frame.origin
        || event.data?.type !== 'vivary-preview-ready' || event.data?.nonce !== frame.nonce) return;
      delivered = true;
      iframe.current?.contentWindow?.postMessage({ type: 'vivary-preview-ticket', nonce: frame.nonce, ticket: frame.ticket }, frame.origin);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [frame]);
  async function open() {
    if (!projectId || !launch) return;
    setBusy(true); setError('');
    const state = currentDocument(), identity = `${projectId}:${launch.launchId}`;
    const version = ++sequence.current;
    try {
      if (!('credentialless' in document.createElement('iframe'))) throw new Error('This browser does not support isolated credentialless previews. Use the desktop preview.');
      if (state.blocked || state.identity && state.identity !== identity) { setReload(true); return; }
      await state.close?.(); await close();
      state.identity = identity;
      const result = handoff.parse(await call('vivary-remote-preview', { operation: 'open', documentId: state.id, projectId, launchId: launch.launchId }));
      if (!alive.current || sequence.current !== version) { await close(); return; }
      setFrame({ ...result, nonce: crypto.randomUUID() });
      onOpen();
      state.close = close;
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not open isolated preview.'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function refreshDocument() {
    if (!saved) return;
    setBusy(true); setError('');
    try {
      if (!await refreshPreviewDocument(close, () => { currentDocument().blocked = true; window.location.reload(); })) {
        setError('Your draft or selection could not be saved. Keep this page open and resolve the save error before refreshing.'); setBusy(false);
      }
    }
    catch { setError('Preview access could not be closed. Keep this page open and retry after reconnecting.'); setBusy(false); }
  }
  return <section className="remote-project-preview flex min-h-0 min-w-0 flex-1 flex-col" data-open={!!frame} aria-label="Remote project preview">
    <div className="preview-remote-controls max-h-[50%] shrink-0 space-y-3 overflow-y-auto border-b p-3 text-sm">
      {!launch && <p>Review and start a preview command above.</p>}
      {!frame && launch && <p>{launch.code === 'ready' ? 'Owned preview command is available. Opening verifies its connection.' : 'The owned preview is not ready.'}</p>}
      {reload ? <div role="status" className="space-y-3">
        <p>Opening a different preview needs a Vivary refresh. Save or copy unsaved file edits first. Vivary saves chat drafts and project selection before refreshing, and stays here if saving fails.</p>
        <label className="flex gap-2"><input type="checkbox" checked={saved} onChange={event => setSaved(event.target.checked)} />I have saved or copied my unsaved work.</label>
        <Button disabled={!saved || busy} onClick={() => void refreshDocument()}>Refresh Vivary for this preview</Button>
      </div> : <div className="flex flex-wrap gap-2">
        <Button aria-label={frame ? "Refresh preview" : "Open isolated preview"} disabled={!ready || busy || !launch || launch.code !== 'ready' || launch.staleBinding} onClick={() => void open()}>{frame ? 'Refresh' : 'Open isolated preview'}</Button>
        <Button aria-label="Close preview" variant="outline" disabled={!frame || busy} onClick={() => void close().catch(() => setError('Could not close preview access.'))}>Close</Button>
      </div>}
      {error && <p role="alert">{error}</p>}
      {!frame && <p className="text-xs text-muted-foreground">Embedded preview access lasts five minutes. Reopen explicitly when it ends. External login, workers and live-reload upgrades are not supported.</p>}
    </div>
    {frame && <iframe key={frame.nonce} title="Isolated project preview" className="min-h-0 w-full flex-1 border-0 bg-white"
      sandbox="allow-scripts allow-forms allow-same-origin" referrerPolicy="no-referrer"
      ref={element => { iframe.current = element; if (element && !element.src) { element.setAttribute('credentialless', ''); element.src = frame.origin + '/_vivary/preview/bootstrap'; } }}
      onLoad={() => iframe.current?.contentWindow?.postMessage({ type: 'vivary-preview-hello', nonce: frame.nonce }, frame.origin)} />}
  </section>;
}
