import type { AgentAction, AgentActionName } from './types'

const VALID_ACTIONS: AgentActionName[] = ['click', 'input', 'select', 'scroll', 'wait', 'done']

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

  const argsValue = raw.args
  const args = argsValue && typeof argsValue === 'object' ? (argsValue as AgentAction['args']) : undefined

  return {
    thought: typeof raw.thought === 'string' ? raw.thought : undefined,
    action: raw.action as AgentActionName,
    args,
  }
}
