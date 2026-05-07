import type { ActionExecutionResult, AgentAction } from '../core/types'

function getElement(index: number | undefined, elementMap: Map<number, Element>): Element {
  if (!index) {
    throw new Error('Missing required arg: index')
  }

  const el = elementMap.get(index)
  if (!el) {
    throw new Error(`Element not found for index ${index}`)
  }

  return el
}

function doClick(index: number | undefined, elementMap: Map<number, Element>): ActionExecutionResult {
  const el = getElement(index, elementMap)
  if (!(el instanceof HTMLElement)) {
    throw new Error(`Element ${index} is not clickable.`)
  }

  el.focus()
  el.click()
  return { success: true, message: `Clicked element ${index}` }
}

function doInput(index: number | undefined, text: string | undefined, elementMap: Map<number, Element>): ActionExecutionResult {
  const el = getElement(index, elementMap)
  if (!text) {
    throw new Error('Missing required arg: text')
  }

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.focus()
    el.value = text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { success: true, message: `Entered text into element ${index}` }
  }

  throw new Error(`Element ${index} does not support text input`)
}

function doSelect(
  index: number | undefined,
  value: string | undefined,
  elementMap: Map<number, Element>,
): ActionExecutionResult {
  const el = getElement(index, elementMap)

  if (!(el instanceof HTMLSelectElement)) {
    throw new Error(`Element ${index} is not a select element`)
  }
  if (!value) {
    throw new Error('Missing required arg: value')
  }

  const match = Array.from(el.options).find((option) => {
    return option.value.toLowerCase() === value.toLowerCase() || option.text.toLowerCase() === value.toLowerCase()
  })

  if (!match) {
    throw new Error(`No option matched value "${value}" on element ${index}`)
  }

  el.value = match.value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))

  return { success: true, message: `Selected "${match.text}" on element ${index}` }
}

function doScroll(direction: 'up' | 'down' = 'down', amount?: number): ActionExecutionResult {
  const distance = amount ?? Math.round(window.innerHeight * 0.7)
  const top = direction === 'up' ? -Math.abs(distance) : Math.abs(distance)
  window.scrollBy({ top, behavior: 'smooth' })

  return { success: true, message: `Scrolled ${direction} by ${Math.abs(top)}px` }
}

async function doWait(timeoutMs = 1000): Promise<ActionExecutionResult> {
  await new Promise((resolve) => window.setTimeout(resolve, timeoutMs))
  return { success: true, message: `Waited ${timeoutMs}ms` }
}

export async function runAction(action: AgentAction, elementMap: Map<number, Element>): Promise<ActionExecutionResult> {
  try {
    switch (action.action) {
      case 'click':
        return doClick(action.args?.index, elementMap)
      case 'input':
        return doInput(action.args?.index, action.args?.text, elementMap)
      case 'select':
        return doSelect(action.args?.index, action.args?.value ?? action.args?.text, elementMap)
      case 'scroll':
        return doScroll(action.args?.direction, action.args?.amount)
      case 'wait':
        return doWait(action.args?.timeoutMs)
      case 'done':
        return { success: true, message: action.args?.result ?? 'Agent marked task as done.', done: true }
      default:
        return { success: false, message: `Unknown action: ${(action as { action: string }).action}` }
    }
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Unknown execution error',
    }
  }
}
