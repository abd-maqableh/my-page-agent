export type AgentActionName =
  | 'click'
  | 'input'
  | 'select'
  | 'scroll'
  | 'wait'
  | 'navigate'
  | 'clear'
  | 'press_key'
  | 'hover'
  | 'done'

export type AgentActionArgs = {
  index?: number
  text?: string
  value?: string
  direction?: 'up' | 'down'
  amount?: number
  timeoutMs?: number
  result?: string
  url?: string
  key?: string
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

export interface LLMClient {
  getNextAction(messages: ChatMessage[]): Promise<AgentAction>
}

/**
 * Universal LLM configuration. Point `baseURL` at any OpenAI-compatible
 * endpoint — OpenAI proxy, Ollama, Groq, Azure OpenAI, LM Studio, etc.
 *
 * @example OpenAI (via backend proxy — recommended)
 * { baseURL: 'https://your-proxy.com/v1', apiKey: 'token', model: 'gpt-4o' }
 *
 * @example Ollama local
 * { baseURL: 'http://localhost:11434/v1', apiKey: 'NA', model: 'llama3.2' }
 *
 * @example Groq cloud
 * { baseURL: 'https://api.groq.com/openai/v1', apiKey: '...', model: 'llama-3.3-70b-versatile' }
 *
 * @example Azure OpenAI
 * { baseURL: 'https://your-resource.openai.azure.com/openai/deployments/gpt-4o', apiKey: '...' }
 */
export interface LLMConfig {
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
  /**
   * When set, the agent operates on the iframe's document and window instead
   * of the host page. Required for the split-screen /chat view.
   */
  targetFrame?: HTMLIFrameElement
  /**
   * Optional map of human-readable page names to URL paths.
   * When provided, the agent uses these paths for `navigate` actions.
   *
   * @example
   * pages: {
   *   'Users':    '/users',
   *   'Settings': '/settings',
   * }
   */
  pages?: Record<string, string>
}

export type AgentConfig = LLMConfig & AgentConfigBase

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
