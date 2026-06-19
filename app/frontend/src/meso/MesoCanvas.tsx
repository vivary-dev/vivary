import { useCallback, useMemo } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type NodeMouseHandler,
  type OnNodeDrag,
  type OnSelectionChangeParams,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { C } from '../theme'
import { MesoNode as MesoNodeCard } from './MesoNode'
import { nodeMatchesQuery, toFlowEdges, toFlowNodes, type MesoFlowNode } from './layout'
import type { MesoModel, MesoNode, MesoPosition } from './types'

const nodeTypes = { meso: MesoNodeCard }
const proOptions = { hideAttribution: true }

export function MesoCanvas({
  model,
  query,
  selectedNodes,
  selectedEdges,
  onSelect,
  onFocus,
  onLayoutCommit,
}: {
  model: MesoModel
  query: string
  selectedNodes: string[]
  selectedEdges: string[]
  onSelect: (nodes: string[], edges: string[]) => void
  onFocus: (node: MesoNode) => void
  onLayoutCommit: (positions: Record<string, MesoPosition>) => void
}) {
  const filteredIds = useMemo<Set<string>>(() => new Set(model.nodes.filter((node) => nodeMatchesQuery(node, query)).map((node) => node.id)), [model.nodes, query])
  const visibleModel = useMemo<MesoModel>(() => {
    const nodes = query ? model.nodes.filter((node) => filteredIds.has(node.id)) : model.nodes
    const nodeIds = new Set<string>(nodes.map((node) => node.id))
    const edges = query ? model.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)) : model.edges
    return { ...model, nodes, edges }
  }, [filteredIds, model, query])

  const nodes = useMemo(
    () => toFlowNodes(visibleModel, selectedNodes).map((node) => ({
      ...node,
      data: { ...node.data, onSelect: (id: string) => onSelect([id], []) },
    })),
    [onSelect, selectedNodes, visibleModel],
  )
  const edges = useMemo(() => toFlowEdges(visibleModel, selectedEdges), [selectedEdges, visibleModel])
  const canvasKey = `${model.workspace}:${query}:${model.nodes.length}:${model.edges.length}`

  const handleSelection = useCallback(({ nodes: nextNodes, edges: nextEdges }: OnSelectionChangeParams) => {
    onSelect(nextNodes.map((node) => node.id), nextEdges.map((edge) => edge.id))
  }, [onSelect])
  const handleDoubleClick = useCallback<NodeMouseHandler<MesoFlowNode>>((_, node) => {
    onFocus(node.data.node)
  }, [onFocus])
  const handleNodeClick = useCallback<NodeMouseHandler<MesoFlowNode>>((_, node) => {
    onSelect([node.id], [])
  }, [onSelect])
  const handleDragStop = useCallback<OnNodeDrag<MesoFlowNode>>((_, node) => {
    onLayoutCommit({ [node.id]: node.position })
  }, [onLayoutCommit])

  return (
    <div style={{ width: '100%', height: '100%', background: C.bg }}>
      <ReactFlow
        key={canvasKey}
        defaultNodes={nodes}
        defaultEdges={edges}
        nodeTypes={nodeTypes}
        onSelectionChange={handleSelection}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleDoubleClick}
        onNodeDragStop={handleDragStop}
        fitView
        minZoom={0.2}
        maxZoom={1.8}
        nodesDraggable
        elementsSelectable
        onlyRenderVisibleElements
        proOptions={proOptions}
      >
        <Background color={C.border} gap={24} size={1} />
        <Controls position="bottom-left" />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(node) => {
            const kind = (node.data?.node as MesoNode | undefined)?.kind
            if (kind === 'gate') return C.warn
            if (kind === 'graph') return C.priv
            if (kind === 'doc') return C.accent
            return C.blue
          }}
          maskColor="oklch(0.18 0.014 215 / .72)"
          style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 8 }}
        />
      </ReactFlow>
    </div>
  )
}
