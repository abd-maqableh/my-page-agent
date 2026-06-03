import type { AgentAction, ActionExecutionResult, PageObservation } from '../core/types'
import { runAction } from './actions'
import { scanInteractiveElements } from './domScanner'

export class PageController {
  private elementMap = new Map<number, Element>()
  private readonly targetFrame?: HTMLIFrameElement
  private readonly declaredSections: string[]

  constructor(targetFrame?: HTMLIFrameElement, declaredSections: string[] = []) {
    this.targetFrame = targetFrame
    this.declaredSections = declaredSections
  }

  private getDocWin(): { doc: Document; win: Window & typeof globalThis } {
    const win = (this.targetFrame?.contentWindow ?? window) as Window & typeof globalThis
    const doc = this.targetFrame?.contentDocument ?? document
    return { doc, win }
  }

  observe(): PageObservation {
    const { doc, win } = this.getDocWin()
    const scan = scanInteractiveElements(doc, win, this.declaredSections)
    this.elementMap = scan.elementMap

    return {
      url: win.location.href,
      title: doc.title,
      elements: scan.elements,
      elementsText: scan.text,
    }
  }

  async executeAction(action: AgentAction): Promise<ActionExecutionResult> {
    const { doc, win } = this.getDocWin()
    return runAction(action, this.elementMap, doc, win)
  }
}
