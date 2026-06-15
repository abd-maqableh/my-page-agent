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
  /**
   * Ask the model for the next action(s). Returning more than one action lets the
   * agent run a whole batch (e.g. apply several filters, then `done`) from a SINGLE
   * API round-trip instead of one call per action. The agent still re-observes and
   * re-asks whenever an action changes the page structure (navigate / click).
   */
  getNextActions(messages: ChatMessage[]): Promise<AgentAction[]>
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
   * Cap on generated tokens per call (`max_tokens`). The agent only needs a small
   * JSON action (or a short batch), so a low cap (e.g. 256–800) prevents slow,
   * runaway generation on verbose/"thinking" models. Omit to send no cap.
   */
  maxTokens?: number
  /**
   * When true, request `response_format: { type: 'json_object' }` so compatible
   * servers (vLLM, SGLang, OpenAI, …) return ONLY valid JSON — this also
   * suppresses long prose/think-traces, which is the biggest generation-time win.
   * Leave off for servers that do not support structured output.
   */
  jsonMode?: boolean
  /**
   * Abort a single request after this many ms (via AbortController) so a stuck
   * inference fails fast instead of hanging. Omit to wait indefinitely.
   */
  requestTimeoutMs?: number
  /**
   * Opt-in flag to allow `baseURL` pointing directly at a public model provider
   * (e.g. https://api.openai.com). DISABLED BY DEFAULT to prevent accidentally
   * shipping raw API keys to the browser. Production deployments MUST route
   * requests through a backend proxy you control.
   */
  allowDirectProvider?: boolean
}

export interface AgentConfigBase {
  /**
   * Optional injected client for deterministic tests, demos, or custom runtimes.
   * When omitted, the agent creates the default OpenAI-compatible client.
   */
  llmClient?: LLMClient
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
   * A value can be either a plain path string OR a {@link PageDescriptor}
   * that also declares the page's in-page `sections` and nested `subPages`.
   * Declaring `sections` lets the agent resolve a request like
   * "show me Sales Performance" to the owning page even when the user is
   * currently on a different page: it navigates there first, then scrolls
   * to the section.
   *
   * @example simple
   * pages: {
   *   'Users':    '/users',
   *   'Settings': '/settings',
   * }
   *
   * @example with sections & sub-pages
   * pages: {
   *   'Sales': {
   *     path: '/dashboard/sales',
   *     sections: ['Payout Overview', 'Sales Performance', 'Top Selling Trips'],
   *   },
   *   'Users': {
   *     path: '/dashboard/user/list',
   *     subPages: { 'Roles': '/dashboard/user/role' },
   *   },
   * }
   */
  pages?: Record<string, string | PageDescriptor>
}

/**
 * Rich description of a known page. Use instead of a plain path string when a
 * page contains named in-page sections (chart cards, widgets, panels) the user
 * may want to jump to, or nested sub-pages reachable from it.
 */
export interface PageDescriptor {
  /** URL path the agent navigates to for this page. */
  path: string
  /**
   * Names of in-page sections the user can scroll/jump to. These should match
   * the on-page section headings (or `data-agent-section` attributes) so the
   * scanner can locate them after navigation.
   */
  sections?: string[]
  /** Nested sub-pages reachable from this page (label → path or descriptor). */
  subPages?: Record<string, string | PageDescriptor>
}

export type AgentConfig = LLMConfig & AgentConfigBase

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
