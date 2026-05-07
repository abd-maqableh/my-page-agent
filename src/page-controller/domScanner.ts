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

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) {
    return false
  }

  const rect = el.getBoundingClientRect()
  const style = window.getComputedStyle(el)
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
}

function getLabel(el: Element): string {
  const aria = el.getAttribute('aria-label')?.trim()
  if (aria) return aria

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
    const selectedText = el.selectedOptions[0]?.textContent?.trim()
    if (selectedText) return selectedText
  }

  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (text) return text

  return `${el.tagName.toLowerCase()} element`
}

function getType(el: Element): string | null {
  if (el instanceof HTMLInputElement) {
    return el.type || 'text'
  }
  return null
}

export function scanInteractiveElements(root: ParentNode = document): ScanResult {
  const all = Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR))
  const seen = new Set<Element>()

  const uniqueVisible = all.filter((el) => {
    if (seen.has(el) || !isVisible(el)) {
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
    .map((el) => `[${el.index}] ${el.tag}${el.type ? `:${el.type}` : ''} ${el.label}`)
    .join('\n')

  return { elements, elementMap, text }
}
