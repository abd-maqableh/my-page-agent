import type { ActionExecutionResult, AgentAction } from '../core/types'

/** Poll until a DOM element matching selector appears, or timeoutMs elapses. */
function waitForElement(selector: string, timeoutMs: number, doc: Document): Promise<Element | null> {
  return new Promise((resolve) => {
    const existing = doc.querySelector(selector)
    if (existing) return resolve(existing)
    const start = Date.now()
    const check = () => {
      const el = doc.querySelector(selector)
      if (el) return resolve(el)
      if (Date.now() - start < timeoutMs) setTimeout(check, 50)
      else resolve(null)
    }
    setTimeout(check, 50)
  })
}

function findByText(query: string, elementMap: Map<number, Element>): Element | undefined {
  const normalized = query.replace(/^a/, '').trim().toLowerCase()
  for (const el of elementMap.values()) {
    const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
    if (label === normalized || label.includes(normalized)) return el
  }
  return undefined
}

function getElement(index: number | undefined, args: AgentAction['args'], elementMap: Map<number, Element>): Element {
  if (index !== undefined && index !== null) {
    const el = elementMap.get(index)
    if (el) return el
    throw new Error(`Element not found for index ${index}`)
  }

  // Fallback: search by any string value in args (label, name, text, selector text, etc.)
  const candidates = Object.values(args ?? {}).filter((v): v is string => typeof v === 'string')
  for (const candidate of candidates) {
    // Try to extract a numeric index from strings like "[5]" or "element5"
    const numMatch = candidate.match(/\[(\d+)\]/) ?? candidate.match(/^(\d+)$/)
    if (numMatch) {
      const el = elementMap.get(parseInt(numMatch[1], 10))
      if (el) return el
    }
    // Try label-based text search
    const el = findByText(candidate, elementMap)
    if (el) return el
  }

  throw new Error('Missing required arg: index')
}

function doClick(
  index: number | undefined,
  args: AgentAction['args'],
  elementMap: Map<number, Element>,
  doc: Document,
  win: Window & typeof globalThis,
): Promise<ActionExecutionResult> {
  const el = getElement(index, args, elementMap)
  if (typeof (el as HTMLElement).focus !== 'function') {
    throw new Error(`Element ${index} is not clickable.`)
  }

  ;(el as HTMLElement).focus()
  // MUI Select listens to mousedown, not click — dispatch the full sequence
  if (el.getAttribute('role') === 'combobox') {
    el.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true, view: win }))
    el.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, cancelable: true, view: win }))
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, view: win }))
    return waitForElement('[role="listbox"]', 1500, doc).then(() => ({
      success: true,
      message: `Clicked element ${index}`,
    }))
  }
  ;(el as HTMLElement).click()

  return Promise.resolve({ success: true, message: `Clicked element ${index}` })
}

function doInput(
  index: number | undefined,
  text: string | undefined,
  args: AgentAction['args'],
  elementMap: Map<number, Element>,
  win: Window & typeof globalThis,
): ActionExecutionResult {
  const el = getElement(index, args, elementMap)
  if (!text) {
    throw new Error('Missing required arg: text')
  }

  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea') {
    ;(el as HTMLElement).focus()
    // Use the native prototype setter so React's synthetic event system sees the change.
    // Directly setting el.value on a controlled React input is silently ignored.
    const proto = tag === 'input' ? win.HTMLInputElement.prototype : win.HTMLTextAreaElement.prototype
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (nativeSetter) {
      nativeSetter.call(el, text)
    } else {
      (el as HTMLInputElement).value = text
    }
    el.dispatchEvent(new win.Event('input', { bubbles: true }))
    el.dispatchEvent(new win.Event('change', { bubbles: true }))
    return { success: true, message: `Entered text into element ${index}` }
  }

  throw new Error(`Element ${index} does not support text input`)
}

async function doSelect(
  index: number | undefined,
  value: string | undefined,
  args: AgentAction['args'],
  elementMap: Map<number, Element>,
  doc: Document,
  win: Window & typeof globalThis,
): Promise<ActionExecutionResult> {
  const el = getElement(index, args, elementMap)

  if (!value) {
    throw new Error('Missing required arg: value')
  }

  // Native <select>
  if (el.tagName.toLowerCase() === 'select') {
    const selectEl = el as HTMLSelectElement
    const match = Array.from(selectEl.options).find((option) => {
      return option.value.toLowerCase() === value.toLowerCase() || option.text.toLowerCase() === value.toLowerCase()
    })

    if (!match) {
      throw new Error(`No option matched value "${value}" on element ${index}`)
    }

    selectEl.value = match.value
    el.dispatchEvent(new win.Event('input', { bubbles: true }))
    el.dispatchEvent(new win.Event('change', { bubbles: true }))

    return { success: true, message: `Selected "${match.text}" on element ${index}` }
  }

  // MUI / custom combobox — open it, wait for portal options, click the match
  if (el.getAttribute('role') === 'combobox') {
    ;(el as HTMLElement).focus()
    // MUI Select listens to mousedown — dispatch the full sequence
    el.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true, view: win }))
    el.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, cancelable: true, view: win }))
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, view: win }))

    const listbox = await waitForElement('[role="listbox"]', 1500, doc)
    if (!listbox) {
      throw new Error(`Dropdown did not open for element ${index}`)
    }

    const options = Array.from(doc.querySelectorAll('[role="option"]'))
    const match = options.find((opt) => {
      const text = (opt.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
      return text === value.toLowerCase() || text.includes(value.toLowerCase())
    }) as HTMLElement | undefined

    if (!match) {
      throw new Error(`No option matched "${value}" in dropdown for element ${index}`)
    }

    match.click()
    return { success: true, message: `Selected "${value}" from dropdown element ${index}` }
  }

  throw new Error(`Element ${index} is not a <select> or combobox — cannot use select action`)
}

function doScroll(direction: 'up' | 'down' = 'down', amount: number | undefined, win: Window & typeof globalThis): ActionExecutionResult {
  const distance = amount ?? Math.round(win.innerHeight * 0.7)
  const top = direction === 'up' ? -Math.abs(distance) : Math.abs(distance)
  win.scrollBy({ top, behavior: 'smooth' })

  return { success: true, message: `Scrolled ${direction} by ${Math.abs(top)}px` }
}

async function doWait(timeoutMs = 1000, win: Window & typeof globalThis): Promise<ActionExecutionResult> {
  await new Promise((resolve) => win.setTimeout(resolve, timeoutMs))
  return { success: true, message: `Waited ${timeoutMs}ms` }
}

async function doNavigate(url: string, win: Window & typeof globalThis): Promise<ActionExecutionResult> {
  if (!url) throw new Error('Missing required arg: url')
  win.location.href = url
  // Wait for the SPA/page to start loading and settle
  await new Promise((resolve) => setTimeout(resolve, 1800))
  return { success: true, message: `Navigated to ${url}` }
}

export async function runAction(
  action: AgentAction,
  elementMap: Map<number, Element>,
  doc: Document = document,
  win: Window & typeof globalThis = window,
): Promise<ActionExecutionResult> {
  try {
    switch (action.action) {
      case 'click':
        return doClick(action.args?.index, action.args, elementMap, doc, win)
      case 'input':
        return doInput(action.args?.index, action.args?.text, action.args, elementMap, win)
      case 'select':
        return doSelect(action.args?.index, action.args?.value ?? action.args?.text, action.args, elementMap, doc, win)
      case 'scroll':
        return doScroll(action.args?.direction, action.args?.amount, win)
      case 'wait':
        return doWait(action.args?.timeoutMs, win)
      case 'navigate':
        return doNavigate(action.args?.url ?? '', win)
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
