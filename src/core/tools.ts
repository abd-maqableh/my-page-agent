import type { AgentAction, AgentActionName } from './types'

const VALID_ACTIONS: AgentActionName[] = ['click', 'input', 'select', 'scroll', 'wait', 'navigate', 'done']

export function isValidActionName(action: string): action is AgentActionName {
  return VALID_ACTIONS.includes(action as AgentActionName)
}

export function normalizeAction(input: unknown): AgentAction {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid action payload: expected object.')
  }

  const raw = input as Record<string, unknown>
  if (!isValidActionName(String(raw.action ?? ''))) {
    throw new Error(`Invalid action: ${String(raw.action ?? 'unknown')}`)
  }

  // Some small models return flat JSON without an "args" wrapper, e.g.:
  // {"action":"click","index":3} instead of {"action":"click","args":{"index":3}}
  // Collect any known arg keys from the top-level object as a fallback.
  const flatArgs: Record<string, unknown> = {}
  const ARG_KEYS = ['index', 'text', 'value', 'direction', 'amount', 'timeoutMs', 'result', 'url']
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

  // Last-resort: if index is still missing for actions that need it,
  // try to extract it from the thought — models often write "element [5]" or "[5]"
  const INDEX_ACTIONS = ['click', 'input', 'select']
  if (INDEX_ACTIONS.includes(String(raw.action)) && mergedArgs.index === undefined) {
    const thought = typeof raw.thought === 'string' ? raw.thought : ''
    const match = thought.match(/\[(\d+)\]/) ?? thought.match(/element\s+(\d+)/i)
    if (match) {
      mergedArgs.index = parseInt(match[1], 10)
    }
  }

  const args = Object.keys(mergedArgs).length > 0 ? (mergedArgs as AgentAction['args']) : undefined

  return {
    thought: typeof raw.thought === 'string' ? raw.thought : undefined,
    action: raw.action as AgentActionName,
    args,
  }
}
