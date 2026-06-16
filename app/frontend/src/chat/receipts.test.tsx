import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalCard, FileChangeReceipt, PlanRail, ReasoningBox, ToolPill } from './receipts'

afterEach(() => cleanup())

describe('chat receipts', () => {
  it('collapses tool output until expanded', () => {
    render(<ToolPill density="balanced" item={{
      kind: 'tool',
      id: 'cmd',
      tool: 'command',
      label: 'Read README.md',
      risk: 'read',
      actionKind: 'read',
      status: 'completed',
      command: 'rg README',
      output: 'hidden output',
      exitCode: 0,
    }} />)

    expect(screen.queryByText('hidden output')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Read README.md/i }))
    expect(screen.getByText('hidden output')).toBeInTheDocument()
  })

  it('renders reasoning trace when opened', () => {
    render(<ReasoningBox density="balanced" item={{
      kind: 'reasoning',
      id: 'r1',
      text: 'latest',
      trace: ['first', 'latest'],
      status: 'completed',
      streaming: false,
    }} />)

    fireEvent.click(screen.getByRole('button', { name: /Thought/i }))
    expect(screen.getByText('first')).toBeInTheDocument()
  })

  it('renders file changes and plan items', () => {
    render(
      <>
        <FileChangeReceipt item={{ kind: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: 'src/a.ts', kind: 'update', additions: 2, deletions: 1 }] }} />
        <PlanRail item={{ kind: 'plan', id: 'p1', status: 'completed', items: [{ text: 'Verify parser', completed: true }] }} />
      </>,
    )

    expect(screen.getByText('src/a.ts')).toBeInTheDocument()
    expect(screen.getByText('Verify parser')).toBeInTheDocument()
  })

  it('renders default approval buttons', () => {
    render(<ApprovalCard item={{ kind: 'approval', id: 'a1', actionKind: 'execute', risk: 'danger', command: 'npm test', options: [], status: 'pending' }} />)
    expect(screen.getByText('Allow once')).toBeInTheDocument()
    expect(screen.getByText('Allow always')).toBeInTheDocument()
    expect(screen.getByText('Deny')).toBeInTheDocument()
  })

  it('sends scoped approval decisions and deny steering text', () => {
    const onDecide = vi.fn()
    render(<ApprovalCard
      item={{ kind: 'approval', id: 'a1', actionKind: 'execute', risk: 'danger', command: 'npm test', options: [], status: 'pending' }}
      onDecide={onDecide}
    />)

    fireEvent.change(screen.getByLabelText('Approval scope'), { target: { value: 'project' } })
    fireEvent.click(screen.getByText('Allow always'))
    expect(onDecide).toHaveBeenLastCalledWith('a1', 'allow_always', { scope: 'project', pattern: 'npm test', steering: '' })

    fireEvent.change(screen.getByLabelText('Deny steering'), { target: { value: 'Use npm run test instead.' } })
    fireEvent.click(screen.getByText('Deny'))
    expect(onDecide).toHaveBeenLastCalledWith('a1', 'reject_once', { scope: 'project', pattern: 'npm test', steering: 'Use npm run test instead.' })
  })
})
