import { describe, expect, it } from 'vitest'
import { applyEvent, visibleItems } from './reducer'
import type { AgentEvent, ChatItem } from './types'

const ev = (type: string, text = '', meta: Record<string, unknown> = {}, tool = ''): AgentEvent => ({ type, text, meta, tool })

describe('chat reducer', () => {
  it('keeps legacy text and tool events compatible', () => {
    let items: ChatItem[] = []
    items = applyEvent(items, ev('user_msg', 'hello'))
    items = applyEvent(items, ev('tool_use', 'Read README.md', { input: { file_path: 'README.md' } }, 'Read'))
    items = applyEvent(items, ev('tool_result', 'README contents'))
    items = applyEvent(items, ev('text', 'Final answer'))

    expect(items.map((i) => i.kind)).toEqual(['user', 'tool', 'answer'])
    const tool = items[1]
    expect(tool.kind).toBe('tool')
    if (tool.kind === 'tool') expect(tool.output).toBe('README contents')
  })

  it('updates structured tool lifecycle by id', () => {
    let items: ChatItem[] = []
    items = applyEvent(items, ev('tool', 'Read rg --files', { id: 'cmd_1', kind: 'read', status: 'in_progress', command: 'rg --files', risk: 'read' }, 'command'))
    items = applyEvent(items, ev('tool', 'Read rg --files', { id: 'cmd_1', kind: 'read', status: 'completed', command: 'rg --files', aggregated_output: 'README.md', exit_code: 0, risk: 'read' }, 'command'))

    expect(items).toHaveLength(1)
    const tool = items[0]
    expect(tool.kind).toBe('tool')
    if (tool.kind === 'tool') {
      expect(tool.status).toBe('completed')
      expect(tool.output).toBe('README.md')
      expect(tool.exitCode).toBe(0)
    }
  })

  it('keeps reasoning trace while updating the live line', () => {
    let items: ChatItem[] = []
    items = applyEvent(items, ev('reasoning', 'first thought', { id: 'r1', status: 'in_progress', streaming: true }))
    items = applyEvent(items, ev('reasoning', 'second thought', { id: 'r1', status: 'completed', streaming: false }))

    const reasoning = items[0]
    expect(reasoning.kind).toBe('reasoning')
    if (reasoning.kind === 'reasoning') {
      expect(reasoning.text).toBe('second thought')
      expect(reasoning.trace).toEqual(['first thought', 'second thought'])
      expect(reasoning.streaming).toBe(false)
    }
  })

  it('maps file changes, plan updates, and approvals', () => {
    let items: ChatItem[] = []
    items = applyEvent(items, ev('file_change', '', { id: 'f1', changes: [{ path: 'a.ts', kind: 'update' }] }))
    items = applyEvent(items, ev('plan', '', { id: 'p1', items: [{ text: 'Ship parser', completed: true }] }))
    items = applyEvent(items, ev('approval_request', '', { id: 'a1', kind: 'execute', risk: 'danger', command: 'npm test' }))

    expect(items.map((i) => i.kind)).toEqual(['fileChange', 'plan', 'approval'])
  })

  it('updates approval status without dropping the original action context', () => {
    let items: ChatItem[] = []
    items = applyEvent(items, ev('approval_request', '', { id: 'a1', kind: 'execute', risk: 'danger', command: 'npm test', status: 'pending' }))
    items = applyEvent(items, ev('approval_request', 'approval approved', { id: 'a1', status: 'approved', decision: 'allow_once' }))

    expect(items).toHaveLength(1)
    const approval = items[0]
    expect(approval.kind).toBe('approval')
    if (approval.kind === 'approval') {
      expect(approval.status).toBe('approved')
      expect(approval.actionKind).toBe('execute')
      expect(approval.risk).toBe('danger')
      expect(approval.command).toBe('npm test')
    }
  })

  it('consolidates repeated completed reads in compact mode', () => {
    let items: ChatItem[] = []
    items = applyEvent(items, ev('tool', 'Read A', { id: 'a', kind: 'read', status: 'completed', risk: 'read' }, 'command'))
    items = applyEvent(items, ev('tool', 'Read B', { id: 'b', kind: 'read', status: 'completed', risk: 'read' }, 'command'))
    items = applyEvent(items, ev('text', 'Done'))

    const compact = visibleItems(items, 'compact')
    expect(compact.map((i) => i.kind)).toEqual(['toolGroup', 'answer'])
    const group = compact[0]
    expect(group.kind).toBe('toolGroup')
    if (group.kind === 'toolGroup') expect(group.count).toBe(2)
  })
})
