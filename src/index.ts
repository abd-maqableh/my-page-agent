import { Agent } from './core/Agent'
import type { AgentConfig, AgentRunResult } from './core/types'
import { Panel } from './ui/Panel'

export class MyPageAgent {
  private readonly config: AgentConfig
  private readonly statusListeners = new Set<(status: string) => void>()
  private readonly stepListeners = new Set<(line: string) => void>()
  private readonly agent: Agent

  constructor(config: AgentConfig) {
    this.config = config
    this.agent = new Agent({
      ...config,
      callbacks: {
        onStatus: (status) => {
          this.statusListeners.forEach((listener) => listener(status))
          this.config.callbacks?.onStatus?.(status)
        },
        onStep: (entry) => {
          const line = `Step ${entry.step}: ${entry.action.action} → ${entry.result.message}`
          this.stepListeners.forEach((listener) => listener(line))
          this.config.callbacks?.onStep?.(entry)
        },
      },
    })
  }

  async execute(task: string): Promise<AgentRunResult> {
    return this.agent.execute(task)
  }

  onStatus(handler: (status: string) => void): void {
    this.statusListeners.add(handler)
  }

  onStep(handler: (line: string) => void): void {
    this.stepListeners.add(handler)
  }
}

export function mountAgentPanel(config: AgentConfig, parent?: ParentNode): MyPageAgent {
  const agent = new MyPageAgent(config)
  const panel = new Panel({
    execute: (task) => agent.execute(task),
    onStatus: (handler) => agent.onStatus(handler),
    onStep: (handler) => agent.onStep(handler),
  })

  panel.mount(parent)
  return agent
}

export type { AgentConfig, AgentRunResult, AgentHistoryEntry, LLMConfig, OllamaConfig, OpenAIConfig } from './core/types'
