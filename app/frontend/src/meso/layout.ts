import type { Edge, Node } from '@xyflow/react'
import type { MesoEdge, MesoModel, MesoNode, MesoPosition } from './types'

export type MesoFlowNode = Node<{ node: MesoNode; onSelect?: (id: string) => void }, 'meso'>
export type MesoFlowEdge = Edge<{ kind: string }>

export function toFlowNodes(model: MesoModel, selected: string[] = []): MesoFlowNode[] {
  const selectedSet = new Set(selected)
  return model.nodes.map((node) => ({
    id: node.id,
    type: 'meso',
    position: node.position,
    data: { node },
    selected: selectedSet.has(node.id),
  }))
}

export function toFlowEdges(model: MesoModel, selected: string[] = []): MesoFlowEdge[] {
  const selectedSet = new Set(selected)
  return model.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label ?? edge.kind,
    data: { kind: edge.kind },
    selected: selectedSet.has(edge.id),
    animated: edge.kind === 'feeds' || edge.kind === 'generated_from',
    style: { strokeWidth: selectedSet.has(edge.id) ? 2.5 : 1.4 },
  }))
}

export function positionsFromFlowNodes(nodes: Pick<Node, 'id' | 'position'>[]): Record<string, MesoPosition> {
  const positions: Record<string, MesoPosition> = {}
  for (const node of nodes) {
    positions[node.id] = { x: node.position.x, y: node.position.y }
  }
  return positions
}

export function nodeMatchesQuery(node: MesoNode, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [node.id, node.title, node.path, node.summary, node.graphId, node.sessionId]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(q))
}

export function selectedObjects(model: MesoModel, nodeIds: string[], edgeIds: string[]): { nodes: MesoNode[]; edges: MesoEdge[] } {
  const nodeSet = new Set<string>(nodeIds)
  const edgeSet = new Set<string>(edgeIds)
  return {
    nodes: model.nodes.filter((node) => nodeSet.has(node.id)),
    edges: model.edges.filter((edge) => edgeSet.has(edge.id)),
  }
}
