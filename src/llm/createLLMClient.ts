import { OpenAIClient } from './OpenAIClient'
import type { LLMClient, LLMConfig } from '../core/types'

export function createLLMClient(config: LLMConfig): LLMClient {
  return new OpenAIClient(config)
}
