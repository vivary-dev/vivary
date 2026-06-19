import { useEffect, useRef, useState } from 'react'
import {
  cancelSession,
  createSession,
  decideSessionGate,
  getRuntimes,
  getSessionGates,
  openSessionWs,
  resumeSession,
  sendMessage,
  type Gate,
  type RuntimeInfo,
} from '../api/client'
import { C, FONT_MONO } from '../theme'
import { Markdown } from '../markdown'
import type { MesoSelectionContext } from '../meso/types'

// The persistent agent conversation: the app's centerpiece, present on every page.
// Talk drives the workspace; the views to the right are the stage it acts on.
interface Ev { type: string; text: string; tool: string; meta: { cost?: number; input_tokens?: number; output_tokens?: number } }
type Item =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: string; target: string; result?: string }
  | { kind: 'status'; text: string }
  | { kind: 'error'; text: string }
interface Obs { status: 'idle' | 'running'; cost: number; inTok: number; outTok: number; turn: number }
const ZERO: Obs = { status: 'idle', cost: 0, inTok: 0, outTok: 0, turn: 0 }

function apply(prev: Item[], ev: Ev): Item[] {
  switch (ev.type) {
    case 'user_msg': return [...prev, { kind: 'user', text: ev.text }]
    case 'text': return [...prev, { kind: 'text', text: ev.text }]
    case 'tool_use': return [...prev, { kind: 'tool', tool: ev.tool, target: ev.text }]
    case 'tool_result': {
      const rev = [...prev].reverse().findIndex((x) => x.kind === 'tool' && x.result === undefined)
      if (rev < 0) return prev
      const idx = prev.length - 1 - rev
      const copy = [...prev]
      copy[idx] = { ...(copy[idx] as Extract<Item, { kind: 'tool' }>), result: ev.text }
      return copy
    }
    case 'status': return ev.text && ev.text !== 'session created' ? [...prev, { kind: 'status', text: ev.text }] : prev
    case 'error': return [...prev, { kind: 'error', text: ev.text }]
    default: return prev
  }
}

export function ChatPanel({ wsid, mesoContext, onMesoContextUsed }: { wsid: string; mesoContext?: MesoSelectionContext | null; onMesoContextUsed?: () => void }) {
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([])
  const [runtime, setRuntime] = useState('claude')
  const [sid, setSid] = useState<string | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [obs, setObs] = useState<Obs>(ZERO)
  const [gates, setGates] = useState<Gate[]>([])
  const [awaiting, setAwaiting] = useState(false)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)

  useEffect(() => { getRuntimes().then(setRuntimes).catch((e) => setError(String(e))) }, [])
  const loadGates = (s: string) => getSessionGates(s).then((g) => setGates(g.filter((x) => x.status === 'open'))).catch(() => {})

  useEffect(() => {
    let dead = false
    Promise.resolve().then(() => {
      if (!dead) {
        setItems([])
        setObs(ZERO)
        setSid(null)
        setGates([])
        setAwaiting(false)
      }
    })
    wsRef.current?.close()
    createSession(wsid, runtime).then(({ id }) => {
      if (dead) return
      setSid(id)
      const ws = openSessionWs(id)
      wsRef.current = ws
      ws.onmessage = (m) => {
        const ev = JSON.parse(m.data) as Ev
        setItems((p) => apply(p, ev))
        if (ev.type === 'user_msg') setObs((o) => ({ ...o, status: 'running' }))
        else if (ev.type === 'result') setObs((o) => ({ ...o, cost: o.cost + (ev.meta?.cost ?? 0), inTok: o.inTok + (ev.meta?.input_tokens ?? 0), outTok: o.outTok + (ev.meta?.output_tokens ?? 0), turn: o.turn + 1 }))
        else if (ev.type === 'turn_end') setObs((o) => ({ ...o, status: 'idle' }))
        else if (ev.type === 'gates_open') { loadGates(id); setAwaiting(true) }
      }
      ws.onerror = () => setError('websocket error')
    }).catch((e) => setError(String(e)))
    return () => { dead = true; wsRef.current?.close() }
  }, [wsid, runtime])

  useEffect(() => { if (stick.current) logRef.current?.scrollTo({ top: logRef.current.scrollHeight }) }, [items])

  const onLogScroll = () => {
    const el = logRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const send = async () => {
    if (!input.trim() || !sid || obs.status === 'running') return
    const text = input.trim(); setInput(''); setAwaiting(false)
    try { await sendMessage(sid, text) } catch (e) { setError(String(e)) }
  }
  const useMesoContext = () => {
    if (!mesoContext) return
    setInput(formatMesoPrompt(mesoContext))
    onMesoContextUsed?.()
  }
  const decide = async (gid: string, d: 'approve' | 'reject') => {
    if (!sid) return
    try {
      await decideSessionGate(sid, gid, d)
      const remaining = (await getSessionGates(sid)).filter((x) => x.status === 'open')
      setGates(remaining)
      if (awaiting && remaining.length === 0) { setAwaiting(false); await resumeSession(sid) }
    } catch (e) { setError(String(e)) }
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, height: '100%', background: `radial-gradient(70% 40% at 50% 0%, oklch(0.24 0.03 195 / .45), transparent 70%)` }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 22px', borderBottom: `1px solid ${C.border}` }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: obs.status === 'running' ? C.warn : C.accent }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'currentColor', boxShadow: '0 0 9px currentColor' }} />
          {obs.status === 'running' ? 'working' : 'ready'}
        </span>
        <span style={{ fontSize: 12.5, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>
          {obs.turn > 0 && <>{obs.inTok.toLocaleString()} in · {obs.outTok.toLocaleString()} out · ${obs.cost.toFixed(3)}</>}
        </span>
        <select value={runtime} onChange={(e) => setRuntime(e.target.value)} style={{ marginLeft: 'auto', padding: '5px 9px', background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12.5 }}>
          {runtimes.map((r) => <option key={r.name} value={r.name} disabled={!r.available}>{r.label}{r.available ? '' : ' (n/a)'}</option>)}
        </select>
      </header>

      <div ref={logRef} onScroll={onLogScroll} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '24px 22px' }}>
        <div style={{ maxWidth: '60ch', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 15 }}>
          {awaiting && gates.length > 0 && <div style={{ fontSize: 12.5, color: C.warn }}>The agent paused for approval — approving resumes it; rejecting tells it to stop.</div>}
          {gates.map((g) => (
            <div key={g.id} style={{ border: `1px solid ${C.warn}`, background: `linear-gradient(180deg, oklch(0.28 0.035 78 / .4), ${C.panel})`, borderRadius: 11, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 13px', fontFamily: FONT_MONO, fontSize: 12.5, color: C.warn }}>⚠ Gate <span style={{ color: C.text }}>{g.id}</span></div>
              <div style={{ padding: '0 13px 10px', fontSize: 12.5, color: C.muted }}>{g.gate}</div>
              <div style={{ display: 'flex', gap: 8, padding: '10px 13px', borderTop: `1px solid ${C.border}` }}>
                <button onClick={() => decide(g.id, 'approve')} style={btn(C.warn)}>Approve</button>
                <button onClick={() => decide(g.id, 'reject')} style={ghost()}>Reject</button>
              </div>
            </div>
          ))}
          {items.length === 0 && gates.length === 0 && <span style={{ color: C.muted, fontSize: 14.5 }}>Ask Vivary to develop this workspace. It can read, search, edit, and act, in the open, while you watch it work on the right.</span>}
          {items.map((it, i) => <Block key={i} it={it} />)}
        </div>
      </div>

      {error && <div style={{ color: C.err, fontSize: 13, padding: '0 22px 8px' }}>{error}</div>}
      <div style={{ borderTop: `1px solid ${C.border}`, padding: '14px 22px 18px' }}>
        <div style={{ maxWidth: '60ch', margin: '0 auto', display: 'flex', gap: 9, alignItems: 'center' }}>
          {mesoContext && (
            <button
              type="button"
              onClick={useMesoContext}
              style={{ border: `1px solid ${C.warn}`, color: C.warn, background: C.panel, borderRadius: 10, padding: '9px 11px', cursor: 'pointer', fontSize: 12.5, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={mesoContext.summary}
            >
              Meso context ready
            </button>
          )}
          <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder={obs.status === 'running' ? 'agent is working…' : 'Reply, or ask Vivary to act on the workspace…'}
            disabled={obs.status === 'running' || !sid}
            style={{ flex: 1, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: '12px 15px', color: C.text, fontSize: 14.5 }} />
          {obs.status === 'running'
            ? <button onClick={() => sid && cancelSession(sid)} style={ghost(C.err)}>Stop</button>
            : <button onClick={send} disabled={!sid} style={{ ...btn(C.accent), padding: '11px 20px', boxShadow: '0 0 18px oklch(0.8 0.13 165 / .35)' }}>Send</button>}
        </div>
      </div>
    </section>
  )
}

function Block({ it }: { it: Item }) {
  if (it.kind === 'user') {
    return <div style={{ alignSelf: 'flex-end', maxWidth: '85%', background: C.raise, border: `1px solid ${C.border}`, borderRadius: '14px 14px 4px 14px', padding: '10px 14px', fontSize: 14.5, lineHeight: 1.5 }}>{it.text}</div>
  }
  if (it.kind === 'text') {
    return <Markdown text={it.text} />
  }
  if (it.kind === 'tool') {
    return (
      <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden', background: C.panel }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 12px', fontFamily: FONT_MONO, fontSize: 12.5, color: C.muted }}>
          <span style={{ color: C.accent }}>⚙</span><span style={{ color: C.read }}>{it.tool}</span><span>{it.target.replace(`${it.tool}: `, '').replace(it.tool, '')}</span>
        </div>
        {it.result && <div style={{ borderTop: `1px solid ${C.border}`, padding: '8px 12px', fontFamily: FONT_MONO, fontSize: 11.5, color: C.muted, lineHeight: 1.5 }}>{it.result}</div>}
      </div>
    )
  }
  if (it.kind === 'error') {
    return <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.err }}>{it.text}</div>
  }
  return <div style={{ alignSelf: 'center', fontSize: 11, color: C.muted }}>{it.text}</div>
}

function btn(bg: string): React.CSSProperties {
  return { background: bg, color: 'oklch(0.2 0.02 250)', border: 'none', borderRadius: 9, padding: '8px 14px', font: 'inherit', fontWeight: 650, fontSize: 13, cursor: 'pointer' }
}
function ghost(color: string = C.muted): React.CSSProperties {
  return { background: 'none', border: `1px solid ${C.border}`, color, borderRadius: 9, padding: '8px 14px', font: 'inherit', fontSize: 13, cursor: 'pointer' }
}

function formatMesoPrompt(context: MesoSelectionContext): string {
  const parts = [
    'Use this Meso Canvas selection as explicit context.',
    context.summary,
    context.paths.length ? `Paths: ${context.paths.join(', ')}` : '',
    context.graphIds.length ? `Graph IDs: ${context.graphIds.join(', ')}` : '',
    context.sessionIds.length ? `Session IDs: ${context.sessionIds.join(', ')}` : '',
    '',
    'Task: ',
  ].filter((part) => part !== '')
  return parts.join('\n')
}
