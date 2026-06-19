import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SelectionTray } from './SelectionTray'
import type { MesoNode } from './types'

const selected: MesoNode[] = [{
  id: 'doc:README.md',
  kind: 'doc',
  title: 'README.md',
  path: 'README.md',
  position: { x: 0, y: 0 },
  status: 'ok',
}]

afterEach(() => cleanup())

describe('SelectionTray', () => {
  it('builds context before ask is enabled', () => {
    const onBuild = vi.fn()
    const onAsk = vi.fn()
    render(<SelectionTray selected={selected} context={null} busy={false} onBuildContext={onBuild} onAsk={onAsk} />)

    fireEvent.click(screen.getByRole('button', { name: 'Build context' }))
    expect(onBuild).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Ask about selected' })).toBeDisabled()
  })

  it('shows context and calls ask when context exists', () => {
    const onAsk = vi.fn()
    render(
      <SelectionTray
        selected={selected}
        busy={false}
        onBuildContext={() => {}}
        onAsk={onAsk}
        context={{ nodes: ['doc:README.md'], edges: [], paths: ['README.md'], graphIds: [], sessionIds: [], summary: '1 node selected' }}
      />,
    )

    expect(screen.getByText('1 node selected')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ask about selected' }))
    expect(onAsk).toHaveBeenCalledTimes(1)
  })
})
