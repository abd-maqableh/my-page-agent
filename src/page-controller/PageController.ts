import type { AgentAction, ActionExecutionResult, PageObservation } from '../core/types'
import { runAction } from './actions'
import { scanInteractiveElements } from './domScanner'

export class PageController {
  private elementMap = new Map<number, Element>()

  observe(): PageObservation {
    const scan = scanInteractiveElements(document)
    this.elementMap = scan.elementMap

    return {
      url: window.location.href,
      title: document.title,
      elements: scan.elements,
      elementsText: scan.text,
    }
  }

  async executeAction(action: AgentAction): Promise<ActionExecutionResult> {
    return runAction(action, this.elementMap)
  }
}
