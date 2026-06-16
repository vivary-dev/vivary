export type Density = 'compact' | 'balanced' | 'detailed'

export interface AgentEvent {
  type: string
  text: string
  tool: string
  meta: Record<string, unknown>
}

export interface ToolChange {
  path: string
  kind: string
  additions?: number
  deletions?: number
}

export interface PlanItem {
  text: string
  status?: string
  completed?: boolean
}

export interface ApprovalOption {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
}

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'answer'; id: string; text: string }
  | { kind: 'reasoning'; id: string; text: string; trace: string[]; status: string; streaming: boolean }
  | {
      kind: 'tool'
      id: string
      tool: string
      label: string
      risk: string
      actionKind: string
      status: string
      command?: string
      target?: string
      output?: string
      exitCode?: number | null
      result?: unknown
    }
  | { kind: 'toolGroup'; id: string; actionKind: string; risk: string; count: number; labels: string[] }
  | { kind: 'fileChange'; id: string; status: string; changes: ToolChange[] }
  | { kind: 'plan'; id: string; items: PlanItem[]; status: string }
  | {
      kind: 'approval'
      id: string
      actionKind: string
      risk: string
      command?: string
      target?: string
      options: ApprovalOption[]
      status: string
    }
  | { kind: 'status'; id: string; text: string }
  | { kind: 'error'; id: string; text: string }

export interface Obs {
  status: 'idle' | 'running'
  cost: number
  inTok: number
  cachedInTok: number
  outTok: number
  reasoningTok: number
  turn: number
}

export const ZERO_OBS: Obs = {
  status: 'idle',
  cost: 0,
  inTok: 0,
  cachedInTok: 0,
  outTok: 0,
  reasoningTok: 0,
  turn: 0,
}
