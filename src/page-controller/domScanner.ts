import type { PageElementSummary } from '../core/types'

export interface ScanResult {
  elements: PageElementSummary[]
  elementMap: Map<number, Element>
  text: string
}

const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="combobox"]',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

function isVisible(el: Element, win: Window & typeof globalThis): boolean {
  if (typeof (el as HTMLElement).focus !== 'function') {
    return false
  }

  const rect = (el as HTMLElement).getBoundingClientRect()
  const style = win.getComputedStyle(el as HTMLElement)
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
}

function getLabel(el: Element): string {
  const aria = el.getAttribute('aria-label')?.trim()
  if (aria) return aria

  const title = el.getAttribute('title')?.trim()
  if (title) return title

  if (el instanceof HTMLInputElement) {
    if (el.labels?.length) {
      const labelText = Array.from(el.labels)
        .map((label) => label.textContent?.trim())
        .filter(Boolean)
        .join(' ')
      if (labelText) return labelText
    }
    if (el.placeholder?.trim()) return el.placeholder.trim()
  }

  if (el instanceof HTMLSelectElement) {
    if (!el.selectedOptions.length) {
      return 'FILTER DROPDOWN (no selection)'
    }
    const selectedText = el.selectedOptions[0]?.textContent?.trim()
    if (selectedText) return `FILTER DROPDOWN: ${selectedText}`
  }

  // Combobox / MUI Select — label as filter dropdown
  if (el.getAttribute('role') === 'combobox') {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    return `FILTER DROPDOWN: ${text || 'select option'}`
  }

  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()

  // Annotate icon-only or ellipsis buttons as per-item action menus
  // Only match truly empty or pure ellipsis/dot patterns — NOT short numeric text like "6"
  if (!text || text === '...' || text === '\u22EF' || text === '\u2022\u2022\u2022' || /^[.⋯…⋮⋰⋱]+$/.test(text)) {
    const cardTitle = el
      .closest('[class*="Card"],[class*="card"],[class*="item"],[class*="row"]')
      ?.querySelector('h1,h2,h3,h4,h5,h6,strong')
      ?.textContent
      ?.trim()
    if (cardTitle) return `Per-item actions menu (${cardTitle.substring(0, 30)})`
    return 'Per-item actions menu (\u22EF)'
  }

  if (text) return text

  return `${el.tagName.toLowerCase()} element`
}

function getType(el: Element): string | null {
  if (el instanceof HTMLInputElement) {
    return el.type || 'text'
  }
  return null
}

export function scanInteractiveElements(
  root: ParentNode = document,
  win: Window & typeof globalThis = window,
): ScanResult {
  const all = Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR))
  const seen = new Set<Element>()

  const uniqueVisible = all.filter((el) => {
    if (seen.has(el) || !isVisible(el, win)) {
      return false
    }
    // Exclude the agent panel's own UI from the interactive elements list
    if (el.closest('[data-agent-panel]')) {
      return false
    }
    seen.add(el)
    return true
  })

  const elementMap = new Map<number, Element>()
  const elements: PageElementSummary[] = uniqueVisible.map((el, i) => {
    const index = i + 1
    elementMap.set(index, el)

    return {
      index,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role'),
      type: getType(el),
      label: getLabel(el),
    }
  })

  const text = elements
    .map((el) => {
      const rolePart = el.role ? `[role=${el.role}]` : ''
      const typePart = el.type ? `:${el.type}` : ''
      return `[${el.index}] ${el.tag}${rolePart}${typePart} "${el.label}"`
    })
    .join('\n')

  return { elements, elementMap, text }
}
