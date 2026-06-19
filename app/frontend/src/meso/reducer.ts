import type { MesoSelectionContext, MesoState } from './types'

export type MesoAction =
  | { type: 'select'; nodes: string[]; edges?: string[] }
  | { type: 'context'; context: MesoSelectionContext | null }
  | { type: 'focus'; nodeId: string | null }
  | { type: 'clear' }

export const INITIAL_MESO_STATE: MesoState = {
  selectedNodes: [],
  selectedEdges: [],
  context: null,
  focusNodeId: null,
}

export function mesoReducer(state: MesoState, action: MesoAction): MesoState {
  switch (action.type) {
    case 'select':
      return {
        ...state,
        selectedNodes: stableUnique(action.nodes),
        selectedEdges: stableUnique(action.edges ?? []),
        context: null,
      }
    case 'context':
      return { ...state, context: action.context }
    case 'focus':
      return { ...state, focusNodeId: action.nodeId }
    case 'clear':
      return INITIAL_MESO_STATE
    default:
      return state
  }
}

function stableUnique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))]
}
