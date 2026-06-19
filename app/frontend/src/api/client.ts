// API client. In dev, requests are proxied by Vite to the FastAPI backend.
// Protected routes need the per-launch token (from ~/.vivary-gui/runtime.json),
// supplied via VITE_VIVARY_TOKEN in .env.local. /api/health is open.

import type { MesoModel, MesoSelectionContext, MesoPosition } from '../meso/types'

const TOKEN = import.meta.env.VITE_VIVARY_TOKEN as string | undefined

async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers = new Headers(opts.headers)
  headers.set('Content-Type', 'application/json')
  if (TOKEN) headers.set('X-Vivary-Token', TOKEN)
  const res = await fetch(`/api${path}`, { ...opts, headers })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`)
  }
  return (await res.json()) as T
}

async function apiText(path: string): Promise<string> {
  const headers = new Headers()
  if (TOKEN) headers.set('X-Vivary-Token', TOKEN)
  const res = await fetch(`/api${path}`, { headers })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.text()
}

export interface Workspace {
  id: string
  name: string
  path: string
  health: { ok: boolean | null; errors: string[]; warnings: string[]; graph: Record<string, number> }
  index?: { indexed: number; private: number }
}

export interface Hit {
  workspace: string
  path: string
  title: string
  private: boolean
  snippet: string
  score: number
}

export const listWorkspaces = () => api<Workspace[]>('/workspaces')

export const addWorkspace = (path: string, name?: string) =>
  api<Workspace>('/workspaces', { method: 'POST', body: JSON.stringify({ path, name }) })

export const reindex = (id: string) =>
  api<{ indexed: number; private: number }>(`/workspaces/${id}/reindex`, { method: 'POST' })

export const search = (q: string, workspace?: string) => {
  const params = new URLSearchParams({ q })
  if (workspace) params.set('workspace', workspace)
  return api<{ query: string; count: number; hits: Hit[] }>(`/search?${params}`)
}

export const readFile = (id: string, path: string) =>
  api<{ path: string; content: string; private?: boolean }>(`/workspaces/${id}/file?path=${encodeURIComponent(path)}`)

export interface TreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  private?: boolean
  children?: TreeNode[]
}

export const getTree = (id: string) => api<TreeNode>(`/workspaces/${id}/tree`)

export interface StateSurface {
  state: { raw: string; sections: Record<string, string> } | null
  soul: string | null
  board: { items?: { id: string; status: string; assignee: string | null }[]; error?: string } | null
  review: { reviewed?: number; warnings?: number; findings?: unknown[]; error?: string } | null
}

export const getState = (id: string) => api<StateSurface>(`/workspaces/${id}/state`)

export interface Impacted {
  id: string
  type: string
  distance: number
  via: string
}

export const getBlast = (id: string, node: string) =>
  api<{ target: string; impacted: Impacted[] }>(`/workspaces/${id}/blast?node=${encodeURIComponent(node)}`)

export const getGraphView = (id: string) => apiText(`/workspaces/${id}/graph/view`)

export const getMeso = (id: string) => api<MesoModel>(`/workspaces/${id}/meso`)

export const saveMesoLayout = (
  id: string,
  positions: Record<string, MesoPosition>,
  viewport?: { x: number; y: number; zoom: number } | null,
) =>
  api<{ saved: number; viewport?: unknown }>(`/workspaces/${id}/meso/layout`, {
    method: 'PUT',
    body: JSON.stringify({ positions, viewport }),
  })

export const buildMesoContext = (id: string, nodes: string[], edges: string[] = []) =>
  api<MesoSelectionContext>(`/workspaces/${id}/meso/context`, {
    method: 'POST',
    body: JSON.stringify({ nodes, edges }),
  })

export const addMesoNode = (
  id: string,
  node: { kind: 'note' | 'flow'; id?: string; title?: string; text?: string; summary?: string; position?: MesoPosition },
) =>
  api(`/workspaces/${id}/meso/nodes`, {
    method: 'POST',
    body: JSON.stringify(node),
  })

export const runMesoFlow = (id: string, flowId: string, nodes: string[] = []) =>
  api(`/workspaces/${id}/meso/flows/${encodeURIComponent(flowId)}/run`, {
    method: 'POST',
    body: JSON.stringify({ nodes }),
  })

export interface RuntimeInfo {
  name: string
  label: string
  available: boolean
  multi_turn: boolean
}

export const getRuntimes = () => api<RuntimeInfo[]>('/runtimes')

export const createSession = (workspace: string, runtime: string) =>
  api<{ id: string }>('/sessions', { method: 'POST', body: JSON.stringify({ workspace, runtime }) })

export const sendMessage = (id: string, text: string) =>
  api<{ ok: boolean }>(`/sessions/${id}/send`, { method: 'POST', body: JSON.stringify({ text }) })

export const cancelSession = (id: string) =>
  api<{ cancelled: string }>(`/sessions/${id}/cancel`, { method: 'POST' })

export const sessionWsUrl = (id: string) =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/sessions/${id}`

// Token rides in the WS subprotocol offer, not the URL (URLs leak into logs/history).
// The server reads `token.<TOKEN>` and selects the constant `vivary` protocol.
export const sessionWsProtocols = (): string[] | undefined =>
  TOKEN ? ['vivary', `token.${TOKEN}`] : undefined

export const openSessionWs = (id: string) => new WebSocket(sessionWsUrl(id), sessionWsProtocols())

export interface SessionSummary {
  id: string
  runtime: string
  workspace: string
  status: string
}

export const listSessions = () => api<SessionSummary[]>('/sessions')

export interface Gate {
  id: string
  path: string
  status: string
  gate: string
  command_intent: string
  approver: string
  approved_at: string
}

export const getGates = (wsid: string) => api<Gate[]>(`/workspaces/${wsid}/gates`)

export const decideGate = (wsid: string, gid: string, decision: 'approve' | 'reject') =>
  api<Gate>(`/workspaces/${wsid}/gates/${gid}/${decision}`, { method: 'POST', body: '{}' })

// Session-scoped gates: a running agent raises gates into its own sandbox cwd (a worktree),
// so the chat decides them here — not against the workspace root.
export const getSessionGates = (sid: string) => api<Gate[]>(`/sessions/${sid}/gates`)

export const decideSessionGate = (sid: string, gid: string, decision: 'approve' | 'reject') =>
  api<Gate>(`/sessions/${sid}/gates/${gid}/${decision}`, { method: 'POST', body: '{}' })

export const resumeSession = (id: string) =>
  api<{ resumed: string }>(`/sessions/${id}/resume`, { method: 'POST' })

export interface Conflicts {
  active: string[]
  conflicts: { a: string; b: string; shared: string[] }[]
}

export const getConflicts = (wsid: string) => api<Conflicts>(`/workspaces/${wsid}/conflicts`)
