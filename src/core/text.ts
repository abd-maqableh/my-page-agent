/**
 * Shared text-normalization helpers used by the intent router, DOM scanner and
 * action executors. Unicode-aware so Arabic (and any other script) labels,
 * sections and filter values match reliably.
 */

/** Strip Arabic diacritics/tatweel and unify common letter variants. */
function normalizeArabic(s: string): string {
  return s
    .replace(/[\u064B-\u065F\u0670]/g, '') // harakat / diacritics
    .replace(/\u0640/g, '') // tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
}

/** Lowercase, normalize Arabic variants, collapse whitespace. */
export function normalizeText(s: string): string {
  return normalizeArabic(s.toLowerCase()).replace(/\s+/g, ' ').trim()
}

const FILLER_WORDS = new Set([
  // English
  'the', 'a', 'an', 'and', 'by', 'for', 'of', 'in', 'on', 'at', 'to', 'me', 'my',
  'please', 'can', 'you', 'i', 'want', 'show', 'open', 'go', 'goto', 'take',
  'navigate', 'view', 'display', 'page', 'screen', 'section', 'widget',
  'chart', 'panel', 'tab', 'overview',
  // Arabic
  'في', 'الي', 'إلي', 'علي', 'من', 'عن', 'او', 'و', 'ثم', 'لو', 'سمحت',
  'اعرض', 'أعرض', 'اظهر', 'أظهر', 'افتح', 'إفتح', 'انتقل', 'إنتقل', 'اذهب',
  'خذني', 'وديني', 'صفحه', 'قسم', 'شاشه', 'لوحه', 'اريد', 'أريد', 'ابغي', 'ممكن',
])

/**
 * Canonical word form for set comparison: strips the Arabic definite article
 * ("ال") and a trailing English plural "s"/"es" so "الطلبات"≈"طلبات" and
 * "applications"≈"application" compare equal.
 */
function canonicalWord(w: string): string {
  let out = w
  if (/^\p{Script=Arabic}/u.test(out) && out.length > 4 && out.startsWith('ال')) out = out.slice(2)
  if (/^[a-z0-9]+$/.test(out) && out.length > 4) out = out.replace(/(es|s)$/, '')
  return out
}

/**
 * Split a string into its meaningful, normalized words: Unicode letters/digits
 * only, filler/navigation verbs removed, canonicalized for plural/article
 * tolerance. Works for Arabic and Latin scripts.
 */
export function meaningfulWords(s: string): string[] {
  return normalizeText(s)
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !FILLER_WORDS.has(w))
    .map(canonicalWord)
}

/** True when every meaningful word of `label` appears in `text`'s words. */
export function containsAllWords(text: string, label: string): boolean {
  const textWords = new Set(meaningfulWords(text))
  const labelWords = meaningfulWords(label)
  return labelWords.length > 0 && labelWords.every((w) => textWords.has(w))
}

/** Loose bidirectional containment match on normalized strings. */
export function looseMatch(a: string, b: string): boolean {
  const na = normalizeText(a)
  const nb = normalizeText(b)
  if (!na || !nb) return false
  return na === nb || na.includes(nb) || nb.includes(na)
}
