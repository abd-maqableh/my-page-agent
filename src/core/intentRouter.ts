import type { PageDescriptor } from './types'
import { meaningfulWords, normalizeText } from './text'

type PagesMap = Record<string, string | PageDescriptor>

export interface RoutedIntent {
  /** URL path of the page that owns the request. */
  path: string
  /** Matched page label (for status/log messages). */
  label: string
  /** Declared section to scroll to after arriving, when the task names one. */
  section?: string
  /**
   * True when the task contains nothing beyond the navigation/section request,
   * so the agent can finish deterministically without consulting the LLM.
   * False when qualifier words remain (e.g. "sent", "approved") — the agent
   * performs the navigation prefix and hands the rest to the LLM loop.
   */
  complete: boolean
}

interface Candidate {
  kind: 'page' | 'section'
  label: string
  path: string
  section?: string
  words: string[]
}

function collectCandidates(pages: PagesMap): Candidate[] {
  const out: Candidate[] = []
  const walk = (map: PagesMap) => {
    for (const [label, value] of Object.entries(map)) {
      const path = typeof value === 'string' ? value : value.path
      out.push({ kind: 'page', label, path, words: meaningfulWords(label) })
      if (typeof value === 'string') continue
      for (const section of value.sections ?? []) {
        out.push({ kind: 'section', label, path, section, words: meaningfulWords(section) })
      }
      if (value.subPages) walk(value.subPages)
    }
  }
  walk(pages)
  return out.filter((c) => c.words.length > 0)
}

/**
 * Deterministically resolve navigation/section intents from the task text
 * BEFORE consulting the LLM. Returns null when the task does not clearly
 * reference a known page or declared section.
 *
 * Matching is Unicode/Arabic-aware word-set containment:
 *  - a candidate matches when all its words appear in the task, OR when all
 *    meaningful task words appear in the candidate (user typed a shorthand).
 *  - the candidate with the largest word overlap wins; pages win ties.
 */
export function resolveIntent(task: string, pages?: PagesMap): RoutedIntent | null {
  if (!pages || Object.keys(pages).length === 0) return null

  const taskWords = meaningfulWords(task)
  if (taskWords.length === 0) return null
  const taskSet = new Set(taskWords)

  let best: { candidate: Candidate; overlap: number } | null = null
  for (const candidate of collectCandidates(pages)) {
    const candidateSet = new Set(candidate.words)
    const overlap = candidate.words.filter((w) => taskSet.has(w)).length
    const labelInTask = overlap === candidate.words.length
    const taskInLabel = taskWords.every((w) => candidateSet.has(w))
    if (!labelInTask && !taskInLabel) continue
    if (overlap === 0) continue

    const isBetter =
      !best ||
      overlap > best.overlap ||
      (overlap === best.overlap && best.candidate.kind === 'section' && candidate.kind === 'page')
    if (isBetter) best = { candidate, overlap }
  }

  if (!best) return null

  const { candidate } = best
  const matchedWords = new Set(candidate.words)
  // Also discount the owning page label words for section matches
  // (e.g. "dashboard approval trends" → section on /dashboard).
  if (candidate.kind === 'section') {
    for (const w of meaningfulWords(candidate.label)) matchedWords.add(w)
  }
  const remaining = taskWords.filter((w) => !matchedWords.has(w))

  return {
    path: candidate.path,
    label: candidate.label,
    section: candidate.section,
    complete: remaining.length === 0,
  }
}

/** True when `currentUrl` already points at `path` (pathname comparison). */
export function isOnPath(currentUrl: string, path: string): boolean {
  try {
    const current = new URL(currentUrl, 'http://local')
    const target = new URL(path, 'http://local')
    return normalizeText(current.pathname.replace(/\/$/, '')) === normalizeText(target.pathname.replace(/\/$/, ''))
  } catch {
    return false
  }
}
