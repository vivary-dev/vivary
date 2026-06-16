import { useEffect, useState } from 'react'
import { getState, type StateSurface } from '../api/client'
import { C } from '../theme'

const card: React.CSSProperties = {
  background: C.panel,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  padding: 14,
  marginBottom: 14,
}

export function StatePanel({ wsid }: { wsid: string }) {
  const [s, setS] = useState<StateSurface | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getState(wsid).then(setS).catch((e) => setError(String(e)))
  }, [wsid])

  if (error) return <div style={{ color: C.err, padding: 16 }}>{error}</div>
  if (!s) return <div style={{ color: C.muted, padding: 16 }}>loading…</div>

  const review = s.review || {}
  return (
    <div style={{ overflow: 'auto', height: '100%' }}>
      <div style={card}>
        <h3 style={{ margin: '0 0 10px' }}>STATE</h3>
        {s.state ? (
          Object.entries(s.state.sections).map(([k, v]) => (
            <div key={k} style={{ marginBottom: 10 }}>
              <div style={{ color: C.accent, fontSize: 13, marginBottom: 2 }}>{k}</div>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0, color: C.muted }}>{v}</pre>
            </div>
          ))
        ) : (
          <span style={{ color: C.muted }}>no STATE.md</span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div style={card}>
          <h3 style={{ margin: '0 0 10px' }}>Board <span style={{ color: C.muted, fontSize: 12 }}>(exo)</span></h3>
          {s.board?.error && <div style={{ color: C.warn, fontSize: 12 }}>{s.board.error}</div>}
          {s.board?.items?.map((it) => (
            <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
              <span>{it.id}</span>
              <span style={{ color: it.status === 'done' ? C.accent : C.muted }}>{it.status}</span>
            </div>
          ))}
        </div>
        <div style={card}>
          <h3 style={{ margin: '0 0 10px' }}>Review <span style={{ color: C.muted, fontSize: 12 }}>(ozone)</span></h3>
          {review.error ? (
            <div style={{ color: C.warn, fontSize: 12 }}>{review.error}</div>
          ) : (
            <div style={{ fontSize: 13, color: C.muted }}>
              reviewed {review.reviewed ?? '–'} · warnings{' '}
              <span style={{ color: review.warnings ? C.warn : C.accent }}>{review.warnings ?? '–'}</span>
            </div>
          )}
        </div>
      </div>

      {s.soul && (
        <div style={card}>
          <h3 style={{ margin: '0 0 10px' }}>SOUL</h3>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0, color: C.muted }}>{s.soul}</pre>
        </div>
      )}
    </div>
  )
}
