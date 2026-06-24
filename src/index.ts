import { Agent } from './core/Agent'
import type { AgentConfig, AgentRunResult, ChatMessage } from './core/types'
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
        // Forward onPageReady directly so the two-phase flow can signal the host.
        onPageReady: config.callbacks?.onPageReady,
      },
    })
  }

  async execute(task: string): Promise<AgentRunResult> {
    return this.agent.execute(task)
  }

  /**
   * Set the full conversation history so the agent can reference
   * previous user↔assistant exchanges when processing a new task.
   * Call this before each `execute()` to enable cross-turn memory.
   */
  setConversationHistory(history: ChatMessage[]): void {
    this.agent.conversationHistory = history
  }

  /**
   * Enable or disable QA mode. When enabled, the agent can answer
   * freeform questions about page content (e.g. "what does this chart show?")
   * instead of strictly performing page actions.
   */
  setEnableQAMode(enabled: boolean): void {
    this.agent.enableQAMode = enabled
  }

  /**
   * When true, the next `execute()` call skips Phase 1 navigation and
   * interacts directly with the current iframe DOM. Use for follow-up
   * requests where reloading the iframe would lose filter/scroll state.
   */
  setForceSinglePhase(enabled: boolean): void {
    this.agent.forceSinglePhase = enabled
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

export type { AgentConfig, AgentRunResult, AgentHistoryEntry, LLMConfig, PageDescriptor, ChatMessage } from './core/types'
