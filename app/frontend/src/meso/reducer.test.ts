import { describe, expect, it } from 'vitest'
import { INITIAL_MESO_STATE, mesoReducer } from './reducer'
import { nodeMatchesQuery, positionsFromFlowNodes } from './layout'
import type { MesoNode } from './types'

describe('meso reducer and layout helpers', () => {
  it('tracks selected nodes and clears stale context on selection change', () => {
    const withContext = mesoReducer(INITIAL_MESO_STATE, {
      type: 'context',
      context: { nodes: ['doc:README.md'], edges: [], paths: ['README.md'], graphIds: [], sessionIds: [], summary: 'one' },
    })
    const next = mesoReducer(withContext, { type: 'select', nodes: ['doc:README.md', 'doc:README.md'], edges: ['e1'] })

    expect(next.selectedNodes).toEqual(['doc:README.md'])
    expect(next.selectedEdges).toEqual(['e1'])
    expect(next.context).toBeNull()
  })

  it('serializes node positions for layout persistence', () => {
    expect(positionsFromFlowNodes([{ id: 'doc:README.md', position: { x: 10, y: 20 } }])).toEqual({
      'doc:README.md': { x: 10, y: 20 },
    })
  })

  it('matches search text against title path summary and ids', () => {
    const node: MesoNode = {
      id: 'doc:README.md',
      kind: 'doc',
      title: 'README.md',
      path: 'README.md',
      summary: 'Project overview',
      position: { x: 0, y: 0 },
      status: 'ok',
    }

    expect(nodeMatchesQuery(node, 'overview')).toBe(true)
    expect(nodeMatchesQuery(node, 'missing')).toBe(false)
  })
})
