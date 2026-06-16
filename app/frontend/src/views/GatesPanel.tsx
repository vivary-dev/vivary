import { useEffect, useState } from 'react'
import { decideGate, getConflicts, getGates, type Conflicts, type Gate } from '../api/client'
import { C } from '../theme'

const STATUS_COLOR: Record<string, string> = {
  open: C.warn,
  approved: C.accent,
  rejected: C.err,
  deferred: C.muted,
}

export function GatesPanel({ wsid }: { wsid: string }) {
  const [gates, setGates] = useState<Gate[]>([])
  const [conflicts, setConflicts] = useState<Conflicts | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () => {
    getGates(wsid).then(setGates).catch((e) => setError(String(e)))
    getConflicts(wsid).then(setConflicts).catch(() => setConflicts(null))
  }

  useEffect(load, [wsid])

  const decide = async (gid: string, d: 'approve' | 'reject') => {
    setError(null)
    try {
      const updated = await decideGate(wsid, gid, d)
      setGates((gs) => gs.map((g) => (g.id === updated.id ? updated : g)))
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div style={{ overflow: 'auto', height: '100%', padding: 16 }}>
      {error && <div style={{ color: C.err, marginBottom: 10 }}>{error}</div>}

      <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>HUMAN GATES</div>
      {gates.length === 0 && <div style={{ color: C.muted }}>no gates in this workspace</div>}
      {gates.map((g) => (
        <div key={g.id} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14, marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>{g.id}</strong>
            <span style={{ fontSize: 11, color: STATUS_COLOR[g.status] ?? C.muted, border: `1px solid ${STATUS_COLOR[g.status] ?? C.muted}`, borderRadius: 4, padding: '1px 7px', textTransform: 'uppercase' }}>{g.status}</span>
          </div>
          <div style={{ fontSize: 13, color: C.muted, margin: '6px 0' }}>{g.gate}</div>
          {g.approved_at && <div style={{ fontSize: 11, color: C.muted }}>by {g.approver} · {g.approved_at}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={() => decide(g.id, 'approve')} disabled={g.status === 'approved'} style={{ padding: '.35rem .8rem', background: 'transparent', border: `1px solid ${C.accent}`, color: C.accent, borderRadius: 6, cursor: 'pointer' }}>Approve</button>
            <button onClick={() => decide(g.id, 'reject')} disabled={g.status === 'rejected'} style={{ padding: '.35rem .8rem', background: 'transparent', border: `1px solid ${C.err}`, color: C.err, borderRadius: 6, cursor: 'pointer' }}>Reject</button>
          </div>
        </div>
      ))}

      <div style={{ fontSize: 12, color: C.muted, margin: '18px 0 8px' }}>COORDINATION (exo)</div>
      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 14, fontSize: 13 }}>
        <div>active items: <span style={{ color: C.text }}>{conflicts?.active?.length ?? 0}</span></div>
        {conflicts?.conflicts?.length ? (
          conflicts.conflicts.map((c, i) => (
            <div key={i} style={{ color: C.warn, marginTop: 4 }}>⚠ {c.a} ↔ {c.b} (shared: {c.shared.join(', ')})</div>
          ))
        ) : (
          <div style={{ color: C.accent, marginTop: 4 }}>no conflicts</div>
        )}
      </div>
    </div>
  )
}
