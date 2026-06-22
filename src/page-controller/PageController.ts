import type {
  AgentAction,
  ActionExecutionResult,
  ActionQueueResult,
  PageObservation,
} from "../core/types";
import { runAction, runActionQueue } from "./actions";
import { scanInteractiveElements } from "./domScanner";

export class PageController {
  private elementMap = new Map<number, Element>();
  private readonly targetFrame?: HTMLIFrameElement;
  private readonly declaredSections: string[];
  private fallbackUrl = "";

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

  /** Safely read the current URL, returning "" on cross-origin errors. */
  private readUrl(): string {
    try {
      return this.getDocWin().win.location.href;
    } catch {
      // Cross-origin iframe — location is inaccessible.
      return "";
    }
  }

  observe(): PageObservation {
    const { doc, win } = this.getDocWin();
    const scan = scanInteractiveElements(doc, win, this.declaredSections);
    this.elementMap = scan.elementMap;
    const url = this.readUrl();
    // Keep fallbackUrl in sync with the real URL when readable.
    if (url) this.fallbackUrl = url;
    return {
      url: url || this.fallbackUrl,
      title: doc.title,
      elements: scan.elements,
      elementsText: scan.text,
    };
  }

  /** Cheap URL read without re-scanning the DOM. Cross-origin safe. */
  getUrl(): string {
    return this.readUrl() || this.fallbackUrl;
  }

  /**
   * Always returns a URL string: the real iframe URL when readable,
   * otherwise the fallback provided by the host via setFallbackUrl().
   */
  getEffectiveUrl(): string {
    return this.readUrl() || this.fallbackUrl;
  }

  /** Store a fallback URL for when the iframe is cross-origin. */
  setFallbackUrl(url: string): void {
    this.fallbackUrl = url;
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

  async executeActionQueue(actions: AgentAction[]): Promise<ActionQueueResult> {
    const { doc, win } = this.getDocWin();
    const queue = await runActionQueue(actions, this.elementMap, doc, win);

    for (const item of queue.items) {
      if (
        item.result.success &&
        (item.action.action === "click" ||
          item.action.action === "input" ||
          item.action.action === "select")
      ) {
        await this.waitForStability();
      }
    }

    return queue;
  }
}
