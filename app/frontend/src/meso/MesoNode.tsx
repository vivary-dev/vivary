import { Handle, Position, type NodeProps } from '@xyflow/react'
import { C, FONT_MONO } from '../theme'
import type { MesoFlowNode } from './layout'
import type { MesoNodeKind } from './types'

const KIND_COLOR: Record<MesoNodeKind, string> = {
  file: C.blue,
  doc: C.accent,
  graph: C.priv,
  gate: C.warn,
  run: C.blue,
  plan: C.accent,
  diff: C.rose,
  flow: C.warn,
  note: C.muted,
}

const STATUS_LABEL: Record<string, string> = {
  ok: 'ok',
  warning: 'watch',
  blocked: 'blocked',
  changed: 'changed',
}

export function MesoNode({ data, selected }: NodeProps<MesoFlowNode>) {
  const node = data.node
  const color = KIND_COLOR[node.kind]
  const blocked = node.status === 'blocked'
  return (
    <div
      data-testid={`meso-card-${node.id}`}
      onClick={(event) => {
        event.stopPropagation()
        data.onSelect?.(node.id)
      }}
      style={{
        width: 214,
        minHeight: 92,
        background: selected ? C.raise : C.panel,
        border: `1px solid ${selected ? color : C.border}`,
        borderRadius: 8,
        boxShadow: selected ? `0 0 0 1px ${color}, 0 16px 28px oklch(0.16 0.02 215 / .24)` : '0 12px 22px oklch(0.16 0.02 215 / .14)',
        overflow: 'hidden',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: color, borderColor: C.bg }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px 6px' }}>
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            border: `1px solid ${color}`,
            color,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: FONT_MONO,
            fontSize: 10,
            textTransform: 'uppercase',
          }}
        >
          {node.kind.slice(0, 2)}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: C.text, fontSize: 13.5, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.title}</div>
          <div style={{ color: C.muted, fontFamily: FONT_MONO, fontSize: 10.5, textTransform: 'uppercase' }}>{node.kind}</div>
        </div>
      </div>
      <div style={{ padding: '0 10px 8px', color: C.muted, fontSize: 11.5, lineHeight: 1.35, minHeight: 31 }}>
        {node.summary || node.path || node.graphId || node.sessionId || 'Workspace object'}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderTop: `1px solid ${C.border}`, fontFamily: FONT_MONO, fontSize: 10.5 }}>
        <span style={{ color: blocked ? C.warn : color }}>{STATUS_LABEL[node.status ?? 'ok'] ?? node.status}</span>
        <span style={{ color: node.private ? C.priv : C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {node.private ? 'private' : node.path || ''}
        </span>
        <button
          type="button"
          data-testid={`meso-select-${node.id}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            data.onSelect?.(node.id)
          }}
          style={{
            marginLeft: 'auto',
            border: `1px solid ${selected ? color : C.border}`,
            borderRadius: 5,
            background: 'transparent',
            color,
            cursor: 'pointer',
            fontFamily: FONT_MONO,
            fontSize: 10,
            padding: '2px 5px',
          }}
        >
          Select
        </button>
      </div>
      <Handle type="source" position={Position.Right} style={{ background: color, borderColor: C.bg }} />
    </div>
  )
}
