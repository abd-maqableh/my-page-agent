import { createLLMClient } from "../llm/createLLMClient";
import { PageController } from "../page-controller/PageController";
import { buildNavigationPrompt, buildInteractionPrompt } from "./prompt";
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

/** Match the current page URL against known pages. */
function findMatchingPage(
  currentUrl: string,
  pages: AgentConfig["pages"],
): { name: string; path: string } | null {
  if (!pages || !currentUrl) return null;
  try {
    const currentPath = new URL(currentUrl, window.location.origin).pathname;
    for (const [name, value] of Object.entries(pages)) {
      const candidate = typeof value === "string" ? value : value.path;
      // Exact match or current path starts with candidate (with path-segment
      // boundary so /dashboard doesn't match /dashboard/settings).
      if (
        currentPath === candidate ||
        (currentPath.startsWith(candidate) &&
          currentPath.charAt(candidate.length) === "/")
      ) {
        return { name, path: candidate };
      }
    }
    // Fallback: starts-with without boundary (less strict).
    for (const [name, value] of Object.entries(pages)) {
      const candidate = typeof value === "string" ? value : value.path;
      if (currentPath.startsWith(candidate)) {
        return { name, path: candidate };
      }
    }
  } catch {
    // currentUrl was not a valid URL — ignore.
  }
  return null;
}

/**
 * One request -> two LLM calls (when twoPhase is enabled):
 *   Phase 1 — navigation only (no DOM, pages config only)
 *   Phase 2 — interaction on the freshly-loaded target page DOM
 *
 * Falls back to single-call mode when twoPhase is not set.
 */
export class Agent {
  private readonly client: LLMClient;
  private readonly pageController: PageController;
  private readonly callbacks?: AgentConfig["callbacks"];
  private readonly confirmAction?: AgentConfig["confirmAction"];
  private readonly pages?: AgentConfig["pages"];
  private readonly twoPhase: boolean;

  constructor(config: AgentConfig) {
    this.client = config.llmClient ?? createLLMClient(config);
    this.pageController = new PageController(
      config.targetFrame,
      collectDeclaredSections(config.pages),
    );
    if (config.currentUrl) {
      this.pageController.setFallbackUrl(config.currentUrl);
    }
    this.callbacks = config.callbacks;
    this.confirmAction = config.confirmAction;
    this.pages = config.pages;
    this.twoPhase = config.twoPhase ?? false;
  }

  async execute(task: string): Promise<AgentRunResult> {
    if (!task.trim()) {
      throw new Error("Task is required.");
    }
    return this.twoPhase && this.pages && this.callbacks?.onPageReady
      ? this.executeTwoPhase(task)
      : this.executeSinglePhase(task);
  }

  // ─── Two-phase flow ────────────────────────────────────────────────────────

  private async executeTwoPhase(task: string): Promise<AgentRunResult> {
    const history: AgentHistoryEntry[] = [];

    // ── Phase 1: navigate ───────────────────────────────────────────────────
    const currentUrl = this.pageController.getEffectiveUrl();
    const matchedPage = findMatchingPage(currentUrl, this.pages);

    // Check whether the task explicitly asks for a different page.
    const taskLower = task.toLowerCase();
    const asksForOtherPage =
      this.pages &&
      Object.keys(this.pages).some((name) => {
        if (matchedPage && name === matchedPage.name) return false;
        return taskLower.includes(name.toLowerCase());
      });

    // Skip Phase 1 LLM navigation when already on the correct page and the
    // task doesn't explicitly request a different one.
    //
    // SAFETY: if the matched page declares sections but the task mentions none
    // of them, the task likely targets a DIFFERENT page (staying on a
    // section-only page when the task needs filters/actions elsewhere would
    // fail). Fall through to Phase 1 so the LLM can route correctly.
    let taskMentionsCurrentSection = false;
    if (matchedPage) {
      const pageEntry = this.pages![matchedPage.name];
      const sections =
        typeof pageEntry === "string" ? [] : (pageEntry.sections ?? []);
      taskMentionsCurrentSection = sections.some((s) =>
        taskLower.includes(s.toLowerCase()),
      );
    }

    const shouldSkipNavigation =
      matchedPage &&
      !asksForOtherPage &&
      // If page has sections and task mentions none, route through Phase 1
      (!matchedPage || taskMentionsCurrentSection);

    if (shouldSkipNavigation) {
      this.callbacks?.onStatus?.(
        `Already on "${matchedPage.name}" — skipping navigation`,
      );
      // Push a synthetic history entry so Phase 2 knows navigation was handled.
      this.pushHistory(
        history,
        0,
        "(already on correct page)",
        {
          action: "navigate",
          args: { url: matchedPage.path },
        },
        {
          success: true,
          message: `Already on "${matchedPage.name}" (${matchedPage.path}) — skipped navigation.`,
        },
      );
    } else {
      this.callbacks?.onStatus?.("Deciding target page");
      const navMessages = buildNavigationPrompt(task, this.pages!, currentUrl);

      let navActions: AgentAction[];
      try {
        navActions = await this.client.getNextActions(navMessages);
      } catch (error) {
        this.callbacks?.onStatus?.("Error");
        return {
          status: "error",
          history,
          message:
            error instanceof Error
              ? error.message
              : "Failed to get navigation action",
        };
      }

      if (navActions.length === 0) {
        this.callbacks?.onStatus?.("Error");
        return {
          status: "error",
          history,
          message: "Model returned no navigation action.",
        };
      }

      // Validate: first action must be navigate
      const navAction = navActions.find((a) => a.action === "navigate");
      if (!navAction) {
        this.callbacks?.onStatus?.("Error");
        return {
          status: "error",
          history,
          message: "Model did not return a navigate action in Phase 1.",
        };
      }

      if (this.confirmAction && !(await this.confirmAction(navAction))) {
        this.callbacks?.onStatus?.("Error");
        return {
          status: "error",
          history,
          message: "Navigation was rejected by confirmAction.",
        };
      }

      this.callbacks?.onStatus?.("Navigating to page");
      const navQueue = await this.pageController.executeActionQueue([
        navAction,
      ]);

      navQueue.items.forEach((item, index) => {
        this.pushHistory(
          history,
          index + 1,
          "(navigation phase — no DOM)",
          item.action,
          item.result,
        );
      });

      if (navQueue.error) {
        this.callbacks?.onStatus?.("Error");
        return { status: "error", history, message: navQueue.error };
      }

      // Update fallback URL after successful navigation.
      const navUrl = navAction.args?.url;
      if (navUrl) {
        try {
          const resolved = new URL(navUrl, window.location.origin);
          this.pageController.setFallbackUrl(
            `${resolved.pathname}${resolved.search}${resolved.hash}`,
          );
        } catch {
          if (navUrl.startsWith("/")) {
            this.pageController.setFallbackUrl(navUrl);
          }
        }
      }
    }

    // ── Wait for page to load ────────────────────────────────────────────────
    if (!shouldSkipNavigation) {
      // Page actually navigated — wait for the iframe to finish loading.
      this.callbacks?.onStatus?.("Waiting for page");
      await this.callbacks!.onPageReady!();
    }
    // Wait for lazy-loaded route components, React re-renders, and chart/layout
    // sizing to settle before scanning. readyState=complete fires before SPA
    // route chunks finish rendering, so without this wait the DOM only contains
    // the app shell and sections/interactive elements are not yet mounted.
    await this.pageController.waitForStability(300, 3000);

    // ── Phase 2: iterative interaction loop ──────────────────────────────────
    // Each iteration: re-scan DOM (fresh element indexes) → ask LLM for next
    // batch → execute → repeat until `done` or maxSteps. Re-scanning before
    // every LLM call ensures element references are never stale after a filter
    // selection or any other action that causes React to re-render the page.
    const maxSteps = 8;
    let iterStep = 0;

    while (iterStep < maxSteps) {
      this.callbacks?.onStatus?.("Scanning page");
      const observation = this.pageController.observe();

      this.callbacks?.onStatus?.("Asking model");
      const interactMessages = buildInteractionPrompt(
        task,
        observation,
        this.pages,
        history,
      );

      let interactActions: AgentAction[];
      try {
        interactActions = await this.client.getNextActions(interactMessages);
      } catch (error) {
        this.callbacks?.onStatus?.("Error");
        return {
          status: "error",
          history,
          message:
            error instanceof Error
              ? error.message
              : "Failed to get interaction action",
        };
      }

      if (interactActions.length === 0) {
        this.callbacks?.onStatus?.("Error");
        return {
          status: "error",
          history,
          message: "Model returned no interaction actions.",
        };
      }

      if (this.confirmAction) {
        for (const action of interactActions) {
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

      // ── Retry-loop guard: detect repeated failed action ──────────────
      const lastFailedEntry = [...history].reverse().find((h) => !h.result.success);
      if (lastFailedEntry) {
        for (const a of interactActions) {
          if (
            a.action !== "done" &&
            a.action === lastFailedEntry.action.action &&
            a.args?.index === lastFailedEntry.action.args?.index
          ) {
            this.callbacks?.onStatus?.("Error");
            return {
              status: "error",
              history,
              message: `Agent stuck: repeated the same failed action "${a.action}" on index ${a.args?.index}. Aborting.`,
            };
          }
        }
      }

      this.callbacks?.onStatus?.("Executing actions");
      // Strip navigate (Phase 2 must not reload the page) and stop the batch at
      // the first `done` so we never execute actions after the model signals completion.
      const safeActions = interactActions.filter(
        (a) => a.action !== "navigate",
      );
      const batchToRun: AgentAction[] = [];
      for (const a of safeActions) {
        batchToRun.push(a);
        if (a.action === "done") break;
      }

      const queue = await this.pageController.executeActionQueue(batchToRun);

      const stepOffset = history.length;
      queue.items.forEach((item, idx) => {
        this.pushHistory(
          history,
          stepOffset + idx + 1,
          observation.elementsText,
          item.action,
          item.result,
        );
      });

      if (queue.error) {
        this.callbacks?.onStatus?.("Error");
        return { status: "error", history, message: queue.error };
      }

      // ── Post-submit validation re-scan ───────────────────────────────
      // After any click/input/select, re-observe and check for visible
      // error indicators before letting the LLM decide it's done.
      const hadMutatingAction = batchToRun.some((a) =>
        ["click", "input", "select"].includes(a.action),
      );
      if (hadMutatingAction) {
        const postObs = this.pageController.observe();
        const hasErrors = postObs.elements.some(
          (el) =>
            el.label.toLowerCase().includes("error") ||
            el.description?.toLowerCase().includes("invalid") ||
            el.description?.toLowerCase().includes("required"),
        );
        if (hasErrors) {
          this.pushHistory(history, history.length + 1, postObs.elementsText, {
            action: "wait",
            args: { timeoutMs: 0 },
          } as AgentAction, {
            success: true,
            message:
              "Validation errors are visible on the page after the last action. Task is NOT complete yet.",
          });
          // Skip the done/auto-done checks below and go to next iteration.
          await this.pageController.waitForStability(300, 2000);
          iterStep += 1;
          continue;
        }
      }

      // ── Menu auto-click ──────────────────────────────────────────────
      // After a click that didn't trigger navigation, check if a context
      // menu opened (new MENU ITEM: elements appeared). If so, auto-click
      // the item that best matches the task without another LLM round-trip.
      const lastClick = [...queue.items]
        .reverse()
        .find((i) => i.action.action === "click" && i.result.success);
      if (lastClick) {
        const menuObs = this.pageController.observe();
        const menuItems = menuObs.elements.filter((el) =>
          el.label.startsWith("MENU ITEM:"),
        );
        if (menuItems.length > 0) {
          const taskLower = task.toLowerCase();
          const intentMatch = menuItems.find((item) => {
            const label = item.label.replace("MENU ITEM:", "").trim().toLowerCase();
            return (
              /\b(view|open|see|show|display|edit)\b/i.test(taskLower) &&
              (taskLower.includes(label) || label.includes(taskLower.split(" ").slice(-1)[0]))
            );
          });
          const target = intentMatch ?? menuItems[0];
          const menuAction: AgentAction = {
            action: "click",
            args: { index: target.index },
          };
          const menuResult = await this.pageController.executeActionQueue([
            menuAction,
          ]);
          menuResult.items.forEach((item, idx) => {
            this.pushHistory(
              history,
              history.length + 1 + idx,
              menuObs.elementsText,
              item.action,
              item.result,
            );
          });
        }
      }

      // If the batch included `done`, the task is finished.
      const doneItem = queue.items.find((i) => i.action.action === "done");
      if (doneItem) {
        this.callbacks?.onStatus?.("Done");
        return { status: "done", history, message: this.resolveMessage(queue) };
      }
      // Auto-done safety net: the LLM forgot to include `done` in its batch.
      // Two signals that the task is complete without another round-trip:
      //   1. URL changed → filters applied or navigation happened
      //   2. URL unchanged but this is the second+ iteration → LLM is looping
      const postUrl = this.pageController.getEffectiveUrl();
      const urlChanged = postUrl !== observation.url;
      const hadInteraction = batchToRun.some((a) => a.action !== "wait");

      // Derive the result message from the LLM's own words so it naturally
      // matches the user's language (Arabic, English, etc.).
      const llmMessage =
        // Last action's thought (LLM-authored, in-task language)
        batchToRun[batchToRun.length - 1]?.thought?.trim() ||
        // or the last successful action's result message
        [...queue.items].reverse().find((i) => i.result.success)?.result
          .message ||
        // final fallback
        "Done";

      if (urlChanged || (!urlChanged && hadInteraction && iterStep > 0)) {
        this.callbacks?.onStatus?.("Done");
        return { status: "done", history, message: llmMessage };
      }

      // Not done yet — wait for any async DOM updates triggered by the batch
      // (filter API calls, React re-renders) before the next scan+ask cycle.
      await this.pageController.waitForStability(300, 2000);
      iterStep += 1;
    }

    // Reached max iterations without a done — return what we have.
    this.callbacks?.onStatus?.("Done");
    return {
      status: "max_steps",
      history,
      message: "Reached maximum steps without completing the task.",
    };
  }

  // ─── Single-phase flow (original) ─────────────────────────────────────────

  private async executeSinglePhase(task: string): Promise<AgentRunResult> {
    const history: AgentHistoryEntry[] = [];

    this.callbacks?.onStatus?.("Observing page");
    const observation = this.pageController.observe();

    this.callbacks?.onStatus?.("Asking model");
    const messages = buildInteractionPrompt(task, observation, this.pages, []);

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

    this.callbacks?.onStatus?.("Done");
    return { status: "done", history, message: this.resolveMessage(queue) };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private resolveMessage(queue: ActionQueueResult): string {
    const doneItem = [...queue.items]
      .reverse()
      .find((i) => i.action.action === "done");
    const doneText = doneItem?.action.args?.result?.trim();
    if (doneText) return doneText;

    // Use last LLM-authored thought (in-task language) when no done text.
    const lastActionWithThought = [...queue.items]
      .reverse()
      .find((i) => i.action.thought?.trim());
    if (lastActionWithThought)
      return lastActionWithThought.action.thought!.trim();

    // Fall back to last successful action's result message.
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
