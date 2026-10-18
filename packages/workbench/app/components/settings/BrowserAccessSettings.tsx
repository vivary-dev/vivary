import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@agent-native/toolkit/ui';
import { browserStatus, type BrowserStatus } from '../../../shared/browser-access';

export function BrowserAccessSettings() {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const initialValuesLoaded = useRef(false);
  const [origin, setOrigin] = useState('');
  const [port, setPort] = useState('42300');
  const [previewOrigin, setPreviewOrigin] = useState('');
  const [previewPort, setPreviewPort] = useState('42301');
  const [label, setLabel] = useState('My Vivary laptop');
  async function refresh() {
    const response = await fetch('/_vivary/browser/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('Open the desktop app to configure remote access.');
    const next = browserStatus.parse(await response.json());
    setStatus(next);
    if (!initialValuesLoaded.current) {
      setPreviewOrigin(next.preview?.origin ?? ''); setPreviewPort(String(next.preview?.port ?? 42301));
      setOrigin(next.origin ?? ''); setPort(String(next.port || 42300)); setLabel(next.label);
      initialValuesLoaded.current = true; setInitialized(true);
    }
    return next;
  }
  useEffect(() => {
    let mounted = true;
    void refresh().catch(cause => setError(cause.message));
    const timer = setInterval(() => { if (mounted) void refresh().catch(() => setError('Could not refresh remote access. Retry.')); }, 5000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);
  async function change(command: Record<string, unknown>) {
    setBusy(true); setError('');
    try {
      const response = await fetch('/_vivary/browser/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) });
      if (!response.ok) { const result = await response.json(); throw new Error(typeof result.error === 'string' ? result.error : 'Remote access change failed.'); }
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Remote access change failed.'); }
    finally { setBusy(false); }
  }
  return <section className="mx-auto max-w-2xl space-y-6" aria-label="Remote access">
    <div><h2 className="text-lg font-semibold">Remote access</h2>
      <p className="mt-2 text-sm text-muted-foreground">Open Vivary on another device. Remote access uses a protected HTTPS connection that you set up before you turn it on, for example an appropriately configured Tailscale connection. Tailscale is only an example. Vivary does not include it or require it.</p>
      <p className="mt-2 text-sm text-muted-foreground">Vivary does not create the tunnel or change your firewall. Projects, files and tools stay on this host. Remote access is separate from an agent controlling a browser.</p></div>
    {error && <p role="alert" className="text-sm text-destructive">{error} <Button variant="ghost" onClick={() => { void refresh().then(() => setError('')).catch(cause => setError(cause.message)); }}>Retry</Button></p>}
    {status?.listenerError && <p role="alert" className="text-sm text-destructive">{status.listenerError}</p>}
    {status?.remote ? <p>Connected to {status.label}. Approve devices and change access in that computer's desktop app.</p> : <>
      <p role="status">{!status ? 'Checking desktop access…' : status.fault ? 'Admission closed. A change could not be saved. Retry before restarting.' : status.listenerError ? 'Remote access listener unavailable' : status.enabled ? 'Remote access enabled' : 'Remote access off'}</p>
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); void change({ operation: 'configure', configuration: { origin, port: Number(port), label, preview: previewOrigin ? { origin: previewOrigin, port: Number(previewPort) } : null } }); }}>
        <label className="block text-sm">Host name<Input disabled={busy || !initialized} className="mt-2 min-h-11" value={label} onChange={event => setLabel(event.target.value)} maxLength={80} required /></label>
        <label className="block text-sm">Private HTTPS origin<Input disabled={busy || !initialized} className="mt-2 min-h-11" placeholder="https://your-private-host" value={origin} onChange={event => setOrigin(event.target.value)} required /></label>
        <label className="block text-sm">Loopback ingress port<Input disabled={busy || !initialized} className="mt-2 min-h-11" type="number" min={1024} max={65535} value={port} onChange={event => setPort(event.target.value)} required /></label>
        <label className="block text-sm">Optional preview HTTPS origin<Input disabled={busy || !initialized} className="mt-2 min-h-11" placeholder="Same hostname, separate HTTPS port" value={previewOrigin} onChange={event => setPreviewOrigin(event.target.value)} /></label>
        {previewOrigin && <label className="block text-sm">Preview loopback ingress port<Input disabled={busy || !initialized} className="mt-2 min-h-11" type="number" min={1024} max={65535} value={previewPort} onChange={event => setPreviewPort(event.target.value)} required /></label>}
        <p className="text-sm text-muted-foreground">Leave preview origin empty to keep remote previews off. Preview requires a separately protected HTTPS port. Configuring this field does not set up transport.</p>
        <p className="text-sm text-muted-foreground">Point your protected HTTPS connection at this loopback port. The desktop asks you to confirm.</p>
        <div className="flex flex-wrap gap-3"><Button className="min-h-11" type="submit" disabled={busy || !initialized}>Enable remote access</Button><Button className="min-h-11" type="button" variant="outline" disabled={busy || !status?.enabled} onClick={() => { void change({ operation: 'disable' }); }}>Disable access</Button></div>
      </form>
      {status?.enabled && <p className="break-all text-sm">On the other device, open {status.origin}/pair in a browser.</p>}
      <div><h3 className="font-medium">Waiting for approval</h3>{!status?.pending?.length && <p className="mt-2 text-sm text-muted-foreground">No pending browsers.</p>}
        {status?.pending?.map(request => <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border p-3" key={request.id}><div><p>{request.label}</p><p className="font-mono text-lg tracking-widest">{request.code}</p><p className="text-xs text-muted-foreground">Expires {new Date(request.expiresAt).toLocaleTimeString()}</p></div><Button className="min-h-11" disabled={busy || request.approved} onClick={() => { void change({ operation: 'approve', id: request.id }); }}>{request.approved ? 'Approved' : 'Compare and approve'}</Button></div>)}
      </div>
      <div><h3 className="font-medium">Paired browsers</h3>{!status?.devices?.length && <p className="mt-2 text-sm text-muted-foreground">No paired browsers.</p>}
        {status?.devices?.map(device => <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border p-3" key={device.id}><div><p>{device.label}</p><p className="text-xs text-muted-foreground">{device.status} · expires {new Date(device.expires_at).toLocaleDateString()}</p></div><Button className="min-h-11" variant="outline" disabled={busy || device.status !== 'active'} onClick={() => { void change({ operation: 'revoke', id: device.id }); }}>Revoke</Button></div>)}
      </div>
    </>}
  </section>;
}
