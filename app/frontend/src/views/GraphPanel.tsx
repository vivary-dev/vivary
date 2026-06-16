import { useEffect, useState } from 'react'
import { getBlast, getGraphView, type Impacted } from '../api/client'
import { C } from '../theme'

export function GraphPanel({ wsid }: { wsid: string }) {
  const [html, setHtml] = useState<string>('')
  const [node, setNode] = useState('')
  const [impacted, setImpacted] = useState<Impacted[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setHtml('')
    setImpacted(null)
    getGraphView(wsid).then(setHtml).catch((e) => setError(String(e)))
  }, [wsid])

  const onBlast = async () => {
    if (!node.trim()) return
    setError(null)
    try {
      const res = await getBlast(wsid, node.trim())
      setImpacted(res.impacted)
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 260px', gap: 14, height: '100%' }}>
      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
        {error && <div style={{ color: C.err, padding: 10 }}>{error}</div>}
        {html ? (
          <iframe title="tropo graph" srcDoc={html} style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }} />
        ) : (
          <div style={{ color: C.muted, padding: 14 }}>rendering graph…</div>
        )}
      </div>
      <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, overflow: 'auto' }}>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>BLAST RADIUS</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={node}
            onChange={(e) => setNode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onBlast()}
            placeholder="node id…"
            style={{ flex: 1, padding: '.4rem', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6 }}
          />
          <button onClick={onBlast} style={{ padding: '.4rem .6rem', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 6, cursor: 'pointer' }}>→</button>
        </div>
        {impacted && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            {impacted.length === 0 && <div style={{ color: C.muted }}>nothing impacted</div>}
            {impacted.map((i) => (
              <div key={i.id} style={{ padding: '4px 0', borderBottom: `1px solid ${C.border}` }}>
                <div>{i.id}</div>
                <div style={{ fontSize: 11, color: C.muted }}>{i.type} · d{i.distance} · via {i.via}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
