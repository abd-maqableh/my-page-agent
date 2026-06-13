import { normalizeAction } from '../core/tools'
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

  // Use balanced-bracket extraction to isolate the FIRST complete JSON object.
  // This handles cases where the LLM appends extra text or a second JSON object
  // after the response (which would cause JSON.parse to fail at position N).
  const start = candidate.indexOf('{')
  if (start !== -1) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i]
      if (escaped) { escaped = false; continue }
      if (ch === '\\' && inString) { escaped = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return candidate.slice(start, i + 1)
      }
    }
  }

  throw new Error('LLM response did not include a JSON object.')
}

export function parseAgentActionResponse(raw: string): AgentAction {
  let payload: unknown
  try {
    payload = JSON.parse(extractJSON(raw))
  } catch (error) {
    throw new Error(`Failed to parse LLM JSON response: ${error instanceof Error ? error.message : 'invalid json'}`)
  }

  return normalizeAction(payload)
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

  async getNextAction(messages: ChatMessage[]): Promise<AgentAction> {
    const baseURL = this.config.baseURL.replace(/\/$/, '')
    const url = `${baseURL}/chat/completions`

    console.group(`%c[PageAgent] LLM call → ${url}`, 'color:#6366f1;font-weight:bold')
    console.log('model:', this.config.model)
    console.log('messages:', messages)
    console.groupEnd()

    const t0 = performance.now()
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: this.config.temperature,
        messages,
      }),
    })

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

    const action = parseAgentActionResponse(content)
    console.log('%c[PageAgent] action →', 'color:#f59e0b;font-weight:bold', action)
    return action
  }
}
