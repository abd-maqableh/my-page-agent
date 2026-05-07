import { normalizeAction } from '../core/tools'
import type { AgentAction, ChatMessage, LLMClient, OpenAIConfig } from '../core/types'

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
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed
  }

  const block = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (block?.[1]) {
    return block[1]
  }

  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first !== -1 && last > first) {
    return trimmed.slice(first, last + 1)
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

export class OpenAIClient implements LLMClient {
  private readonly config: OpenAIConfig

  constructor(config: OpenAIConfig) {
    this.config = config
  }

  async getNextAction(messages: ChatMessage[]): Promise<AgentAction> {
    const baseURL = this.config.baseURL.replace(/\/$/, '')
    const response = await fetch(`${baseURL}/chat/completions`, {
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

    if (!response.ok) {
      throw new Error(data.error?.message ?? `LLM request failed with status ${response.status}`)
    }

    const content = data.choices?.[0]?.message?.content
    if (!content) {
      throw new Error('LLM did not return message content.')
    }

    return parseAgentActionResponse(content)
  }
}
