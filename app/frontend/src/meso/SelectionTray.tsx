import { C, FONT_MONO } from '../theme'
import type { MesoNode, MesoSelectionContext } from './types'

export function SelectionTray({
  selected,
  context,
  busy,
  onBuildContext,
  onAsk,
}: {
  selected: MesoNode[]
  context: MesoSelectionContext | null
  busy: boolean
  onBuildContext: () => void
  onAsk: () => void
}) {
  return (
    <div style={{ borderTop: `1px solid ${C.border}`, background: C.panel, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <div>
          <div style={{ color: C.text, fontSize: 13, fontWeight: 650 }}>{selected.length} selected</div>
          <div style={{ color: C.muted, fontFamily: FONT_MONO, fontSize: 11 }}>{selected.slice(0, 3).map((node) => node.title).join(' | ') || 'Select canvas objects'}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={onBuildContext} disabled={selected.length === 0 || busy} style={button(C.accent, selected.length === 0 || busy)}>
            {busy ? 'Building' : 'Build context'}
          </button>
          <button type="button" onClick={onAsk} disabled={!context} style={button(C.warn, !context)}>
            Ask about selected
          </button>
        </div>
      </div>
      {context && (
        <div style={{ marginTop: 9, border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg, padding: 9 }}>
          <div style={{ color: C.read, fontSize: 12.5 }}>{context.summary}</div>
          <div style={{ color: C.muted, fontFamily: FONT_MONO, fontSize: 11, marginTop: 5 }}>
            {context.paths.length} path(s), {context.graphIds.length} graph node(s), {context.sessionIds.length} session(s)
          </div>
        </div>
      )}
    </div>
  )
}

function button(color: string, disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? 'transparent' : color,
    border: `1px solid ${disabled ? C.border : color}`,
    color: disabled ? C.muted : C.bg,
    borderRadius: 8,
    cursor: disabled ? 'default' : 'pointer',
    fontSize: 12.5,
    fontWeight: 650,
    padding: '7px 10px',
  }
}
