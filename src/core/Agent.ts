import { createLLMClient } from '../llm/createLLMClient'
import { PageController } from '../page-controller/PageController'
import { buildPrompt } from './prompt'
import type { AgentConfig, AgentHistoryEntry, AgentRunResult, LLMClient, PageDescriptor } from './types'

/** Recursively collect every declared section name from the pages config. */
function collectDeclaredSections(pages: AgentConfig['pages']): string[] {
  if (!pages) return []
  const names: string[] = []
  const walk = (map: Record<string, string | PageDescriptor>) => {
    for (const value of Object.values(map)) {
      if (typeof value === 'string') continue
      if (value.sections) names.push(...value.sections)
      if (value.subPages) walk(value.subPages)
    }
  }
  walk(pages)
  return names
}

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
    this.pageController = new PageController(config.targetFrame, collectDeclaredSections(config.pages))
    this.callbacks = config.callbacks
    this.confirmAction = config.confirmAction
    this.pages = config.pages
  }

  async execute(task: string): Promise<AgentRunResult> {
    if (!task.trim()) {
      throw new Error('Task is required.')
    }

    const history: AgentHistoryEntry[] = []
    let consecutiveFailures = 0

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

      const prevUrl = observation.url

      const result = await this.pageController.executeAction(action)

      // Give the page time to settle (e.g. React portals, async renders) before next observe()
      if (action.action === 'click' || action.action === 'input' || action.action === 'select') {
        await new Promise<void>((resolve) => setTimeout(resolve, 600))
      }

      // Detect URL changes caused by this action and annotate the result
      const nextObsForUrl = this.pageController.observe()
      const nextUrl = nextObsForUrl.url
      const navigated = action.action === 'click' && nextUrl !== prevUrl
      // Consider it a "detail page navigation" if the new URL contains a UUID (list → detail)
      const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
      const navigatedToDetail = navigated && UUID_RE.test(nextUrl) && !UUID_RE.test(prevUrl)
      const annotatedResult = navigated
        ? { ...result, message: `${result.message} → navigated to ${nextUrl}` }
        : result

      const entry: AgentHistoryEntry = {
        step,
        observation: observation.elementsText,
        action,
        result: annotatedResult,
      }
      history.push(entry)
      this.callbacks?.onStep?.(entry)

      if (!result.success) {
        // A single failed action is RECOVERABLE: feed it back to the model so it can
        // retry with a valid value, pick a different element, or call `done` to explain
        // why the task cannot proceed. Only abort after several consecutive failures to
        // avoid infinite loops.
        consecutiveFailures += 1
        if (consecutiveFailures >= 3) {
          // Prefer the most informative failure message (e.g. one that lists the
          // available filter options) over the last, possibly noisy, error.
          const informative = [...history]
            .reverse()
            .find((h) => !h.result.success && /Available options/i.test(h.result.message))
          return {
            status: 'error',
            history,
            message: informative?.result.message ?? result.message,
          }
        }
        continue
      }
      consecutiveFailures = 0

      // MENU AUTO-CLICK: if a click opened a context menu (MENU ITEMs visible, no navigation),
      // auto-click the matching item based on task intent instead of asking the model again.
      if (action.action === 'click' && !navigated) {

        // EXPORT AUTO-DONE: if the clicked element's label contains an export/download keyword,
        // treat a successful click as task completion — file downloads are async and produce no
        // visible DOM change that the agent could observe as "success".
        const EXPORT_RE = /\b(export|download|تصدير|تنزيل)\b/i
        const clickedLabel = observation.elements.find((el) => el.index === action.args?.index)?.label ?? ''
        if (result.success && EXPORT_RE.test(clickedLabel)) {
          this.callbacks?.onStatus?.('Done')
          return {
            status: 'done',
            history,
            message: `Triggered export: ${clickedLabel.replace(/^[A-Z ]+:\s*/, '')}`,
          }
        }

        const menuItems = nextObsForUrl.elements.filter((el) => el.label.startsWith('MENU ITEM:'))
        if (menuItems.length > 0) {
          const taskLower = task.toLowerCase()
          const isViewIntent = /\b(view|open|see|show|details?|look)\b/.test(taskLower)
          const isEditIntent = /\b(edit|update|modify|change)\b/.test(taskLower)
          const target =
            menuItems.find((el) => isViewIntent && el.label.toLowerCase().includes('view')) ??
            menuItems.find((el) => isEditIntent && el.label.toLowerCase().includes('edit')) ??
            menuItems[0]

          this.callbacks?.onStatus?.(`Step ${step}: auto-clicking ${target.label}`)
          const menuResult = await this.pageController.executeAction({ action: 'click', args: { index: target.index } })
          await new Promise<void>((resolve) => setTimeout(resolve, 800))

          const afterMenuUrl = this.pageController.observe().url
          const menuNavigated = afterMenuUrl !== nextUrl
          const menuNavigatedToDetail =
            menuNavigated && UUID_RE.test(afterMenuUrl) && !UUID_RE.test(nextUrl)

          const menuEntry: AgentHistoryEntry = {
            step: step + 0.5,
            observation: nextObsForUrl.elementsText,
            action: { action: 'click', args: { index: target.index }, thought: `Auto-clicked ${target.label}` },
            result: menuNavigated
              ? { ...menuResult, message: `${menuResult.message} → navigated to ${afterMenuUrl}` }
              : menuResult,
          }
          history.push(menuEntry)
          this.callbacks?.onStep?.(menuEntry)

          if (menuNavigatedToDetail) {
            this.callbacks?.onStatus?.('Done')
            return { status: 'done', history, message: `Navigated to ${afterMenuUrl}` }
          }
          // Continue the loop — the for-loop's own step += 1 will advance the counter
          continue
        }
      }

      // If a click caused navigation to a detail page (URL contains UUID), the item action is complete
      if (navigatedToDetail) {
        this.callbacks?.onStatus?.('Done')
        return {
          status: 'done',
          history,
          message: `Navigated to ${nextUrl}`,
        }
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
