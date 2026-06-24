import { normalizeActions } from '../core/tools'
import type { AgentAction, ChatMessage, LLMClient, LLMConfig } from '../core/types'

interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** Tool definitions for each agent action — replaces `response_format`. */
const ACTION_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click on an element by index (buttons, links, tabs, checkboxes)',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'Element index to click' },
          evaluation_previous_goal: { type: 'string', description: 'Was the last action successful? What changed?' },
          memory: { type: 'string', description: 'Key facts to remember for future steps' },
          next_goal: { type: 'string', description: 'What to do next and why' },
        },
        required: ['index'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'input',
      description: 'Type text into a text field or search box by element index',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'Element index to type into' },
          text: { type: 'string', description: 'Text to input' },
          evaluation_previous_goal: { type: 'string' },
          memory: { type: 'string' },
          next_goal: { type: 'string' },
        },
        required: ['index', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select',
      description: 'Select an option from a dropdown or combobox by element index',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'Element index of the dropdown' },
          value: { type: 'string', description: 'Option value to select' },
          evaluation_previous_goal: { type: 'string' },
          memory: { type: 'string' },
          next_goal: { type: 'string' },
        },
        required: ['index', 'value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: 'Scroll the page or a specific element into view',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'Element index to scroll to' },
          direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
          amount: { type: 'number', description: 'Number of pages to scroll' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait',
      description: 'Wait for a specified time in milliseconds',
      parameters: {
        type: 'object',
        properties: {
          timeoutMs: { type: 'number', description: 'Milliseconds to wait' },
        },
        required: ['timeoutMs'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Navigate the iframe to a different page path',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The page path to navigate to (e.g., /applications)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: 'Signal that the task is complete, with a result summary',
      parameters: {
        type: 'object',
        properties: {
          result: { type: 'string', description: 'Summary of what was accomplished' },
        },
        required: ['result'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clear',
      description: 'Clear the content of an input element by index',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'Element index to clear' },
        },
        required: ['index'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'press_key',
      description: 'Press a keyboard key, optionally focused on a specific element',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Key to press (e.g., Enter, Escape, Tab)' },
          index: { type: 'number', description: 'Optional element index to focus before pressing' },
        },
        required: ['key'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hover',
      description: 'Hover over an element by index',
      parameters: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'Element index to hover' },
        },
        required: ['index'],
      },
    },
  },
]

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: {
      content?: string | null
      tool_calls?: Array<{
        id: string
        type: 'function'
        function: {
          name: string
          arguments: string
        }
      }>
    }
    finish_reason?: string | null
  }>
  error?: { message?: string } | string
}

/** Read an error message from either the OpenAI-style object or a bare string. */
function readErrorMessage(error: ChatCompletionsResponse['error']): string | undefined {
  if (!error) return undefined
  if (typeof error === 'string') return error
  return error.message
}

function extractJSON(text: string): string {
  const trimmed = text.trim()

  // Extract content from markdown code fences first
  const block = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidate = block?.[1]?.trim() ?? trimmed

  // Find the FIRST JSON value — either an object `{...}` or an array `[...]` — and
  // return it via balanced-bracket extraction.
  let start = -1
  let open = '{'
  let close = '}'
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i]
    if (ch === '{' || ch === '[') {
      start = i
      open = ch
      close = ch === '{' ? '}' : ']'
      break
    }
  }
  if (start === -1) {
    throw new Error('LLM response did not include a JSON object.')
  }

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (escaped) { escaped = false; continue }
    if (ch === '\\' && inString) { escaped = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return candidate.slice(start, i + 1)
    }
  }

  throw new Error('LLM response did not include a complete JSON value.')
}

/** Parse a model response into ONE OR MORE actions (supports batched arrays). */
export function parseAgentActions(raw: string): AgentAction[] {
  let payload: unknown
  try {
    payload = JSON.parse(extractJSON(raw))
  } catch (error) {
    throw new Error(`Failed to parse LLM JSON response: ${error instanceof Error ? error.message : 'invalid json'}`)
  }

  const actions = normalizeActions(payload)
  if (actions.length === 0) {
    throw new Error('LLM response contained no valid action.')
  }
  return actions
}

/** Back-compat: parse a single action (the first one if the model returned a batch). */
export function parseAgentActionResponse(raw: string): AgentAction {
  return parseAgentActions(raw)[0]
}

interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/**
 * Convert an OpenAI tool call into an AgentAction.
 * Preserves reflection fields (evaluation_previous_goal, memory, next_goal)
 * from the tool call arguments.
 */
function toolCallToAction(toolCall: ToolCall): AgentAction {
  const name = toolCall.function.name
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(toolCall.function.arguments)
  } catch {
    // If arguments are malformed, treat as empty
  }

  // Extract reflection fields from args (they're optional in tool definitions)
  const evaluation_previous_goal = typeof args.evaluation_previous_goal === 'string' ? args.evaluation_previous_goal : undefined
  const memory = typeof args.memory === 'string' ? args.memory : undefined
  const next_goal = typeof args.next_goal === 'string' ? args.next_goal : undefined

  // Remove reflection fields from action args
  const actionArgs: Record<string, unknown> = { ...args }
  delete actionArgs.evaluation_previous_goal
  delete actionArgs.memory
  delete actionArgs.next_goal

  return {
    action: name as AgentAction['action'],
    evaluation_previous_goal,
    memory,
    next_goal,
    args: Object.keys(actionArgs).length > 0 ? actionArgs as AgentAction['args'] : undefined,
  }
}

const DIRECT_PROVIDER_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.mistral.ai',
  'api.cohere.ai',
  'api.cohere.com',
  'api.groq.com',
  'api.together.xyz',
]

function assertSafeBaseURL(baseURL: string, allowDirectProvider: boolean | undefined): void {
  let host: string
  try {
    host = new URL(baseURL).hostname.toLowerCase()
  } catch {
    throw new Error(`OpenAIClient: invalid baseURL "${baseURL}"`)
  }

  if (!allowDirectProvider && DIRECT_PROVIDER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new Error(
      `OpenAIClient: refusing to send the API key directly to "${host}" from the browser. ` +
        'Route requests through a backend proxy you control, or pass `allowDirectProvider: true` ' +
        'to acknowledge the risk (NOT recommended for production).',
    )
  }
}

export class OpenAIClient implements LLMClient {
  private readonly config: LLMConfig

  constructor(config: LLMConfig) {
    assertSafeBaseURL(config.baseURL, config.allowDirectProvider)
    this.config = config
  }

  async getNextActions(messages: ChatMessage[]): Promise<AgentAction[]> {
    const baseURL = this.config.baseURL.replace(/\/$/, '')
    const url = `${baseURL}/chat/completions`

    console.group(`%c[PageAgent] LLM call → ${url}`, 'color:#6366f1;font-weight:bold')
    console.log('model:', this.config.model)
    console.log('messages:', messages)
    console.groupEnd()

    // Build request body — use tool calling (replaces response_format / JSON mode)
    const body: Record<string, unknown> = {
      model: this.config.model,
      temperature: this.config.temperature,
      messages,
      tools: ACTION_TOOLS,
      tool_choice: 'required',
    }
    if (typeof this.config.maxTokens === 'number') {
      body.max_tokens = this.config.maxTokens
    }

    // Optional hard timeout so a stuck inference fails fast instead of hanging.
    const controller =
      typeof this.config.requestTimeoutMs === 'number' && this.config.requestTimeoutMs > 0
        ? new AbortController()
        : undefined
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), this.config.requestTimeoutMs)
      : undefined

    const t0 = performance.now()
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller?.signal,
      })
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId)
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`LLM request timed out after ${this.config.requestTimeoutMs}ms.`)
      }
      throw error
    }
    if (timeoutId) clearTimeout(timeoutId)

    const data = (await response.json()) as ChatCompletionsResponse
    const ms = Math.round(performance.now() - t0)

    if (!response.ok) {
      console.error(`%c[PageAgent] LLM error (${response.status}) in ${ms}ms`, 'color:red', data)
      throw new Error(
        readErrorMessage(data.error) ?? `LLM request failed with status ${response.status}`,
      )
    }

    const choice = data.choices?.[0]
    const toolCalls = choice?.message?.tool_calls
    const content = choice?.message?.content

    console.group(`%c[PageAgent] LLM response ✓ (${ms}ms)`, 'color:#22c55e;font-weight:bold')
    if (toolCalls) {
      console.log('tool_calls:', JSON.stringify(toolCalls, null, 2))
    } else {
      console.log('raw:', content)
    }
    console.groupEnd()

    // ── Preferred path: parse tool_calls ──────────────────────────────
    if (toolCalls && toolCalls.length > 0) {
      // Handle batching: multiple tool_calls in one response = batch actions
      return toolCalls
        .filter((tc) => tc.type === 'function')
        .map((tc) => toolCallToAction(tc))
    }

    // ── Fallback: parse JSON from content (for models without tool support) ──
    if (!content) {
      throw new Error('LLM did not return message content or tool calls.')
    }

    // Truncation guard
    if (choice?.finish_reason === 'length') {
      const modelName = this.config.model
      const tokenLimit = this.config.maxTokens ?? 'unlimited'
      throw new Error(
        `LLM response was truncated (finish_reason: length). ` +
        `Model: "${modelName}", current maxTokens: ${tokenLimit}. ` +
        `Increase maxTokens (VITE_AGENT_MAX_TOKENS) to resolve.`,
      )
    }

    const actions = parseAgentActions(content)
    console.log('%c[PageAgent] actions →', 'color:#f59e0b;font-weight:bold', actions)
    return actions
  }
}
