import { useState } from 'react'
import type { ChatItem, Density } from './types'
import { C, FONT_MONO } from '../theme'

const RISK_COLOR: Record<string, string> = {
  read: C.accent,
  write: C.warn,
  danger: C.err,
  execute: C.err,
  delete: C.err,
  network: C.blue,
}

const KIND_ICON: Record<string, string> = {
  read: 'R',
  write: 'W',
  execute: 'X',
  delete: 'D',
  network: 'N',
  tool: 'T',
}

export function ReasoningBox({ item, density }: { item: Extract<ChatItem, { kind: 'reasoning' }>; density: Density }) {
  const [open, setOpen] = useState(density === 'detailed')
  const [pinned, setPinned] = useState(false)
  const done = item.status === 'completed'
  const expanded = open || pinned || density === 'detailed'
  return (
    <div style={{ border: `1px dashed ${C.border}`, borderRadius: 8, background: `oklch(0.24 0.02 215 / .45)`, color: C.muted, fontSize: 12.5 }}>
      <button type="button" onClick={() => setOpen((v) => !v)} style={receiptButton(C.priv)}>
        <span>{done ? 'Thought' : 'Thinking'}</span>
        <span style={{ color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.text || 'Working through the step.'}</span>
      </button>
      {expanded && (
        <div style={{ borderTop: `1px solid ${C.border}`, padding: '8px 11px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {item.trace.map((line, i) => <div key={`${item.id}-${i}`}>{line}</div>)}
          <button type="button" onClick={() => setPinned((v) => !v)} style={miniButton(pinned ? C.priv : C.muted)}>{pinned ? 'Pinned open' : 'Pin open'}</button>
        </div>
      )}
    </div>
  )
}

export function ToolPill({ item, density }: { item: Extract<ChatItem, { kind: 'tool' }>; density: Density }) {
  const [open, setOpen] = useState(density === 'detailed')
  const color = RISK_COLOR[item.risk] ?? C.muted
  const done = item.status === 'completed'
  const failed = item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0)
  const status = failed ? 'failed' : done ? 'done' : 'running'
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 9, overflow: 'hidden', background: C.panel }}>
      <button type="button" onClick={() => setOpen((v) => !v)} style={receiptButton(color)}>
        <span style={kindBadge(color)}>{KIND_ICON[item.actionKind] ?? 'T'}</span>
        <span style={{ color: C.text }}>{item.label}</span>
        <span style={{ marginLeft: 'auto', color }}>{status}</span>
      </button>
      {(open || density === 'detailed') && (
        <div style={{ borderTop: `1px solid ${C.border}`, padding: '9px 11px', fontFamily: FONT_MONO, fontSize: 11.5, color: C.muted, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
          {item.command && <div style={{ color: C.read }}>{item.command}</div>}
          {item.output && <div style={{ marginTop: item.command ? 8 : 0 }}>{item.output}</div>}
          {item.result !== undefined && <div style={{ marginTop: 8 }}>{JSON.stringify(item.result, null, 2)}</div>}
          {item.exitCode !== undefined && item.exitCode !== null && <div style={{ marginTop: 8, color: failed ? C.err : C.accent }}>exit {item.exitCode}</div>}
        </div>
      )}
    </div>
  )
}

export function ToolGroup({ item }: { item: Extract<ChatItem, { kind: 'toolGroup' }> }) {
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 9, background: C.panel, padding: '7px 11px', fontFamily: FONT_MONO, fontSize: 12, color: C.muted }}>
      <span style={kindBadge(C.accent)}>R</span> Read x{item.count}
      <span style={{ marginLeft: 8 }}>{item.labels.slice(0, 3).join(' · ')}{item.labels.length > 3 ? ' …' : ''}</span>
    </div>
  )
}

export function FileChangeReceipt({ item }: { item: Extract<ChatItem, { kind: 'fileChange' }> }) {
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 9, background: C.panel, overflow: 'hidden' }}>
      <div style={{ padding: '8px 11px', fontFamily: FONT_MONO, fontSize: 12.5, color: C.warn }}>File changes · {item.changes.length}</div>
      <div style={{ borderTop: `1px solid ${C.border}`, padding: '6px 11px', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {item.changes.map((c) => (
          <div key={`${c.kind}-${c.path}`} style={{ display: 'grid', gridTemplateColumns: '70px minmax(0, 1fr) auto', gap: 8, fontSize: 12.5 }}>
            <span style={{ color: c.kind === 'delete' ? C.err : c.kind === 'add' ? C.accent : C.warn }}>{c.kind}</span>
            <span style={{ color: C.read, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.path}</span>
            <span style={{ color: C.muted }}>{c.additions ?? 0}+ / {c.deletions ?? 0}-</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function PlanRail({ item }: { item: Extract<ChatItem, { kind: 'plan' }> }) {
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 9, background: C.panel, padding: '9px 11px' }}>
      <div style={{ fontFamily: FONT_MONO, fontSize: 11, letterSpacing: '.08em', color: C.muted, marginBottom: 8 }}>PLAN</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {item.items.map((step, i) => (
          <div key={`${step.text}-${i}`} style={{ display: 'flex', gap: 8, fontSize: 13, color: step.completed ? C.muted : C.read }}>
            <span style={{ color: step.completed ? C.accent : C.warn }}>{step.completed ? 'done' : 'todo'}</span>
            <span>{step.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ApprovalCard({
  item,
  onDecide,
}: {
  item: Extract<ChatItem, { kind: 'approval' }>
  onDecide?: (id: string, decision: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always', body: { scope?: string; pattern?: string; steering?: string }) => void
}) {
  const [scope, setScope] = useState('global')
  const [steering, setSteering] = useState('')
  const color = RISK_COLOR[item.risk] ?? C.warn
  const resolved = item.status === 'approved' || item.status === 'rejected'
  const run = (decision: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always') => {
    onDecide?.(item.id, decision, { scope, pattern: item.command, steering })
  }
  return (
    <div style={{ border: `1px solid ${color}`, borderRadius: 10, background: `linear-gradient(180deg, oklch(0.28 0.035 78 / .35), ${C.panel})`, overflow: 'hidden' }}>
      <div style={{ padding: '9px 12px', display: 'flex', gap: 9, alignItems: 'center', fontFamily: FONT_MONO, fontSize: 12.5, color }}>
        <span style={kindBadge(color)}>!</span>
        <span>{resolved ? `Approval ${item.status}` : 'Approval needed'}</span>
        <span style={{ marginLeft: 'auto', color: C.muted }}>{item.actionKind}</span>
      </div>
      <div style={{ padding: '0 12px 10px', fontSize: 12.5, color: C.read }}>{item.command || item.target || 'Tool call requires approval.'}</div>
      {!resolved && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: `1px solid ${C.border}`, padding: '10px 12px' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => run('allow_once')} style={actionButton(C.accent)}>Allow once</button>
            <button type="button" onClick={() => run('allow_always')} style={actionButton(C.accent)}>Allow always</button>
            <button type="button" onClick={() => run('reject_once')} style={actionButton(C.err)}>Deny</button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Approval scope" style={{ background: C.bg, border: `1px solid ${C.border}`, color: C.read, borderRadius: 6, fontSize: 12, padding: '5px 7px' }}>
              <option value="command">command</option>
              <option value="global">global</option>
            </select>
            <input value={steering} onChange={(e) => setSteering(e.target.value)} aria-label="Deny steering" placeholder="Deny note or steering..." style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`, color: C.read, borderRadius: 6, fontSize: 12, padding: '5px 7px' }} />
          </div>
        </div>
      )}
    </div>
  )
}

function receiptButton(color: string): React.CSSProperties {
  return {
    width: '100%',
    background: 'transparent',
    border: 'none',
    color,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontFamily: FONT_MONO,
    fontSize: 12.5,
    padding: '7px 11px',
    textAlign: 'left',
  }
}

function kindBadge(color: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 18,
    height: 18,
    borderRadius: 5,
    border: `1px solid ${color}`,
    color,
    fontFamily: FONT_MONO,
    fontSize: 10,
    flex: '0 0 auto',
  }
}

function miniButton(color: string): React.CSSProperties {
  return { alignSelf: 'flex-start', background: 'transparent', border: `1px solid ${C.border}`, borderRadius: 6, color, cursor: 'pointer', fontSize: 11, padding: '3px 7px' }
}

function actionButton(color: string): React.CSSProperties {
  return { background: 'transparent', border: `1px solid ${color}`, borderRadius: 7, color, cursor: 'pointer', fontSize: 12.5, padding: '6px 9px' }
}
