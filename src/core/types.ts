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
  /** Reflection: how well did the previous action achieve its goal? */
  evaluation_previous_goal?: string
  /** Reflection: key information to remember for future steps */
  memory?: string
  /** Reflection: what should be accomplished in the next action */
  next_goal?: string
  action: AgentActionName
  args?: AgentActionArgs
}

export interface PageElementSummary {
  index: number
  tag: string
  role?: string | null
  type?: string | null
  label: string
  description?: string
  /**
   * Whether this entry is an actionable control or a scroll-only page landmark.
   * Used to group the serialized observation into clearly separated blocks so the
   * model never clicks a SECTION when it should select/filter.
   */
  kind?: 'interactive' | 'section'
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

export interface ActionQueueItemResult {
  action: AgentAction
  result: ActionExecutionResult
}

export interface ActionQueueResult {
  items: ActionQueueItemResult[]
  /** True only when an explicit `done` action (or result.done) ended the queue. */
  done: boolean
  /** Set when an action failed; carries the failure message. */
  error?: string
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
  /**
   * Two-phase flow only. Called after Phase 1 navigation so the host can
   * show the iframe and wait for it to load, then resolve the promise to
   * signal Phase 2 can start scanning the new DOM.
   */
  onPageReady?: () => Promise<void>
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
   * When true, `execute()` uses a two-phase flow:
   *   Phase 1 — LLM picks the target page (navigate only, no DOM)
   *   Phase 2 — iframe loads, host resolves `onPageReady`, LLM interacts
   *             with the freshly-scanned DOM of the correct page.
   * Requires `callbacks.onPageReady` to be set.
   */
  twoPhase?: boolean
  /**
   * The iframe's initial URL, provided by the host component. Used as a
   * fallback when the iframe is cross-origin and `contentWindow.location`
   * is inaccessible. The agent keeps this updated after each navigation.
   */
  currentUrl?: string
  /**
   * Full conversation history from the host chat UI (previous user→assistant
   * exchanges). Injected at the top of every LLM prompt so the model
   * remembers what was already discussed — enables cross-turn follow-ups
   * ("now filter by pending" after "show me applications").
   */
  conversationHistory?: ChatMessage[]
  /**
   * When true, the agent can answer freeform questions about the page
   * content (e.g. "what does this chart show?", "how many items?")
   * instead of strictly performing page actions. The prompt includes a
   * Q&A section that instructs the model to return a `done` with an
   * explanation when no page interaction is needed.
   */
  enableQAMode?: boolean
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
