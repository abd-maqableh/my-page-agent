export type AgentActionName = 'click' | 'input' | 'select' | 'scroll' | 'wait' | 'done'

export type AgentActionArgs = {
  index?: number
  text?: string
  value?: string
  direction?: 'up' | 'down'
  amount?: number
  timeoutMs?: number
  result?: string
}

export interface AgentAction {
  thought?: string
  action: AgentActionName
  args?: AgentActionArgs
}

export interface PageElementSummary {
  index: number
  tag: string
  role?: string | null
  type?: string | null
  label: string
}

export interface PageObservation {
  url: string
  title: string
  elements: PageElementSummary[]
  elementsText: string
}

export interface ActionExecutionResult {
  success: boolean
  message: string
  done?: boolean
}

export interface AgentHistoryEntry {
  step: number
  observation: string
  action: AgentAction
  result: ActionExecutionResult
}

export interface AgentCallbacks {
  onStatus?: (status: string) => void
  onStep?: (entry: AgentHistoryEntry) => void
}

export interface AgentRunResult {
  status: 'done' | 'error' | 'max_steps'
  history: AgentHistoryEntry[]
  message: string
}

export interface OpenAIConfig {
  baseURL: string
  apiKey: string
  model: string
  temperature?: number
}

export interface AgentConfig extends OpenAIConfig {
  maxSteps?: number
  callbacks?: AgentCallbacks
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
