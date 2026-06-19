import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import { buildMesoContext, getMeso, saveMesoLayout } from '../api/client'
import { C, FONT_MONO } from '../theme'
import { FocusSurface } from './FocusSurface'
import { MesoCanvas } from './MesoCanvas'
import { selectedObjects } from './layout'
import { INITIAL_MESO_STATE, mesoReducer } from './reducer'
import { SelectionTray } from './SelectionTray'
import type { MesoModel, MesoNode, MesoPosition, MesoSelectionContext } from './types'

export function MesoPanel({ wsid, onSendContext }: { wsid: string; onSendContext: (context: MesoSelectionContext) => void }) {
  const [model, setModel] = useState<MesoModel | null>(null)
  const [state, dispatch] = useReducer(mesoReducer, INITIAL_MESO_STATE)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    getMeso(wsid).then((next) => {
      setModel(next)
      setError(null)
      dispatch({ type: 'clear' })
    }).catch((err) => setError(String(err)))
  }, [wsid])

  useEffect(() => { load() }, [load])

  const selected = useMemo(() => model ? selectedObjects(model, state.selectedNodes, state.selectedEdges) : { nodes: [], edges: [] }, [model, state.selectedEdges, state.selectedNodes])
  const focused = useMemo(() => model?.nodes.find((node) => node.id === state.focusNodeId) ?? null, [model, state.focusNodeId])

  const commitLayout = useCallback(async (positions: Record<string, MesoPosition>) => {
    try {
      await saveMesoLayout(wsid, positions)
      setModel((prev) => prev ? {
        ...prev,
        nodes: prev.nodes.map((node) => positions[node.id] ? { ...node, position: positions[node.id] } : node),
      } : prev)
    } catch (err) {
      setError(String(err))
    }
  }, [wsid])
  const selectCanvasObjects = useCallback((nodes: string[], edges: string[]) => {
    dispatch({ type: 'select', nodes, edges })
  }, [])
  const focusCanvasNode = useCallback((node: MesoNode) => {
    dispatch({ type: 'focus', nodeId: node.id })
  }, [])

  const buildContext = async () => {
    if (!state.selectedNodes.length) return
    setBusy(true)
    setError(null)
    try {
      const context = await buildMesoContext(wsid, state.selectedNodes, state.selectedEdges)
      dispatch({ type: 'context', context })
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const ask = () => {
    if (!state.context) return
    onSendContext(state.context)
  }

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto', background: C.bg }}>
      <header style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px', borderBottom: `1px solid ${C.border}`, background: C.panel }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ color: C.text, fontSize: 14, fontWeight: 700 }}>Meso Canvas</div>
          <div style={{ color: C.muted, fontFamily: FONT_MONO, fontSize: 10.5 }}>{model ? `${model.nodes.length} nodes | ${model.edges.length} edges` : 'loading workspace map'}</div>
        </div>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search canvas..."
          style={{ marginLeft: 'auto', width: 190, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, color: C.read, padding: '7px 9px', fontSize: 12.5 }}
        />
        <button type="button" onClick={load} style={{ border: `1px solid ${C.border}`, background: C.bg, color: C.muted, borderRadius: 8, padding: '7px 9px', cursor: 'pointer', fontSize: 12.5 }}>Refresh</button>
      </header>

      <main style={{ minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px' }}>
        <div style={{ minWidth: 0, minHeight: 0 }}>
          {error && <div style={{ position: 'absolute', zIndex: 4, margin: 12, color: C.err, background: C.panel, border: `1px solid ${C.err}`, borderRadius: 8, padding: 10, fontSize: 12.5 }}>{error}</div>}
          {model ? (
            <MesoCanvas
              model={model}
              query={query}
              selectedNodes={state.selectedNodes}
              selectedEdges={state.selectedEdges}
              onSelect={selectCanvasObjects}
              onFocus={focusCanvasNode}
              onLayoutCommit={commitLayout}
            />
          ) : (
            <div style={{ color: C.muted, padding: 18 }}>Building Meso map...</div>
          )}
        </div>
        <FocusSurface wsid={wsid} node={focused} onClose={() => dispatch({ type: 'focus', nodeId: null })} />
      </main>

      <SelectionTray selected={selected.nodes} context={state.context} busy={busy} onBuildContext={buildContext} onAsk={ask} />
    </div>
  )
}
