import { useEffect, useRef, useState } from 'react'
import {
  cancelSession,
  listSessions,
  openSessionWs,
  type SessionSummary,
  type Workspace,
} from '../api/client'
import { C } from '../theme'

const STATUS_COLOR: Record<string, string> = {
  running: C.warn,
  done: C.accent,
  error: C.err,
  cancelled: C.muted,
}

function Transcript({ id }: { id: string }) {
  const [lines, setLines] = useState<{ type: string; text: string }[]>([])
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const ws = openSessionWs(id)
    ws.onmessage = (m) => {
      const ev = JSON.parse(m.data)
      if (ev.type === '_end') return ws.close()
      setLines((p) => [...p, ev])
    }
    return () => ws.close()
  }, [id])
  useEffect(() => ref.current?.scrollTo({ top: ref.current.scrollHeight }), [lines])
  return (
    <div ref={ref} style={{ maxHeight: 240, overflow: 'auto', marginTop: 8, fontSize: 12, fontFamily: 'ui-monospace, monospace', color: C.muted }}>
      {lines.map((l, i) => (
        <div key={i} style={{ color: l.type === 'message' ? C.text : l.type === 'error' ? C.err : C.muted }}>
          {l.type !== 'message' && `[${l.type}] `}{l.text}
        </div>
      ))}
    </div>
  )
}

export function DashboardPanel({ workspaces }: { workspaces: Workspace[] }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const name = (id: string) => workspaces.find((w) => w.id === id)?.name ?? id

  useEffect(() => {
    const tick = () => listSessions().then(setSessions).catch(() => {})
    tick()
    const t = setInterval(tick, 1500)
    return () => clearInterval(t)
  }, [])

  return (
    <div style={{ overflow: 'auto', height: '100%', padding: 16 }}>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>
        AGENT SESSIONS · {sessions.filter((s) => s.status === 'running').length} running / {sessions.length} total
      </div>
      {sessions.length === 0 && <div style={{ color: C.muted }}>no sessions yet — start one from the Agent tab</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
        {sessions.map((s) => (
          <div key={s.id} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: 13 }}>{s.runtime}</strong>
              <span style={{ fontSize: 11, color: STATUS_COLOR[s.status] ?? C.muted, textTransform: 'uppercase' }}>{s.status}</span>
            </div>
            <div style={{ fontSize: 11, color: C.muted, margin: '3px 0' }}>{name(s.workspace)} · {s.id}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button onClick={() => setOpen(open === s.id ? null : s.id)} style={{ padding: '.3rem .7rem', background: 'transparent', border: `1px solid ${C.border}`, color: C.muted, borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>
                {open === s.id ? 'hide' : 'view'}
              </button>
              {s.status === 'running' && (
                <button onClick={() => cancelSession(s.id)} style={{ padding: '.3rem .7rem', background: 'transparent', border: `1px solid ${C.err}`, color: C.err, borderRadius: 6, cursor: 'pointer', fontSize: 12 }}>cancel</button>
              )}
            </div>
            {open === s.id && <Transcript id={s.id} />}
          </div>
        ))}
      </div>
    </div>
  )
}
