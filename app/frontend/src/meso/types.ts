export type MesoNodeKind = 'file' | 'doc' | 'graph' | 'gate' | 'run' | 'plan' | 'diff' | 'flow' | 'note'

export type MesoEdgeKind =
  | 'links_to'
  | 'imports'
  | 'mentions'
  | 'generated_from'
  | 'blocked_by'
  | 'changed_by'
  | 'feeds'
  | 'approves'

export interface MesoPosition {
  x: number
  y: number
}

export interface MesoNode {
  id: `${MesoNodeKind}:${string}`
  kind: MesoNodeKind
  title: string
  path?: string
  graphId?: string
  gateId?: string
  sessionId?: string
  flowId?: string
  summary?: string
  position: MesoPosition
  status?: 'ok' | 'warning' | 'blocked' | 'changed'
  private?: boolean
}

export interface MesoEdge {
  id: string
  kind: MesoEdgeKind
  source: string
  target: string
  label?: string
}

export interface MesoModel {
  workspace: string
  nodes: MesoNode[]
  edges: MesoEdge[]
  views: unknown[]
  viewport?: { x: number; y: number; zoom: number } | null
  storage: string
  engine: { canvas: string; fallback: string }
}

export interface MesoSelectionContext {
  nodes: string[]
  edges: string[]
  paths: string[]
  graphIds: string[]
  sessionIds: string[]
  summary: string
}

export interface MesoState {
  selectedNodes: string[]
  selectedEdges: string[]
  context: MesoSelectionContext | null
  focusNodeId: string | null
}
