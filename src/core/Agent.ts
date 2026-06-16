import { createLLMClient } from "../llm/createLLMClient";
import { PageController } from "../page-controller/PageController";
import { buildPrompt } from "./prompt";
import { isOnPath, resolveIntent } from "./intentRouter";
import { looseMatch } from "./text";
import type {
  ActionExecutionResult,
  ActionQueueResult,
  AgentAction,
  AgentConfig,
  AgentHistoryEntry,
  AgentRunResult,
  LLMClient,
  PageDescriptor,
} from "./types";

function collectDeclaredSections(pages: AgentConfig["pages"]): string[] {
  if (!pages) return [];
  const names: string[] = [];
  const walk = (map: Record<string, string | PageDescriptor>) => {
    for (const value of Object.values(map)) {
      if (typeof value === "string") continue;
      if (value.sections) names.push(...value.sections);
      if (value.subPages) walk(value.subPages);
    }
  };
  walk(pages);
  return names;
}

/**
 * One request → (optional deterministic navigation) → ONE LLM call → run plan.
 *
 * The flow is deliberately flat and predictable:
 *   1. NAVIGATION is deterministic (no LLM): if the task names a known page/section
 *      (via `resolveIntent`), navigate there directly. A request that is ONLY
 *      navigation finishes here with ZERO model calls.
 *   2. ACTION PHASE is exactly ONE model call: observe the page (domScanner),
 *      build one clear prompt, ask the model once, then execute the returned
 *      action plan in order as a queue.
 *
 * There is NO re-ask loop. Whatever the model returns is what runs — this is what
 * eliminates the "apply filter → remove filter → apply …" oscillation that a
 * multi-call loop produced.
 */
export class Agent {
  private readonly client: LLMClient;
  private readonly pageController: PageController;
  private readonly callbacks?: AgentConfig["callbacks"];
  private readonly confirmAction?: AgentConfig["confirmAction"];
  private readonly pages?: AgentConfig["pages"];

  constructor(config: AgentConfig) {
    this.client = config.llmClient ?? createLLMClient(config);
    this.pageController = new PageController(
      config.targetFrame,
      collectDeclaredSections(config.pages),
    );
    this.callbacks = config.callbacks;
    this.confirmAction = config.confirmAction;
    this.pages = config.pages;
  }

  async execute(task: string): Promise<AgentRunResult> {
    if (!task.trim()) {
      throw new Error("Task is required.");
    }

    const history: AgentHistoryEntry[] = [];

    // ── 1. Deterministic navigation prefix (no LLM) ──────────────────
    const navOutcome = await this.runNavigationPrefix(task, history);
    if (navOutcome.terminal) return navOutcome.terminal;

    // ── 2. Action phase: exactly ONE model call ──────────────────────
    this.callbacks?.onStatus?.("Observing page");
    const observation = this.pageController.observe();

    this.callbacks?.onStatus?.("Asking model");
    const messages = buildPrompt(task, observation, history, this.pages);

    let actions: AgentAction[];
    try {
      actions = await this.client.getNextActions(messages);
    } catch (error) {
      this.callbacks?.onStatus?.("Error");
      return {
        status: "error",
        history,
        message:
          error instanceof Error ? error.message : "Failed to get model action",
      };
    }

    if (actions.length === 0) {
      this.callbacks?.onStatus?.("Error");
      return {
        status: "error",
        history,
        message: "Model returned no actions.",
      };
    }

    if (this.confirmAction) {
      for (const action of actions) {
        if (!(await this.confirmAction(action))) {
          this.callbacks?.onStatus?.("Error");
          return {
            status: "error",
            history,
            message: `Action "${action.action}" was rejected by confirmAction.`,
          };
        }
      }
    }

    // ── 3. Execute the model's plan in order ─────────────────────────
    this.callbacks?.onStatus?.("Executing actions");
    const queue = await this.pageController.executeActionQueue(actions);

    queue.items.forEach((item, index) => {
      this.pushHistory(
        history,
        index + 1,
        observation.elementsText,
        item.action,
        item.result,
      );
    });

    if (queue.error) {
      this.callbacks?.onStatus?.("Error");
      return { status: "error", history, message: queue.error };
    }

    // ── 4. MENU AUTO-CLICK: a click that opened a per-item menu reveals
    //       "MENU ITEM:" elements that did not exist at plan time. Click the
    //       matching item now (based on task intent) — no extra model call. ──
    const menuMessage = await this.maybeAutoClickMenu(task, history);

    this.callbacks?.onStatus?.("Done");
    return {
      status: "done",
      history,
      message: menuMessage ?? this.resolveMessage(queue),
    };
  }

  /**
   * Resolve known-page / declared-section navigation WITHOUT the LLM. Returns a
   * terminal result when the request was purely navigation (or navigation
   * failed); otherwise returns `{}` so the caller proceeds to the action phase.
   */
  private async runNavigationPrefix(
    task: string,
    history: AgentHistoryEntry[],
  ): Promise<{ terminal?: AgentRunResult }> {
    const routed = resolveIntent(task, this.pages);
    if (!routed) return {};

    let navigated = false;
    if (!isOnPath(this.pageController.getUrl(), routed.path)) {
      this.callbacks?.onStatus?.(`Navigating to ${routed.label}`);
      const action: AgentAction = {
        action: "navigate",
        args: { url: routed.path },
        thought: `Known page "${routed.label}"`,
      };
      if (this.confirmAction && !(await this.confirmAction(action))) {
        return {
          terminal: {
            status: "error",
            history,
            message: 'Action "navigate" was rejected by confirmAction.',
          },
        };
      }
      const result = await this.pageController.executeAction(action);
      this.pushHistory(history, 0, "", action, result);
      await this.pageController.waitForStability();

      // Fail loudly instead of silently "succeeding" on a navigation that did
      // not actually land on the requested page.
      if (!result.success || !isOnPath(this.pageController.getUrl(), routed.path)) {
        this.callbacks?.onStatus?.("Error");
        return {
          terminal: {
            status: "error",
            history,
            message: `Could not navigate to ${routed.label} (${routed.path}).`,
          },
        };
      }
      navigated = true;
    }

    // Declared section → scroll it into view deterministically.
    let sectionFocused = false;
    if (routed.section) {
      const observation = this.pageController.observe();
      const target = observation.elements.find(
        (el) =>
          el.label.startsWith("SECTION:") &&
          looseMatch(el.label.slice("SECTION:".length), routed.section as string),
      );
      if (target) {
        this.callbacks?.onStatus?.(`Focusing section ${routed.section}`);
        const action: AgentAction = {
          action: "scroll",
          args: { index: target.index },
          thought: `Declared section "${routed.section}"`,
        };
        const result = await this.pageController.executeAction(action);
        this.pushHistory(history, 0.5, observation.elementsText, action, result);
        sectionFocused = result.success;
      }
    }

    // Pure navigation (and section focus, if asked) is complete — return now and
    // never call the model. A task with leftover words falls through.
    if (routed.complete && (!routed.section || sectionFocused)) {
      this.callbacks?.onStatus?.("Done");
      const suffix = routed.section ? ` — focused "${routed.section}"` : "";
      return {
        terminal: {
          status: "done",
          history,
          message:
            navigated || routed.section
              ? `Navigated to ${routed.path}${suffix}`
              : `Already on ${routed.label} (${routed.path})`,
        },
      };
    }

    return {};
  }

  /**
   * After the plan runs, a click may have opened a per-item context menu whose
   * "MENU ITEM:" options were not visible when the model planned. Click the
   * option that matches the task intent (view / edit / first) so a request like
   * "view the Dubai trip" completes from a single model call.
   * Returns the chat message when it acted, else null.
   */
  private async maybeAutoClickMenu(
    task: string,
    history: AgentHistoryEntry[],
  ): Promise<string | null> {
    const observation = this.pageController.observe();
    const menuItems = observation.elements.filter((el) =>
      el.label.startsWith("MENU ITEM:"),
    );
    if (menuItems.length === 0) return null;

    const taskLower = task.toLowerCase();
    const isViewIntent = /\b(view|open|see|show|details?|look)\b/.test(taskLower);
    const isEditIntent = /\b(edit|update|modify|change)\b/.test(taskLower);
    const target =
      menuItems.find(
        (el) => isViewIntent && el.label.toLowerCase().includes("view"),
      ) ??
      menuItems.find(
        (el) => isEditIntent && el.label.toLowerCase().includes("edit"),
      ) ??
      menuItems[0];

    const action: AgentAction = {
      action: "click",
      args: { index: target.index },
      thought: `Auto-clicked ${target.label}`,
    };
    if (this.confirmAction && !(await this.confirmAction(action))) return null;

    const result = await this.pageController.executeAction(action);
    await this.pageController.waitForStability();
    this.pushHistory(
      history,
      history.length + 1,
      observation.elementsText,
      action,
      result,
    );
    if (!result.success) return null;

    return `Opened ${target.label.replace(/^MENU ITEM:\s*/, "")}`;
  }

  /**
   * The chat-facing message, resolved in priority order:
   *   1. an explicit `done` action's `result`,
   *   2. the last successful (non-done) action's message,
   *   3. a generic "Done" so the UI never blanks.
   */
  private resolveMessage(queue: ActionQueueResult): string {
    const doneItem = [...queue.items]
      .reverse()
      .find((i) => i.action.action === "done");
    const doneText = doneItem?.action.args?.result?.trim();
    if (doneText) return doneText;

    const lastSuccess = [...queue.items]
      .reverse()
      .find((i) => i.result.success && i.action.action !== "done");
    if (lastSuccess) return lastSuccess.result.message;

    return "Done";
  }

  private pushHistory(
    history: AgentHistoryEntry[],
    step: number,
    observation: string,
    action: AgentAction,
    result: ActionExecutionResult,
  ): void {
    const entry: AgentHistoryEntry = { step, observation, action, result };
    history.push(entry);
    this.callbacks?.onStep?.(entry);
  }
}
