import { Ollama } from 'ollama/browser'
import { parseAgentActionResponse } from './OpenAIClient'
import type { AgentAction, ChatMessage, LLMClient, OllamaConfig } from '../core/types'

export class OllamaClient implements LLMClient {
  private readonly client: Ollama
  private readonly config: OllamaConfig

  constructor(config: OllamaConfig) {
    this.config = config
    this.client = new Ollama({ host: config.baseURL })
  }

  async getNextAction(messages: ChatMessage[]): Promise<AgentAction> {
    const response = await this.client.chat({
      model: this.config.model,
      messages,
      format: 'json',
      options: {
        temperature: this.config.temperature,
      },
      stream: false,
    })

    const content = response.message?.content
    if (!content) {
      throw new Error('LLM did not return message content.')
    }

    return parseAgentActionResponse(content)
  }
}
