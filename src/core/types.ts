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

export type LLMProvider = 'openai' | 'ollama'

export interface LLMClient {
  getNextAction(messages: ChatMessage[]): Promise<AgentAction>
}

export interface OpenAIConfig {
  provider?: 'openai'
  baseURL: string
  apiKey: string
  model: string
  temperature?: number
  /**
   * Opt-in flag to allow `baseURL` pointing directly at a public model provider
   * (e.g. https://api.openai.com). DISABLED BY DEFAULT to prevent accidentally
   * shipping raw API keys to the browser. Production deployments MUST route
   * requests through a backend proxy you control.
   */
  allowDirectProvider?: boolean
}

export interface OllamaConfig {
  provider: 'ollama'
  baseURL?: string
  model: string
  temperature?: number
}

export type LLMConfig = OpenAIConfig | OllamaConfig

export interface AgentConfigBase {
  maxSteps?: number
  callbacks?: AgentCallbacks
  /**
   * Optional gate invoked before every action is executed. Return false (or a
   * Promise resolving to false) to abort the run. Useful for blocking
   * destructive actions (form submits, navigations, deletes) on production
   * pages.
   */
  confirmAction?: (action: AgentAction) => boolean | Promise<boolean>
}

export type AgentConfig = LLMConfig & AgentConfigBase

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
