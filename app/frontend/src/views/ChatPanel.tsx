import { useEffect, useMemo, useRef, useState } from 'react'
import {
  cancelSession,
  createSession,
  decideApproval,
  decideSessionGate,
  getRuntimes,
  getSessionGates,
  openSessionWs,
  resumeSession,
  sendMessage,
  type Gate,
  type RuntimeInfo,
} from '../api/client'
import { applyEvent, visibleItems } from '../chat/reducer'
import type { AgentEvent, ChatItem, Density, Obs } from '../chat/types'
import { ZERO_OBS } from '../chat/types'
import { DensityControl } from '../chat/controls'
import {
  ApprovalCard,
  FileChangeReceipt,
  PlanRail,
  ReasoningBox,
  ToolGroup,
  ToolPill,
} from '../chat/receipts'
import { C, FONT_MONO } from '../theme'
import { Markdown } from '../markdown'

export function ChatPanel({ wsid }: { wsid: string }) {
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([])
  const [runtime, setRuntime] = useState('claude')
  const [density, setDensity] = useState<Density>('balanced')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getRuntimes().then(setRuntimes).catch((e) => setError(String(e)))
  }, [])

  return (
    <ChatSession
      key={`${wsid}:${runtime}`}
      wsid={wsid}
      runtime={runtime}
      runtimes={runtimes}
      density={density}
      onDensity={setDensity}
      onRuntime={setRuntime}
      setupError={error}
    />
  )
}

function ChatSession({
  wsid,
  runtime,
  runtimes,
  density,
  onDensity,
  onRuntime,
  setupError,
}: {
  wsid: string
  runtime: string
  runtimes: RuntimeInfo[]
  density: Density
  onDensity: (next: Density) => void
  onRuntime: (next: string) => void
  setupError: string | null
}) {
  const [sid, setSid] = useState<string | null>(null)
  const [items, setItems] = useState<ChatItem[]>([])
  const [obs, setObs] = useState<Obs>(ZERO_OBS)
  const [gates, setGates] = useState<Gate[]>([])
  const [awaiting, setAwaiting] = useState(false)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(setupError)
  const wsRef = useRef<WebSocket | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)

  const loadGates = (s: string) =>
    getSessionGates(s).then((g) => setGates(g.filter((x) => x.status === 'open'))).catch(() => {})

  useEffect(() => {
    let dead = false
    createSession(wsid, runtime).then(({ id }) => {
      if (dead) return
      setSid(id)
      const ws = openSessionWs(id)
      wsRef.current = ws
      ws.onmessage = (m) => {
        const ev = JSON.parse(m.data) as AgentEvent
        setItems((p) => applyEvent(p, ev))
        setObs((o) => observe(o, ev))
        if (ev.type === 'gates_open') {
          loadGates(id)
          setAwaiting(true)
        }
      }
      ws.onerror = () => setError('websocket error')
    }).catch((e) => setError(String(e)))
    return () => {
      dead = true
      wsRef.current?.close()
    }
  }, [wsid, runtime])

  useEffect(() => {
    if (stick.current) logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [items])

  const shown = useMemo(() => visibleItems(items, density), [items, density])

  const onLogScroll = () => {
    const el = logRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const send = async () => {
    if (!input.trim() || !sid || obs.status === 'running') return
    const text = input.trim()
    setInput('')
    setAwaiting(false)
    try { await sendMessage(sid, text) } catch (e) { setError(String(e)) }
  }

  const decide = async (gid: string, d: 'approve' | 'reject') => {
    if (!sid) return
    try {
      await decideSessionGate(sid, gid, d)
      const remaining = (await getSessionGates(sid)).filter((x) => x.status === 'open')
      setGates(remaining)
      if (awaiting && remaining.length === 0) {
        setAwaiting(false)
        await resumeSession(sid)
      }
    } catch (e) {
      setError(String(e))
    }
  }

  const decideApprovalRequest = async (
    approvalId: string,
    decision: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always',
    body: { scope?: string; pattern?: string; steering?: string },
  ) => {
    if (!sid) return
    try {
      await decideApproval(sid, approvalId, decision, body)
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <section style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, height: '100%', background: `radial-gradient(70% 40% at 50% 0%, oklch(0.24 0.03 195 / .45), transparent 70%)` }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 22px', borderBottom: `1px solid ${C.border}` }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, fontWeight: 600, color: obs.status === 'running' ? C.warn : C.accent }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'currentColor', boxShadow: '0 0 9px currentColor' }} />
          {obs.status === 'running' ? 'working' : awaiting ? 'awaiting' : 'ready'}
        </span>
        <span style={{ fontSize: 12.5, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>
          {obs.turn > 0 && <>{obs.inTok.toLocaleString()} in · {obs.outTok.toLocaleString()} out · {obs.reasoningTok.toLocaleString()} reasoning</>}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <DensityControl density={density} onChange={onDensity} />
          <select value={runtime} onChange={(e) => onRuntime(e.target.value)} style={{ padding: '5px 9px', background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12.5 }}>
            {runtimes.map((r) => <option key={r.name} value={r.name} disabled={!r.available}>{r.label}{r.available ? '' : ' (n/a)'}</option>)}
          </select>
        </div>
      </header>

      <div ref={logRef} onScroll={onLogScroll} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '24px 22px' }}>
        <div style={{ maxWidth: '68ch', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 13 }}>
          {awaiting && gates.length > 0 && <div style={{ fontSize: 12.5, color: C.warn }}>The agent paused for approval. Approving resumes it; rejecting tells it to stop.</div>}
          {gates.map((g) => <GateCard key={g.id} gate={g} onDecide={decide} />)}
          {shown.length === 0 && gates.length === 0 && <span style={{ color: C.muted, fontSize: 14.5 }}>Ask Vivary to develop this workspace. It can read, search, edit, and act while you watch structured receipts instead of raw output.</span>}
          {shown.map((it) => <Block key={it.id} item={it} density={density} onApprovalDecide={decideApprovalRequest} />)}
        </div>
      </div>

      {error && <div style={{ color: C.err, fontSize: 13, padding: '0 22px 8px' }}>{error}</div>}
      <div style={{ borderTop: `1px solid ${C.border}`, padding: '14px 22px 18px' }}>
        <div style={{ maxWidth: '68ch', margin: '0 auto', display: 'flex', gap: 9, alignItems: 'center' }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder={obs.status === 'running' ? 'agent is working...' : 'Reply, or ask Vivary to act on the workspace...'}
            disabled={obs.status === 'running' || !sid}
            style={{ flex: 1, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: '12px 15px', color: C.text, fontSize: 14.5 }}
          />
          {obs.status === 'running'
            ? <button onClick={() => sid && cancelSession(sid)} style={ghost(C.err)}>Stop</button>
            : <button onClick={send} disabled={!sid} style={{ ...btn(C.accent), padding: '11px 20px', boxShadow: '0 0 18px oklch(0.8 0.13 165 / .35)' }}>Send</button>}
        </div>
      </div>
    </section>
  )
}

function observe(prev: Obs, ev: AgentEvent): Obs {
  if (ev.type === 'user_msg') return { ...prev, status: 'running' }
  if (ev.type === 'turn_end') return { ...prev, status: 'idle' }
  if (ev.type !== 'result') return prev
  return {
    ...prev,
    cost: prev.cost + numeric(ev.meta.cost),
    inTok: prev.inTok + numeric(ev.meta.input_tokens),
    cachedInTok: prev.cachedInTok + numeric(ev.meta.cached_input_tokens),
    outTok: prev.outTok + numeric(ev.meta.output_tokens),
    reasoningTok: prev.reasoningTok + numeric(ev.meta.reasoning_output_tokens),
    turn: prev.turn + 1,
  }
}

function numeric(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

function Block({
  item,
  density,
  onApprovalDecide,
}: {
  item: ChatItem
  density: Density
  onApprovalDecide: (approvalId: string, decision: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always', body: { scope?: string; pattern?: string; steering?: string }) => void
}) {
  if (item.kind === 'user') {
    return <div style={{ alignSelf: 'flex-end', maxWidth: '85%', background: C.raise, border: `1px solid ${C.border}`, borderRadius: '14px 14px 4px 14px', padding: '10px 14px', fontSize: 14.5, lineHeight: 1.5 }}>{item.text}</div>
  }
  if (item.kind === 'answer') return <Markdown text={item.text} />
  if (item.kind === 'reasoning') return <ReasoningBox item={item} density={density} />
  if (item.kind === 'tool') return <ToolPill item={item} density={density} />
  if (item.kind === 'toolGroup') return <ToolGroup item={item} />
  if (item.kind === 'fileChange') return <FileChangeReceipt item={item} />
  if (item.kind === 'plan') return <PlanRail item={item} />
  if (item.kind === 'approval') return <ApprovalCard item={item} onDecide={onApprovalDecide} />
  if (item.kind === 'error') return <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.err }}>{item.text}</div>
  return <div style={{ alignSelf: 'center', fontSize: 11, color: C.muted }}>{item.text}</div>
}

function GateCard({ gate, onDecide }: { gate: Gate; onDecide: (gid: string, d: 'approve' | 'reject') => void }) {
  return (
    <div style={{ border: `1px solid ${C.warn}`, background: `linear-gradient(180deg, oklch(0.28 0.035 78 / .4), ${C.panel})`, borderRadius: 11, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 13px', fontFamily: FONT_MONO, fontSize: 12.5, color: C.warn }}>Gate <span style={{ color: C.text }}>{gate.id}</span></div>
      <div style={{ padding: '0 13px 10px', fontSize: 12.5, color: C.muted }}>{gate.gate}</div>
      <div style={{ display: 'flex', gap: 8, padding: '10px 13px', borderTop: `1px solid ${C.border}` }}>
        <button onClick={() => onDecide(gate.id, 'approve')} style={btn(C.warn)}>Approve</button>
        <button onClick={() => onDecide(gate.id, 'reject')} style={ghost()}>Reject</button>
      </div>
    </div>
  )
}

function btn(bg: string): React.CSSProperties {
  return { background: bg, color: 'oklch(0.2 0.02 250)', border: 'none', borderRadius: 9, padding: '8px 14px', fontWeight: 650, fontSize: 13, cursor: 'pointer' }
}

function ghost(color: string = C.muted): React.CSSProperties {
  return { background: 'none', border: `1px solid ${C.border}`, color, borderRadius: 9, padding: '8px 14px', fontSize: 13, cursor: 'pointer' }
}
