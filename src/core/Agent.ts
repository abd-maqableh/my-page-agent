import { OpenAIClient } from '../llm/OpenAIClient'
import { PageController } from '../page-controller/PageController'
import { buildPrompt } from './prompt'
import type { AgentConfig, AgentHistoryEntry, AgentRunResult } from './types'

export class Agent {
  private readonly maxSteps: number
  private readonly client: OpenAIClient
  private readonly pageController: PageController
  private readonly callbacks?: AgentConfig['callbacks']

  constructor(config: AgentConfig) {
    this.maxSteps = config.maxSteps ?? 10
    this.client = new OpenAIClient(config)
    this.pageController = new PageController()
    this.callbacks = config.callbacks
  }

  async execute(task: string): Promise<AgentRunResult> {
    if (!task.trim()) {
      throw new Error('Task is required.')
    }

    const history: AgentHistoryEntry[] = []

    for (let step = 1; step <= this.maxSteps; step += 1) {
      this.callbacks?.onStatus?.(`Step ${step}: observing page`)
      const observation = this.pageController.observe()

      this.callbacks?.onStatus?.(`Step ${step}: asking model`)
      const messages = buildPrompt(task, observation, history)

      let action
      try {
        action = await this.client.getNextAction(messages)
      } catch (error) {
        return {
          status: 'error',
          history,
          message: error instanceof Error ? error.message : 'Failed to get model action',
        }
      }

      this.callbacks?.onStatus?.(`Step ${step}: executing ${action.action}`)
      const result = await this.pageController.executeAction(action)

      const entry: AgentHistoryEntry = {
        step,
        observation: observation.elementsText,
        action,
        result,
      }
      history.push(entry)
      this.callbacks?.onStep?.(entry)

      if (!result.success) {
        return { status: 'error', history, message: result.message }
      }

      if (action.action === 'done' || result.done) {
        this.callbacks?.onStatus?.('Done')
        return {
          status: 'done',
          history,
          message: result.message,
        }
      }
    }

    return {
      status: 'max_steps',
      history,
      message: `Stopped after ${this.maxSteps} steps.`,
    }
  }
}
