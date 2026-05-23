import { createLLMClient } from '../llm/createLLMClient'
import { PageController } from '../page-controller/PageController'
import { buildPrompt } from './prompt'
import type { AgentConfig, AgentHistoryEntry, AgentRunResult, LLMClient } from './types'

export class Agent {
  private readonly maxSteps: number
  private readonly client: LLMClient
  private readonly pageController: PageController
  private readonly callbacks?: AgentConfig['callbacks']
  private readonly confirmAction?: AgentConfig['confirmAction']
  private readonly pages?: AgentConfig['pages']

  constructor(config: AgentConfig) {
    this.maxSteps = config.maxSteps ?? 10
    this.client = createLLMClient(config)
    this.pageController = new PageController(config.targetFrame)
    this.callbacks = config.callbacks
    this.confirmAction = config.confirmAction
    this.pages = config.pages
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
      const messages = buildPrompt(task, observation, history, this.pages)

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

      if (this.confirmAction) {
        const allowed = await this.confirmAction(action)
        if (!allowed) {
          return {
            status: 'error',
            history,
            message: `Action "${action.action}" was rejected by confirmAction.`,
          }
        }
      }

      const result = await this.pageController.executeAction(action)

      // Give the page time to settle (e.g. React portals, async renders) before next observe()
      if (action.action === 'click' || action.action === 'input') {
        await new Promise<void>((resolve) => setTimeout(resolve, 400))
      }
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
