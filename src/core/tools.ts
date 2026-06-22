import type { AgentAction, AgentActionName } from './types'

const VALID_ACTIONS: AgentActionName[] = ['click', 'input', 'select', 'clear', 'press_key', 'hover', 'scroll', 'wait', 'navigate', 'done']

/** Map of common LLM synonyms/alternates to canonical action names. */
const ACTION_SYNONYMS: Record<string, AgentActionName> = {
  tap: 'click',
  press: 'click',
  submit: 'click',
  fill: 'input',
  type: 'input',
  write: 'input',
  enter: 'input',
  choose: 'select',
  pick: 'select',
  check: 'click',
  toggle: 'click',
  focus: 'hover',
  open: 'click',
  go: 'navigate',
  goto: 'navigate',
  finish: 'done',
  complete: 'done',
  end: 'done',
}

/**
 * Patterns for last-resort index recovery from the model's `thought` field.
 * Tried in priority order — first match wins.
 */
const THOUGHT_INDEX_PATTERNS: RegExp[] = [
  /\[(\d+)\]/,          // [5]
  /element\s+(\d+)/i,   // element 5
  /index\s+(\d+)/i,     // index 5
  /item\s+(\d+)/i,      // item 5
  /number\s+(\d+)/i,    // number 5
  /#(\d+)\b/,           // #5
  /\bno\.?\s*(\d+)/i,   // no. 5 or no 5
]

export function isValidActionName(action: string): action is AgentActionName {
  return VALID_ACTIONS.includes(action as AgentActionName)
}

/**
 * Normalize raw LLM output into a valid AgentAction.
 *
 * Handles:
 *  - ACTION_SYNONYMS (tap→click, fill→input, …)
 *  - Flat-arg recovery (top-level index/text/value → args)
 *  - Thought-based index recovery from multiple patterns
 *  - Index range validation (when elementCount is provided)
 *
 * @param input        The raw parsed JSON from the LLM.
 * @param elementCount Optional — when provided, validates index is 1..elementCount.
 */
export function normalizeAction(input: unknown, elementCount?: number): AgentAction {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid action payload: expected object.')
  }

  const raw = input as Record<string, unknown>

  // --- Step 1: resolve action synonyms ---
  const rawAction = String(raw.action ?? '').toLowerCase().trim()
  const resolvedAction = ACTION_SYNONYMS[rawAction] ?? rawAction
  if (!isValidActionName(resolvedAction)) {
    throw new Error(`Invalid action: ${rawAction}`)
  }

  // --- Step 2: collect flat top-level args as fallback ---
  // Some small models return flat JSON without an "args" wrapper, e.g.:
  // {"action":"click","index":3} instead of {"action":"click","args":{"index":3}}
  const flatArgs: Record<string, unknown> = {}
  const ARG_KEYS = ['index', 'text', 'value', 'direction', 'amount', 'timeoutMs', 'result', 'url', 'key']
  for (const key of ARG_KEYS) {
    if (key in raw) flatArgs[key] = raw[key]
  }

  const argsValue = raw.args && typeof raw.args === 'object' ? raw.args : undefined
  const mergedArgs: Record<string, unknown> =
    argsValue !== undefined
      ? { ...(argsValue as Record<string, unknown>) }
      : Object.keys(flatArgs).length > 0
        ? { ...flatArgs }
        : {}

  // --- Step 3: extended thought-based index recovery ---
  const INDEX_ACTIONS = ['click', 'input', 'select', 'clear', 'hover']
  if (INDEX_ACTIONS.includes(resolvedAction) && mergedArgs.index === undefined) {
    const thought = typeof raw.thought === 'string' ? raw.thought : ''
    for (const pattern of THOUGHT_INDEX_PATTERNS) {
      const match = thought.match(pattern)
      if (match) {
        mergedArgs.index = parseInt(match[1], 10)
        break
      }
    }
  }

  // --- Step 4: index range validation ---
  if (typeof mergedArgs.index === 'number' && elementCount !== undefined) {
    if (mergedArgs.index < 1 || mergedArgs.index > elementCount) {
      throw new Error(
        `Index ${mergedArgs.index} is out of range. Valid indexes are 1–${elementCount}. ` +
        `The model may be referencing a stale element list.`
      )
    }
  }

  const args = Object.keys(mergedArgs).length > 0 ? (mergedArgs as AgentAction['args']) : undefined

  return {
    thought: typeof raw.thought === 'string' ? raw.thought : undefined,
    action: resolvedAction,
    args,
  }
}

/**
 * Normalize a model response into a LIST of actions. Supports the three shapes a
 * model may emit:
 *   1. a single action object:            {"action":"select","args":{...}}
 *   2. an object with an "actions" array: {"thought":"...","actions":[{...},{...}]}
 *   3. a bare array of action objects:    [{"action":"select",...},{...}]
 * A top-level "thought" is propagated to any batched action that lacks its own.
 *
 * @param input        The raw parsed JSON from the LLM.
 * @param elementCount Optional — forwarded to normalizeAction for index validation.
 */
export function normalizeActions(input: unknown, elementCount?: number): AgentAction[] {
  if (Array.isArray(input)) {
    const results: AgentAction[] = []
    for (let i = 0; i < input.length; i++) {
      try {
        results.push(normalizeAction(input[i], elementCount))
      } catch (err) {
        throw new Error(`Batch action[${i}] is invalid: ${(err as Error).message}`)
      }
    }
    return results
  }

  if (input && typeof input === 'object' && Array.isArray((input as Record<string, unknown>).actions)) {
    const obj = input as Record<string, unknown>
    const sharedThought = typeof obj.thought === 'string' ? obj.thought : undefined
    const items = obj.actions as unknown[]
    const results: AgentAction[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      try {
        if (
          sharedThought &&
          item &&
          typeof item === 'object' &&
          !('thought' in (item as Record<string, unknown>))
        ) {
          results.push(normalizeAction({ thought: sharedThought, ...(item as Record<string, unknown>) }, elementCount))
        } else {
          results.push(normalizeAction(item, elementCount))
        }
      } catch (err) {
        throw new Error(`Batch action[${i}] is invalid: ${(err as Error).message}`)
      }
    }
    return results
  }

  return [normalizeAction(input, elementCount)]
}
