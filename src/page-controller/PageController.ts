import type {
  AgentAction,
  ActionExecutionResult,
  PageObservation,
} from "../core/types";
import { runAction } from "./actions";
import { scanInteractiveElements } from "./domScanner";

export class PageController {
  private elementMap = new Map<number, Element>();
  private readonly targetFrame?: HTMLIFrameElement;
  private readonly declaredSections: string[];

  constructor(
    targetFrame?: HTMLIFrameElement,
    declaredSections: string[] = [],
  ) {
    this.targetFrame = targetFrame;
    this.declaredSections = declaredSections;
  }

  private getDocWin(): { doc: Document; win: Window & typeof globalThis } {
    const win = (this.targetFrame?.contentWindow ?? window) as Window &
      typeof globalThis;
    const doc = this.targetFrame?.contentDocument ?? document;
    return { doc, win };
  }

  observe(): PageObservation {
    const { doc, win } = this.getDocWin();
    const scan = scanInteractiveElements(doc, win, this.declaredSections);
    this.elementMap = scan.elementMap;
    console.log("PageController.observe scan result", scan);
    return {
      url: win.location.href,
      title: doc.title,
      elements: scan.elements,
      elementsText: scan.text,
    };
  }

  /** Cheap URL read without re-scanning the DOM. */
  getUrl(): string {
    return this.getDocWin().win.location.href;
  }

  /**
   * Wait until the DOM is quiet: resolves as soon as no mutations occur for
   * `idleMs`, capped at `maxMs`. Much faster than a fixed sleep on quick pages
   * and more reliable on slow ones (async renders, React portals).
   */
  waitForStability(idleMs = 180, maxMs = 1500): Promise<void> {
    const { doc, win } = this.getDocWin();
    return new Promise((resolve) => {
      let idleTimer: number;
      const finish = () => {
        observer.disconnect();
        win.clearTimeout(idleTimer);
        win.clearTimeout(maxTimer);
        resolve();
      };
      const observer = new win.MutationObserver(() => {
        win.clearTimeout(idleTimer);
        idleTimer = win.setTimeout(finish, idleMs);
      });
      const maxTimer = win.setTimeout(finish, maxMs);
      idleTimer = win.setTimeout(finish, idleMs);
      try {
        observer.observe(doc.body ?? doc.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
      } catch {
        finish();
      }
    });
  }

  async executeAction(action: AgentAction): Promise<ActionExecutionResult> {
    const { doc, win } = this.getDocWin();
    return runAction(action, this.elementMap, doc, win);
  }
}
