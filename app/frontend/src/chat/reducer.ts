import type { AgentEvent, ApprovalOption, ChatItem, Density, PlanItem, ToolChange } from './types'

const idFor = (prefix: string, items: ChatItem[], ev: AgentEvent) =>
  stringMeta(ev, 'id') || `${prefix}-${items.length + 1}`

const stringMeta = (ev: AgentEvent, key: string): string =>
  typeof ev.meta?.[key] === 'string' ? ev.meta[key] as string : ''

const numberMeta = (ev: AgentEvent, key: string): number | null =>
  typeof ev.meta?.[key] === 'number' ? ev.meta[key] as number : null

const boolMeta = (ev: AgentEvent, key: string): boolean =>
  typeof ev.meta?.[key] === 'boolean' ? ev.meta[key] as boolean : false

function upsert(items: ChatItem[], next: ChatItem): ChatItem[] {
  const idx = items.findIndex((it) => it.id === next.id && it.kind === next.kind)
  if (idx < 0) return [...items, next]
  const copy = [...items]
  copy[idx] = next
  return copy
}

function updateLastLegacyTool(items: ChatItem[], result: string): ChatItem[] {
  const rev = [...items].reverse().findIndex((x) => x.kind === 'tool' && x.output === undefined)
  if (rev < 0) return items
  const idx = items.length - 1 - rev
  const copy = [...items]
  const prev = copy[idx]
  if (prev.kind === 'tool') copy[idx] = { ...prev, output: result, status: 'completed' }
  return copy
}

export function applyEvent(prev: ChatItem[], ev: AgentEvent): ChatItem[] {
  switch (ev.type) {
    case 'user_msg':
      return [...prev, { kind: 'user', id: idFor('user', prev, ev), text: ev.text }]
    case 'text':
      return [...prev, { kind: 'answer', id: idFor('answer', prev, ev), text: ev.text }]
    case 'tool_use':
      return [...prev, {
        kind: 'tool',
        id: idFor('legacy-tool', prev, ev),
        tool: ev.tool || 'tool',
        label: ev.text || ev.tool || 'Tool',
        risk: 'read',
        actionKind: 'tool',
        status: 'in_progress',
        command: JSON.stringify(ev.meta?.input ?? {}),
      }]
    case 'tool_result':
      return updateLastLegacyTool(prev, ev.text)
    case 'reasoning': {
      const id = idFor('reasoning', prev, ev)
      const existing = prev.find((it) => it.kind === 'reasoning' && it.id === id)
      const trace = existing?.kind === 'reasoning' ? [...existing.trace] : []
      if (ev.text && trace[trace.length - 1] !== ev.text) trace.push(ev.text)
      return upsert(prev, {
        kind: 'reasoning',
        id,
        text: ev.text,
        trace,
        status: stringMeta(ev, 'status') || 'in_progress',
        streaming: boolMeta(ev, 'streaming'),
      })
    }
    case 'tool': {
      const id = idFor('tool', prev, ev)
      const existing = prev.find((it) => it.kind === 'tool' && it.id === id)
      const prevTool = existing?.kind === 'tool' ? existing : undefined
      return upsert(prev, {
        kind: 'tool',
        id,
        tool: ev.tool || prevTool?.tool || 'tool',
        label: ev.text || prevTool?.label || ev.tool || 'Tool',
        risk: stringMeta(ev, 'risk') || prevTool?.risk || 'read',
        actionKind: stringMeta(ev, 'kind') || prevTool?.actionKind || 'tool',
        status: stringMeta(ev, 'status') || prevTool?.status || 'in_progress',
        command: stringMeta(ev, 'command') || prevTool?.command,
        target: stringMeta(ev, 'target') || prevTool?.target,
        output: stringMeta(ev, 'aggregated_output') || prevTool?.output,
        exitCode: numberMeta(ev, 'exit_code') ?? prevTool?.exitCode,
        result: ev.meta?.result ?? prevTool?.result,
      })
    }
    case 'file_change':
      return upsert(prev, {
        kind: 'fileChange',
        id: idFor('file', prev, ev),
        status: stringMeta(ev, 'status') || 'completed',
        changes: Array.isArray(ev.meta?.changes) ? ev.meta.changes as ToolChange[] : [],
      })
    case 'plan':
      return upsert(prev, {
        kind: 'plan',
        id: idFor('plan', prev, ev),
        status: stringMeta(ev, 'status') || 'completed',
        items: Array.isArray(ev.meta?.items) ? ev.meta.items as PlanItem[] : [],
      })
    case 'approval_request':
      {
        const id = idFor('approval', prev, ev)
        const existing = prev.find((it) => it.kind === 'approval' && it.id === id)
        const prevApproval = existing?.kind === 'approval' ? existing : undefined
      return upsert(prev, {
        kind: 'approval',
        id,
        actionKind: stringMeta(ev, 'kind') || prevApproval?.actionKind || 'tool',
        risk: stringMeta(ev, 'risk') || prevApproval?.risk || 'write',
        command: stringMeta(ev, 'command') || prevApproval?.command,
        target: stringMeta(ev, 'target') || prevApproval?.target,
        options: Array.isArray(ev.meta?.options) ? ev.meta.options as ApprovalOption[] : prevApproval?.options ?? [],
        status: stringMeta(ev, 'status') || prevApproval?.status || 'pending',
      })
      }
    case 'status':
      return ev.text && ev.text !== 'session created'
        ? [...prev, { kind: 'status', id: idFor('status', prev, ev), text: ev.text }]
        : prev
    case 'error':
      return [...prev, { kind: 'error', id: idFor('error', prev, ev), text: ev.text }]
    default:
      return prev
  }
}

export function visibleItems(items: ChatItem[], density: Density): ChatItem[] {
  if (density !== 'compact') return items
  const out: ChatItem[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind !== 'tool' || it.risk !== 'read' || it.status !== 'completed') {
      out.push(it)
      continue
    }
    const labels = [it.label]
    let j = i + 1
    while (j < items.length) {
      const nxt = items[j]
      if (nxt.kind !== 'tool' || nxt.risk !== 'read' || nxt.status !== 'completed') break
      labels.push(nxt.label)
      j++
    }
    if (labels.length > 1) {
      out.push({ kind: 'toolGroup', id: `group-${it.id}`, actionKind: 'read', risk: 'read', count: labels.length, labels })
      i = j - 1
    } else {
      out.push(it)
    }
  }
  return out
}
