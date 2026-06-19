import { useEffect, useState } from 'react'
import { readFile } from '../api/client'
import { C, FONT_MONO } from '../theme'
import type { MesoNode } from './types'

export function FocusSurface({ wsid, node, onClose }: { wsid: string; node: MesoNode | null; onClose: () => void }) {
  const [preview, setPreview] = useState<{ nodeId: string; file: { path: string; content: string; private?: boolean } | null; error: string | null } | null>(null)

  useEffect(() => {
    if (!node?.path || (node.kind !== 'file' && node.kind !== 'doc' && node.kind !== 'gate')) return
    let dead = false
    readFile(wsid, node.path)
      .then((file) => { if (!dead) setPreview({ nodeId: node.id, file, error: null }) })
      .catch((err) => { if (!dead) setPreview({ nodeId: node.id, file: null, error: String(err) }) })
    return () => { dead = true }
  }, [node, wsid])

  if (!node) {
    return (
      <aside style={shell}>
        <div style={{ color: C.muted, fontSize: 13 }}>Double-click a node to focus it.</div>
      </aside>
    )
  }

  return (
    <aside style={shell}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: C.text, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.title}</div>
          <div style={{ color: C.muted, fontFamily: FONT_MONO, fontSize: 11, textTransform: 'uppercase' }}>{node.kind}</div>
        </div>
        <button type="button" onClick={onClose} style={{ border: `1px solid ${C.border}`, borderRadius: 7, color: C.muted, background: 'transparent', cursor: 'pointer', padding: '5px 8px' }}>Close</button>
      </div>
      <div style={{ display: 'grid', gap: 7, color: C.muted, fontSize: 12.5 }}>
        {node.path && <Meta label="path" value={node.path} />}
        {node.graphId && <Meta label="graph" value={node.graphId} />}
        {node.sessionId && <Meta label="session" value={node.sessionId} />}
        {node.gateId && <Meta label="gate" value={node.gateId} />}
      </div>
      {preview?.nodeId === node.id && preview.error && <div style={{ color: C.err, fontSize: 12.5, marginTop: 10 }}>{preview.error}</div>}
      {preview?.nodeId === node.id && preview.file ? (
        <pre style={{ margin: '14px 0 0', padding: 12, border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg, color: C.read, fontSize: 11.5, whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 360 }}>
          {preview.file.content}
        </pre>
      ) : (
        <div style={{ marginTop: 14, color: C.read, fontSize: 13, lineHeight: 1.5 }}>{node.summary || 'No preview available for this node yet.'}</div>
      )}
    </aside>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '58px minmax(0,1fr)', gap: 8 }}>
      <span style={{ color: C.muted, fontFamily: FONT_MONO }}>{label}</span>
      <span style={{ color: C.read, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  )
}

const shell: React.CSSProperties = {
  borderLeft: `1px solid ${C.border}`,
  background: C.panel,
  padding: 14,
  minWidth: 260,
  overflow: 'auto',
}
