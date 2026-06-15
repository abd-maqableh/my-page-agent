import { normalizeActions } from '../core/tools'
import type { AgentAction, ChatMessage, LLMClient, LLMConfig } from '../core/types'

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: {
      content?: string | null
    }
  }>
  error?: {
    message?: string
  }
}

function extractJSON(text: string): string {
  const trimmed = text.trim()

  // Extract content from markdown code fences first
  const block = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidate = block?.[1]?.trim() ?? trimmed

  // Find the FIRST JSON value — either an object `{...}` or an array `[...]` — and
  // return it via balanced-bracket extraction. Supporting arrays lets the model
  // emit a batch of actions (e.g. `[{select},{select},{done}]`) in one response.
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

    // Request body. Sending `max_tokens` and (optionally) a JSON response_format
    // are the two biggest knobs for cutting generation time on slow servers.
    const body: Record<string, unknown> = {
      model: this.config.model,
      temperature: this.config.temperature,
      messages,
    }
    if (typeof this.config.maxTokens === 'number') {
      body.max_tokens = this.config.maxTokens
    }
    if (this.config.jsonMode) {
      body.response_format = { type: 'json_object' }
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
      throw new Error(data.error?.message ?? `LLM request failed with status ${response.status}`)
    }

    const content = data.choices?.[0]?.message?.content
    console.group(`%c[PageAgent] LLM response ✓ (${ms}ms)`, 'color:#22c55e;font-weight:bold')
    console.log('raw:', content)
    console.groupEnd()

    if (!content) {
      throw new Error('LLM did not return message content.')
    }

    const actions = parseAgentActions(content)
    console.log('%c[PageAgent] actions →', 'color:#f59e0b;font-weight:bold', actions)
    return actions
  }
}
