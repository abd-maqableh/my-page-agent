import { OllamaClient } from './OllamaClient'
import { OpenAIClient } from './OpenAIClient'
import type { LLMClient, LLMConfig } from '../core/types'

export function createLLMClient(config: LLMConfig): LLMClient {
  if (config.provider === 'ollama') {
    return new OllamaClient(config)
  }

  return new OpenAIClient(config)
}
