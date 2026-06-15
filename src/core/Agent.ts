import { createLLMClient } from '../llm/createLLMClient'
import { PageController } from '../page-controller/PageController'
import { buildPrompt } from './prompt'
import { isOnPath, resolveIntent } from './intentRouter'
import { looseMatch, meaningfulWords, normalizeText } from './text'
import type { AgentAction, AgentActionName, AgentConfig, AgentHistoryEntry, AgentRunResult, LLMClient, PageDescriptor, PageObservation } from './types'

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const EXPORT_RE = /\b(export|download|تصدير|تنزيل)\b/i

/**
 * Actions that NEVER renumber the element indexes, so several of them may run
 * back-to-back from a single batched model response. Anything else (`click`,
 * `navigate`) ends the batch so we re-observe with fresh indexes.
 */
const BATCH_SAFE_ACTIONS = new Set<AgentActionName>([
  'select', 'input', 'clear', 'hover', 'scroll', 'press_key', 'wait',
])

/** Max number of "you finished early — apply the missing filter?" re-asks per task. */
const MAX_DONE_VERIFY = 2

/** Result of running one action inside a batch. */
type StepOutcome =
  | { type: 'return'; result: AgentRunResult }
  | { type: 'break' }
  | { type: 'continue' }

/** A FILTER DROPDOWN parsed from an observation label (no DOM opening required). */
interface ObservedFilter {
  index: number
  field: string
  current: string
}

/** True when a dropdown's current value means "nothing selected yet". */
function isNeutralFilterValue(value: string): boolean {
  const v = normalizeText(value)
  return (
    !v ||
    /^(all|all status|all statuses|all type|all types|select option|none|any|\u200b|الكل|الكله|اختر)$/.test(v)
  )
}

/**
 * Read every FILTER DROPDOWN from an observation using ONLY its label text — the
 * scanner already exposes "FILTER DROPDOWN: <field> (current: <value>)". This lets
 * us reason about which filters are still unset WITHOUT opening any dropdown
 * (opening MUI portals and failing to close them is the bug we will never re-add).
 */
function observedFilters(observation: PageObservation): ObservedFilter[] {
  const out: ObservedFilter[] = []
  for (const el of observation.elements) {
    if (!el.label.startsWith('FILTER DROPDOWN:')) continue
    const body = el.label.slice('FILTER DROPDOWN:'.length).trim()
    const currentMatch = body.match(/\(current:\s*([^)]*?)\)/i)
    let field = ''
    let current = ''
    if (currentMatch) {
      current = currentMatch[1].trim()
      field = body.slice(0, currentMatch.index).trim()
    } else {
      // No "(current: ...)" → the head value IS the current value, no separate field.
      current = body.split(' [options:')[0].split(' (')[0].trim()
      field = ''
    }
    out.push({ index: el.index, field, current })
  }
  return out
}

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
  private readonly singleLLMCall: boolean

  constructor(config: AgentConfig) {
    this.maxSteps = config.maxSteps ?? 10
    this.client = config.llmClient ?? createLLMClient(config)
    this.pageController = new PageController(config.targetFrame, collectDeclaredSections(config.pages))
    this.callbacks = config.callbacks
    this.confirmAction = config.confirmAction
    this.pages = config.pages
    this.singleLLMCall = config.singleLLMCall ?? false
  }

  async execute(task: string): Promise<AgentRunResult> {
    if (!task.trim()) {
      throw new Error('Task is required.')
    }

    const history: AgentHistoryEntry[] = []

    // ── Deterministic prefix ────────────────────────────────────────
    // Resolve "show/open <known page or declared section>" requests without
    // the LLM: navigate (and scroll to the section) directly. When qualifier
    // words remain (e.g. "sent applications"), only the navigation happens
    // here and the LLM loop finishes the rest — faster and far more reliable.
    const prefixResult = await this.runDeterministicPrefix(task, history)
    if (prefixResult) return prefixResult

    return this.runLLMLoop(task, history)
  }

  private async runDeterministicPrefix(
    task: string,
    history: AgentHistoryEntry[],
  ): Promise<AgentRunResult | null> {
    const routed = resolveIntent(task, this.pages)
    if (!routed) return null

    const currentUrl = this.pageController.getUrl()
    const needsNavigation = !isOnPath(currentUrl, routed.path)

    if (needsNavigation) {
      this.callbacks?.onStatus?.(`Navigating to ${routed.label}`)
      const action = { action: 'navigate' as const, args: { url: routed.path }, thought: `Known page "${routed.label}"` }
      if (this.confirmAction && !(await this.confirmAction(action))) {
        return { status: 'error', history, message: 'Action "navigate" was rejected by confirmAction.' }
      }
      const result = await this.pageController.executeAction(action)
      const entry: AgentHistoryEntry = { step: 0, observation: '', action, result }
      history.push(entry)
      this.callbacks?.onStep?.(entry)
      if (!result.success) return null // fall back to the LLM loop
      await this.pageController.waitForStability()
    }

    let sectionFocused = false
    if (routed.section) {
      const observation = this.pageController.observe()
      const target = observation.elements.find(
        (el) => el.label.startsWith('SECTION:') && looseMatch(el.label.slice('SECTION:'.length), routed.section as string),
      )
      if (target) {
        this.callbacks?.onStatus?.(`Focusing section ${routed.section}`)
        const action = { action: 'scroll' as const, args: { index: target.index }, thought: `Declared section "${routed.section}"` }
        const result = await this.pageController.executeAction(action)
        const entry: AgentHistoryEntry = { step: 0.5, observation: observation.elementsText, action, result }
        history.push(entry)
        this.callbacks?.onStep?.(entry)
        sectionFocused = result.success
      }
    }

    if (routed.complete && (!routed.section || sectionFocused)) {
      this.callbacks?.onStatus?.('Done')
      const suffix = routed.section ? ` — focused "${routed.section}"` : ''
      return {
        status: 'done',
        history,
        message: needsNavigation || routed.section
          ? `Navigated to ${routed.path}${suffix}`
          : `Already on ${routed.label} (${routed.path})`,
      }
    }

    // Qualifier words remain (or the section wasn't found) — let the LLM finish.
    return null
  }

  private async runLLMLoop(task: string, history: AgentHistoryEntry[]): Promise<AgentRunResult> {
    const failureRef = { count: 0 }
    const verifyRef = { count: 0 }
    const MAX_BATCH = 6

    if (this.singleLLMCall) {
      // ── PRE-PASS: deterministic filter completion (no model call) ──
      // Apply any FILTER DROPDOWN values the task literally names. This closes the
      // LLM↔DOM gap for filter tasks WITHOUT a model round-trip: `selectOnDropdown`
      // self-validates, so a value is only applied when one of THAT dropdown's own
      // options matches a task word. With filters already set, the single model
      // call below only has to confirm/finish — it can no longer fire stray clicks.
      const preApplied = await this.completeTaskFiltersDeterministically(task, 1, history)

      this.callbacks?.onStatus?.('Step 1: observing page')
      const observation = this.pageController.observe()

      this.callbacks?.onStatus?.('Step 1: asking model')
      const messages = buildPrompt(task, observation, history, this.pages, true)

      let actions: AgentAction[]
      try {
        actions = await this.client.getNextActions(messages)
      } catch (error) {
        // The deterministic pass may already have satisfied the request — don't
        // hard-fail the run if we managed to apply at least one filter.
        if (preApplied > 0) {
          return { status: 'done', history, message: 'Applied requested filters.' }
        }
        return {
          status: 'error',
          history,
          message: error instanceof Error ? error.message : 'Failed to get model action',
        }
      }

      if (actions.length === 0) {
        if (preApplied > 0) {
          return { status: 'done', history, message: 'Applied requested filters.' }
        }
        return { status: 'error', history, message: 'Model returned no actions.' }
      }

      // Execute the model's plan, but DEFER a bare `done` so the post-pass can still
      // apply anything the model skipped before we accept completion.
      let terminal: AgentRunResult | null = null
      let modelActed = false
      const batch = actions.slice(0, MAX_BATCH)
      for (let j = 0; j < batch.length; j += 1) {
        const action = batch[j]
        if (action.action === 'done') continue
        modelActed = true
        const outcome = await this.runAction(task, action, observation, 2 + j * 0.1, history, failureRef, verifyRef)
        if (outcome.type === 'return') { terminal = outcome.result; break }
        if (outcome.type === 'break') break
      }
      if (terminal) return terminal

      // ── POST-PASS: only if the model changed the page, catch any newly
      // revealed filters the model left unset. Skipped for pure filter tasks
      // (model returned done) to avoid redundant dropdown work.
      const postApplied = modelActed
        ? await this.completeTaskFiltersDeterministically(task, 3, history)
        : 0

      return {
        status: 'done',
        history,
        message:
          preApplied + postApplied > 0
            ? 'Applied requested filters.'
            : 'Executed one-call plan.',
      }
    }

    for (let step = 1; step <= this.maxSteps; step += 1) {
      this.callbacks?.onStatus?.(`Step ${step}: observing page`)
      const observation = this.pageController.observe()

      this.callbacks?.onStatus?.(`Step ${step}: asking model`)
      const messages = buildPrompt(task, observation, history, this.pages)

      let actions: AgentAction[]
      try {
        actions = await this.client.getNextActions(messages)
      } catch (error) {
        return {
          status: 'error',
          history,
          message: error instanceof Error ? error.message : 'Failed to get model action',
        }
      }

      if (actions.length === 0) {
        failureRef.count += 1
        if (failureRef.count >= 3) {
          return { status: 'error', history, message: 'Model returned no actions.' }
        }
        continue
      }

      // Run the batch in order against the SAME observation. Batch-safe actions
      // (filters, inputs, scrolls) chain without another model call; a click /
      // navigate / failure stops the batch so the next loop re-observes with
      // fresh indexes.
      const batch = actions.slice(0, MAX_BATCH)
      for (let j = 0; j < batch.length; j += 1) {
        const outcome = await this.runAction(task, batch[j], observation, step + j * 0.1, history, failureRef, verifyRef)
        if (outcome.type === 'return') return outcome.result
        if (outcome.type === 'break') break
      }
    }

    return {
      status: 'max_steps',
      history,
      message: `Stopped after ${this.maxSteps} steps.`,
    }
  }

  /** Execute a single action and decide whether the batch may continue. */
  private async runAction(
    task: string,
    action: AgentAction,
    observation: PageObservation,
    step: number,
    history: AgentHistoryEntry[],
    failureRef: { count: number },
    verifyRef: { count: number },
  ): Promise<StepOutcome> {
    this.callbacks?.onStatus?.(`Step ${step}: executing ${action.action}`)

    if (this.confirmAction) {
      const allowed = await this.confirmAction(action)
      if (!allowed) {
        return {
          type: 'return',
          result: { status: 'error', history, message: `Action "${action.action}" was rejected by confirmAction.` },
        }
      }
    }

    const prevUrl = observation.url
    const result = await this.pageController.executeAction(action)

    // Let the page settle (React portals, async renders) — resolves as soon
    // as the DOM goes quiet instead of a fixed sleep.
    if (action.action === 'click' || action.action === 'input' || action.action === 'select') {
      await this.pageController.waitForStability()
    }

    // URL-change detection. Only clicks need a full re-scan (menu detection);
    // every other action gets a cheap URL read.
    const postClickObs: PageObservation | null = action.action === 'click' ? this.pageController.observe() : null
    const nextUrl = postClickObs?.url ?? this.pageController.getUrl()
    const navigated = action.action === 'click' && nextUrl !== prevUrl
    // Consider it a "detail page navigation" if the new URL contains a UUID (list → detail)
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
      // A single failed action is RECOVERABLE: re-observe and let the model retry
      // with a valid value, pick a different element, or call `done`. Abort only
      // after several consecutive failures to avoid infinite loops.
      failureRef.count += 1
      if (failureRef.count >= 3) {
        const informative = [...history]
          .reverse()
          .find((h) => !h.result.success && /Available options/i.test(h.result.message))
        return {
          type: 'return',
          result: { status: 'error', history, message: informative?.result.message ?? result.message },
        }
      }
      return { type: 'break' }
    }
    failureRef.count = 0

    // MENU AUTO-CLICK: if a click opened a context menu (MENU ITEMs visible, no navigation),
    // auto-click the matching item based on task intent instead of asking the model again.
    if (action.action === 'click' && !navigated && postClickObs) {
      // EXPORT AUTO-DONE: a successful click on an export/download control completes the
      // task — downloads are async and produce no observable DOM change.
      const clickedLabel = observation.elements.find((el) => el.index === action.args?.index)?.label ?? ''
      if (EXPORT_RE.test(clickedLabel)) {
        this.callbacks?.onStatus?.('Done')
        return {
          type: 'return',
          result: { status: 'done', history, message: `Triggered export: ${clickedLabel.replace(/^[A-Z ]+:\s*/, '')}` },
        }
      }

      const menuItems = postClickObs.elements.filter((el) => el.label.startsWith('MENU ITEM:'))
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
        await this.pageController.waitForStability()

        const afterMenuUrl = this.pageController.getUrl()
        const menuNavigated = afterMenuUrl !== nextUrl
        const menuNavigatedToDetail =
          menuNavigated && UUID_RE.test(afterMenuUrl) && !UUID_RE.test(nextUrl)

        const menuEntry: AgentHistoryEntry = {
          step: step + 0.05,
          observation: postClickObs.elementsText,
          action: { action: 'click', args: { index: target.index }, thought: `Auto-clicked ${target.label}` },
          result: menuNavigated
            ? { ...menuResult, message: `${menuResult.message} → navigated to ${afterMenuUrl}` }
            : menuResult,
        }
        history.push(menuEntry)
        this.callbacks?.onStep?.(menuEntry)

        if (menuNavigatedToDetail) {
          this.callbacks?.onStatus?.('Done')
          return { type: 'return', result: { status: 'done', history, message: `Navigated to ${afterMenuUrl}` } }
        }
        // Menu handled — re-observe before doing anything else.
        return { type: 'break' }
      }
    }

    // If a click caused navigation to a detail page (URL contains UUID), the item action is complete
    if (navigatedToDetail) {
      this.callbacks?.onStatus?.('Done')
      return { type: 'return', result: { status: 'done', history, message: `Navigated to ${nextUrl}` } }
    }

    if (action.action === 'done' || result.done) {
      // DONE GATE: a terse model (esp. under JSON mode) often applies ONE filter
      // then calls done, silently dropping a second requested filter. If we have
      // already applied a filter AND another FILTER DROPDOWN is still unset, give
      // the model ONE more cheap turn (with the current filter values spelled out)
      // to apply the missing one before we accept done. No dropdowns are opened.
      const missing = await this.maybeApplyMissingFilter(task, step, history, verifyRef)
      if (missing) return missing

      this.callbacks?.onStatus?.('Done')
      return { type: 'return', result: { status: 'done', history, message: result.message } }
    }

    // Batch-safe actions keep indexes valid → consume the next batched action.
    // A plain click / navigate may have changed the page → re-observe & re-ask.
    return BATCH_SAFE_ACTIONS.has(action.action) ? { type: 'continue' } : { type: 'break' }
  }

  /**
   * When the model finishes a filtering task early, deterministically apply a
   * still-missing filter. Many small/fast models (especially under JSON mode)
   * apply ONE filter then call done, dropping a second requested value — and they
   * keep saying "done" even when re-asked, because MUI dropdowns often expose no
   * field name to reason about. So instead of pleading with the model we:
   *   1. compute the LEFTOVER task words (task minus already-applied filter values
   *      minus the page/entity name) — project-agnostic, no domain vocabulary;
   *   2. if leftover words remain AND a FILTER DROPDOWN is still unset, attempt a
   *      real `select(unsetDropdown, task)`. `selectOnDropdown` only applies when
   *      one of that dropdown's OWN options actually appears in the task, and it
   *      opens→picks→closes a SINGLE dropdown (never the multi-open inspection that
   *      used to leave portals stuck open).
   * Returns a StepOutcome when it applied something (loop re-observes), else null
   * to accept the model's done.
   */
  private async maybeApplyMissingFilter(
    task: string,
    step: number,
    history: AgentHistoryEntry[],
    verifyRef: { count: number },
  ): Promise<StepOutcome | null> {
    if (verifyRef.count >= MAX_DONE_VERIFY) return null

    const appliedAFilter = history.some(
      (h) => h.action.action === 'select' && h.result.success,
    )
    if (!appliedAFilter) return null

    const observation = this.pageController.observe()
    const filters = observedFilters(observation)
    const unset = filters.filter((f) => isNeutralFilterValue(f.current))
    const applied = filters.filter((f) => !isNeutralFilterValue(f.current))
    if (filters.length < 2 || unset.length === 0) return null

    // LEFTOVER WORDS: task words that are NOT part of an already-applied filter
    // value and NOT part of the page/entity name. If none remain, the user asked
    // for a single qualifier and we should accept done.
    const consumed = new Set<string>()
    for (const f of applied) for (const w of meaningfulWords(f.current)) consumed.add(w)
    const routed = resolveIntent(task, this.pages)
    if (routed) {
      for (const w of meaningfulWords(routed.label)) consumed.add(w)
      if (routed.section) for (const w of meaningfulWords(routed.section)) consumed.add(w)
    }
    const leftover = meaningfulWords(task).filter((w) => !consumed.has(w))
    if (leftover.length === 0) return null

    verifyRef.count += 1
    this.callbacks?.onStatus?.(`Step ${step}: applying remaining filter`)

    // Try each still-unset dropdown. The select self-validates: it only changes
    // state if one of that dropdown's options actually appears in the task.
    for (const f of unset) {
      const action: AgentAction = {
        action: 'select',
        args: { index: f.index, value: task },
        thought: 'Apply remaining requested filter value',
      }
      if (this.confirmAction && !(await this.confirmAction(action))) continue

      const result = await this.pageController.executeAction(action)
      await this.pageController.waitForStability()

      if (result.success) {
        const entry: AgentHistoryEntry = {
          step: step + 0.5,
          observation: observation.elementsText,
          action,
          result,
        }
        history.push(entry)
        this.callbacks?.onStep?.(entry)
        // Re-observe on the next loop iteration (more filters may remain).
        return { type: 'break' }
      }
    }

    // No unset dropdown could satisfy the leftover words → accept the model's done.
    return null
  }

  /**
   * Deterministically apply FILTER DROPDOWN values that the task literally names.
   * Project-agnostic and model-free: for every still-unset dropdown it attempts a
   * real `select(index, task)`. `selectOnDropdown` self-validates — it only changes
   * state when one of THAT dropdown's own options matches a word in the task — so
   * unrelated dropdowns are left untouched (e.g. a status word never lands in a
   * region field). Re-observes after each successful select (indexes may shift)
   * and stops when no further filter can be applied. Returns how many filters were
   * set so callers can report or skip the model call accordingly.
   *
   * This is what closes the LLM↔DOM gap for filter tasks: instead of relying on a
   * terse model to map "mining license" → the right dropdown, the dropdown's own
   * options decide the match — no domain vocabulary, no extra API calls.
   */
  private async completeTaskFiltersDeterministically(
    task: string,
    startStep: number,
    history: AgentHistoryEntry[],
  ): Promise<number> {
    const MAX_PASSES = 6
    const tried = new Set<string>()
    let applied = 0
    let micro = startStep

    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      const observation = this.pageController.observe()
      const unset = observedFilters(observation).filter(
        (f) => isNeutralFilterValue(f.current) && !tried.has(f.field || `#${f.index}`),
      )
      if (unset.length === 0) break

      let appliedThisPass = false
      for (const f of unset) {
        // Never retry the same dropdown — a failed combobox attempt opens/closes a
        // portal, so repeating it would cause visible flicker for no benefit.
        tried.add(f.field || `#${f.index}`)

        const action: AgentAction = {
          action: 'select',
          args: { index: f.index, value: task },
          thought: 'Apply requested filter value from task',
        }
        if (this.confirmAction && !(await this.confirmAction(action))) continue

        const result = await this.pageController.executeAction(action)
        await this.pageController.waitForStability()
        if (!result.success) continue

        micro += 0.1
        const entry: AgentHistoryEntry = {
          step: Number(micro.toFixed(2)),
          observation: observation.elementsText,
          action,
          result,
        }
        history.push(entry)
        this.callbacks?.onStep?.(entry)
        applied += 1
        appliedThisPass = true
        break // a successful select can renumber indexes → re-observe
      }
      if (!appliedThisPass) break
    }

    return applied
  }
}
