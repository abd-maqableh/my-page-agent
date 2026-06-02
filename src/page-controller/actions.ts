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
  // Custom comboboxes (MUI Select, Headless UI, Radix, etc.) listen on mousedown
  // rather than click — dispatch the full pointer sequence to open the listbox.
  if (el.getAttribute('role') === 'combobox') {
    el.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true, view: win }))
    el.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, cancelable: true, view: win }))
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, view: win }))
    return waitForElement('[role="listbox"]', 1500, doc).then(() => ({
      success: true,
      message: `Clicked element ${index}`,
    }))
  }

  // Switch / Radio / Checkbox wrapper pattern (common across MUI, Chakra, Radix,
  // Headless UI, etc.): a <button>/<span>/<label> wraps an <input type="checkbox|radio">.
  // Clicking the outer wrapper does NOT toggle the input (the library stops the event).
  // Forward the click to the inner input so the state actually changes.
  const innerToggle = el.querySelector('input[type="checkbox"], input[type="radio"]') as HTMLInputElement | null
  if (innerToggle && el !== innerToggle && !(el instanceof HTMLInputElement)) {
    innerToggle.click()
    return Promise.resolve({ success: true, message: `Clicked element ${index} (toggled inner ${innerToggle.type})` })
  }

  ;(el as HTMLElement).click()

  // If this looks like a form submit button, give async validators / re-render time
  // to surface error helper text BEFORE the next observation snapshot is captured.
  const isSubmit =
    (el as HTMLButtonElement).type === 'submit'
    || el.closest('form') !== null && /save|create|submit|confirm|apply|update/i.test((el as HTMLElement).innerText || '')
  if (isSubmit) {
    return new Promise((resolve) => {
      win.setTimeout(() => resolve({ success: true, message: `Clicked element ${index} (submit)` }), 700)
    })
  }

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
    const inputEl = el as HTMLInputElement | HTMLTextAreaElement
    inputEl.focus()
    // Select existing content so the new value REPLACES (matters for masked date pickers
    // and other masked inputs where leftover mask chars like "__/__/____" would otherwise
    // be concatenated).
    try {
      inputEl.setSelectionRange?.(0, inputEl.value.length)
    } catch {
      /* some input types throw on setSelectionRange — ignore */
    }
    // Use the native prototype setter so React's synthetic event system sees the change.
    // Directly setting el.value on a controlled React input is silently ignored.
    const proto = tag === 'input' ? win.HTMLInputElement.prototype : win.HTMLTextAreaElement.prototype
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (nativeSetter) {
      nativeSetter.call(inputEl, text)
    } else {
      inputEl.value = text
    }
    // Use InputEvent (with inputType) instead of plain Event — masked-input libraries
    // (date pickers, react-imask, cleave.js, vanilla mask) inspect inputType to decide whether
    // to accept or reset the value. "insertFromPaste" mimics a paste of the full string.
    const InputEventCtor = (win as unknown as { InputEvent?: typeof InputEvent }).InputEvent
    if (InputEventCtor) {
      el.dispatchEvent(new InputEventCtor('input', { bubbles: true, data: text, inputType: 'insertFromPaste' }))
    } else {
      el.dispatchEvent(new win.Event('input', { bubbles: true }))
    }
    el.dispatchEvent(new win.Event('change', { bubbles: true }))
    // Many masked date pickers only COMMIT the parsed value on blur.
    // Without this blur, the input visually reverts to empty after re-render.
    el.dispatchEvent(new win.FocusEvent('blur', { bubbles: true }))
    if (typeof inputEl.blur === 'function') inputEl.blur()
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
    const normalizedQuery = value.toLowerCase()
    const match = Array.from(selectEl.options).find((option) => {
      const optText = option.text.toLowerCase()
      const optValue = option.value.toLowerCase()
      return optText === normalizedQuery || optValue === normalizedQuery
        || optText.includes(normalizedQuery) || normalizedQuery.includes(optText)
        || optValue.includes(normalizedQuery) || normalizedQuery.includes(optValue)
    })

    if (!match) {
      throw new Error(`No option matched value "${value}" on element ${index}`)
    }

    selectEl.value = match.value
    el.dispatchEvent(new win.Event('input', { bubbles: true }))
    el.dispatchEvent(new win.Event('change', { bubbles: true }))

    return { success: true, message: `Selected "${match.text}" on element ${index}` }
  }

  // Custom combobox (any framework with role="combobox") — open it,
  // wait for portal-rendered options, click the match.
  if (el.getAttribute('role') === 'combobox') {
    ;(el as HTMLElement).focus()
    // Most custom combobox implementations listen on mousedown — dispatch the full sequence
    el.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true, view: win }))
    el.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, cancelable: true, view: win }))
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, view: win }))

    const listbox = await waitForElement('[role="listbox"]', 1500, doc)
    if (!listbox) {
      throw new Error(`Dropdown did not open for element ${index}`)
    }

    const options = Array.from(doc.querySelectorAll('[role="option"]'))
    const normalizedValue = value.toLowerCase()
    const match = options.find((opt) => {
      const text = (opt.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
      return text === normalizedValue || text.includes(normalizedValue) || normalizedValue.includes(text)
    }) as HTMLElement | undefined

    if (!match) {
      throw new Error(`No option matched "${value}" in dropdown for element ${index}`)
    }

    match.click()
    return { success: true, message: `Selected "${value}" from dropdown element ${index}` }
  }

  throw new Error(`Element ${index} is not a <select> or combobox — cannot use select action`)
}

function doScroll(
  direction: 'up' | 'down' = 'down',
  amount: number | undefined,
  index: number | undefined,
  args: AgentAction['args'],
  elementMap: Map<number, Element>,
  win: Window & typeof globalThis,
): ActionExecutionResult {
  // If an index is provided, scroll that element into view (used for SECTION targets
  // and any other case where the agent wants to focus a specific element).
  if (index !== undefined && index !== null) {
    const el = getElement(index, args, elementMap)
    ;(el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' })
    // brief visual hint so the user sees which section the agent focused.
    // Uses a neutral blue outline that works on any site, with an opt-in override
    // via the `--agent-focus-color` CSS variable for projects that want to theme it.
    const html = el as HTMLElement
    const prev = html.style.outline
    html.style.outline = '2px solid var(--agent-focus-color, #1976d2)'
    win.setTimeout(() => { html.style.outline = prev }, 1500)
    return { success: true, message: `Scrolled element ${index} into view` }
  }
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

function doClear(
  index: number | undefined,
  args: AgentAction['args'],
  elementMap: Map<number, Element>,
  win: Window & typeof globalThis,
): ActionExecutionResult {
  const el = getElement(index, args, elementMap)
  const tag = el.tagName.toLowerCase()
  if (tag !== 'input' && tag !== 'textarea' && !(el as HTMLElement).isContentEditable) {
    throw new Error(`Element ${index} cannot be cleared`)
  }
  ;(el as HTMLElement).focus()
  if (tag === 'input' || tag === 'textarea') {
    const proto = tag === 'input' ? win.HTMLInputElement.prototype : win.HTMLTextAreaElement.prototype
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (nativeSetter) nativeSetter.call(el, '')
    else (el as HTMLInputElement).value = ''
    el.dispatchEvent(new win.Event('input', { bubbles: true }))
    el.dispatchEvent(new win.Event('change', { bubbles: true }))
  } else {
    ;(el as HTMLElement).textContent = ''
    el.dispatchEvent(new win.Event('input', { bubbles: true }))
  }
  return { success: true, message: `Cleared element ${index}` }
}

function doPressKey(
  index: number | undefined,
  key: string | undefined,
  args: AgentAction['args'],
  elementMap: Map<number, Element>,
  doc: Document,
  win: Window & typeof globalThis,
): ActionExecutionResult {
  if (!key) throw new Error('Missing required arg: key')
  let target: Element | null = null
  if (index !== undefined && index !== null) {
    target = getElement(index, args, elementMap)
    ;(target as HTMLElement).focus()
  } else {
    target = doc.activeElement ?? doc.body
  }
  const keyMap: Record<string, { key: string; code: string; keyCode: number }> = {
    enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
    tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    space: { key: ' ', code: 'Space', keyCode: 32 },
  }
  const info = keyMap[key.toLowerCase()] ?? { key, code: key, keyCode: 0 }

  for (const type of ['keydown', 'keypress', 'keyup'] as const) {
    target?.dispatchEvent(
      new win.KeyboardEvent(type, {
        key: info.key,
        code: info.code,
        keyCode: info.keyCode,
        which: info.keyCode,
        bubbles: true,
        cancelable: true,
      }),
    )
  }
  return { success: true, message: `Pressed "${key}"${index !== undefined ? ` on element ${index}` : ''}` }
}

function doHover(
  index: number | undefined,
  args: AgentAction['args'],
  elementMap: Map<number, Element>,
  win: Window & typeof globalThis,
): ActionExecutionResult {
  const el = getElement(index, args, elementMap)
  const opts = { bubbles: true, cancelable: true, view: win }
  el.dispatchEvent(new win.MouseEvent('mouseover', opts))
  el.dispatchEvent(new win.MouseEvent('mouseenter', opts))
  el.dispatchEvent(new win.MouseEvent('mousemove', opts))
  return { success: true, message: `Hovered over element ${index}` }
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
        return doScroll(action.args?.direction, action.args?.amount, action.args?.index, action.args, elementMap, win)
      case 'wait':
        return doWait(action.args?.timeoutMs, win)
      case 'navigate':
        return doNavigate(action.args?.url ?? '', win)
      case 'clear':
        return doClear(action.args?.index, action.args, elementMap, win)
      case 'press_key':
        return doPressKey(action.args?.index, action.args?.key ?? action.args?.text, action.args, elementMap, doc, win)
      case 'hover':
        return doHover(action.args?.index, action.args, elementMap, win)
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
