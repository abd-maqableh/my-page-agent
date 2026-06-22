# My Page Agent — LLM Hallucination Fixes & Enhancement Skill

> **Purpose:** A reference guide for diagnosing and fixing every known LLM hallucination category in the My Page Agent codebase, plus enhancement recipes for common improvements.  
> **Audience:** Developers working on `src/core/`, `src/page-controller/`, and `src/llm/`.

---

## Quick Diagnosis Map

Before writing any code, identify which layer the problem lives in:

```
Symptom                                   → Layer to fix
──────────────────────────────────────────────────────────
LLM returns wrong action name             → tools.ts  (normalizeAction)
LLM returns flat JSON / missing args      → tools.ts  (normalizeAction flat-arg recovery)
LLM hallucinates an index                 → prompt.ts (rules) + tools.ts (index recovery)
LLM clicks a SECTION instead of clicking → prompt.ts (Rule 5 / section rules)
LLM keeps repeating the same failed step  → prompt.ts (history format) + Agent.ts (retry guard)
LLM misidentifies a dropdown option       → actions.ts (findMatchingOption) + text.ts
LLM calls `done` too early                → prompt.ts (Rules 9–10)
LLM never calls `done`                    → Agent.ts  (maxSteps) + prompt.ts
LLM invents a URL for `navigate`          → prompt.ts (navigation rules 11–13)
LLM types wrong date format               → domScanner.ts (detectDateFormat) + prompt.ts
LLM tries to interact behind a modal      → domScanner.ts (findOpenModal) + prompt.ts Rule 15
LLM confuses search box with filter       → prompt.ts (Rules 6–7) + domScanner label prefixes
JSON truncated / can't parse              → OpenAIClient.ts (maxTokens + finish_reason check)
Arabic text not matching                  → text.ts (normalizeArabic)
```

---

## 1. Hallucination: Wrong / Invented Action Name

**Symptom:** LLM returns `"tap"`, `"submit"`, `"fill"`, `"type"` instead of a valid `AgentActionName`.

**Root cause:** The model wasn't given a strict enough action vocabulary, or it ignored the schema.

### Fix A — Tighten the system prompt schema listing (`prompt.ts`)

The system message must list EVERY valid action with its EXACT args. Template:

```ts
// In buildInteractionPrompt() / buildPrompt() — the system string
const ACTION_SCHEMA = `
Actions and their REQUIRED args (use ONLY these exact action names):
  click      → { "index": <number> }
  input      → { "index": <number>, "text": "<string>" }
  select     → { "index": <number>, "value": "<option text>" }
  clear      → { "index": <number> }
  hover      → { "index": <number> }
  press_key  → { "key": "<KeyboardEvent.key value, e.g. Enter, Tab, Escape>" }
  scroll     → { "index": <number>, "direction": "up"|"down", "amount": <pixels, default 300> }
  wait       → { "timeoutMs": <number, max 3000> }
  navigate   → { "url": "<exact path from KNOWN PAGE PATHS below>" }
  done       → { "result": "<one-sentence summary of what was accomplished>" }

NEVER use: tap, submit, fill, type, focus, check, toggle, open, close
`.trim()
```

### Fix B — Add synonym recovery in `normalizeAction` (`tools.ts`)

```ts
// Add BEFORE the isValidActionName check
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

const rawAction = String(raw.action ?? '').toLowerCase().trim()
const resolvedAction = ACTION_SYNONYMS[rawAction] ?? rawAction
if (!isValidActionName(resolvedAction)) {
  throw new Error(`Invalid action: ${rawAction}`)
}
// Use resolvedAction instead of raw.action going forward
```

### Fix C — Enable `jsonMode` for compatible servers

```ts
// In AgentConfig / LLMConfig — forces the server to return only valid JSON
const config: AgentConfig = {
  jsonMode: true,         // Adds response_format: { type: 'json_object' }
  maxTokens: 400,         // Small cap: agent actions are tiny JSON blobs
  requestTimeoutMs: 15000,
  // ...
}
```

> **Note:** `jsonMode` only works on OpenAI, vLLM, SGLang, Groq. Ollama ignores it silently. Local Llama models respond best to explicit schema in the prompt rather than JSON mode.

---

## 2. Hallucination: LLM References a Non-Existent Index

**Symptom:** `"Element not found for index 99"` — the LLM picked an index that isn't in the current element list.

**Root causes:**
- The LLM used an index from a previous step's DOM snapshot (stale reference).
- The LLM guessed a "round number" index that doesn't exist.
- The element disappeared (modal closed, tab switched, dynamic re-render).

### Fix A — Include current max index in the prompt (`prompt.ts`)

```ts
// In the user message block of buildInteractionPrompt
const maxIndex = observation.elements.length
const user = [
  `Task: ${task}`,
  `Page: ${observation.title} (${observation.url})`,
  `There are ${maxIndex} interactive element(s) on this page. Valid indexes: 1 – ${maxIndex}.`,
  'Interactive elements:',
  observation.elementsText,
  'History:',
  formatHistory(history),
  'Your JSON action:',
].join('\n\n')
```

### Fix B — Validate index range in `normalizeAction` (`tools.ts`)

Pass the element count into `normalizeAction` and reject out-of-range indexes:

```ts
// Extended signature
export function normalizeAction(input: unknown, elementCount?: number): AgentAction {
  // ... existing logic ...

  const index = mergedArgs.index
  if (typeof index === 'number' && elementCount !== undefined) {
    if (index < 1 || index > elementCount) {
      throw new Error(
        `Index ${index} is out of range. Valid indexes are 1–${elementCount}. ` +
        `The model may be referencing a stale element list.`
      )
    }
  }
  // ...
}
```

### Fix C — Strengthen `thought`-based index recovery (`tools.ts`)

The existing recovery only checks `[N]` and `element N`. Extend to cover more patterns:

```ts
// Replace the existing index recovery regex
const indexPatterns = [
  /\[(\d+)\]/,                    // [5]
  /element\s+(\d+)/i,             // element 5
  /index\s+(\d+)/i,               // index 5
  /item\s+(\d+)/i,                // item 5
  /number\s+(\d+)/i,              // number 5
  /#(\d+)\b/,                     // #5
  /\bno\.?\s*(\d+)/i,             // no. 5
]
for (const pattern of indexPatterns) {
  const match = thought.match(pattern)
  if (match) {
    mergedArgs.index = parseInt(match[1], 10)
    break
  }
}
```

---

## 3. Hallucination: LLM Clicks a SECTION Instead of an Interactive Element

**Symptom:** LLM returns `{"action":"click","args":{"index":12}}` where index 12 is `SECTION: Revenue Chart`.

**Root cause:** The LLM conflates scroll targets with clickable elements.

### Fix A — Add a hard rule in the system prompt (`prompt.ts`)

```ts
// Add to the Rules array in buildInteractionPrompt
'  SECTION RULE: Elements labelled "SECTION: ..." are scroll landmarks ONLY. ' +
'  You CANNOT click, input, or select them. ' +
'  Use scroll {"index": <section_index>, "direction": "down", "amount": 0} to bring them into view.',
```

### Fix B — Enforce in `actions.ts` by detecting section labels

```ts
// In runAction() before the switch statement
export async function runAction(
  action: AgentAction,
  elementMap: Map<number, Element>,
  win: Window & typeof globalThis,
): Promise<ActionExecutionResult> {
  const el = elementMap.get(action.args?.index ?? 0)
  if (el) {
    const label = el.getAttribute('data-agent-label') ?? ''
    const isSectionOnly = label.startsWith('SECTION:')
    const isClickLike = ['click', 'input', 'select', 'clear', 'hover'].includes(action.action)
    if (isSectionOnly && isClickLike) {
      return {
        success: false,
        message: `Cannot ${action.action} a section landmark (index ${action.args?.index}). Use scroll instead.`,
      }
    }
  }
  // ... existing switch ...
}
```

> **Prerequisite:** Store the label on the element during the scan so `runAction` can read it back:
> ```ts
> // In scanInteractiveElements, after building each element summary:
> el.setAttribute('data-agent-label', label)
> ```

---

## 4. Hallucination: LLM Repeats a Failed Action

**Symptom:** The agent loops — same action, same index, same error — for every step until `max_steps`.

**Root cause:** The history format doesn't make failed steps prominent enough, so the LLM re-reasons the same way.

### Fix A — Highlight failures in history formatting (`prompt.ts`)

```ts
function formatHistory(history: AgentHistoryEntry[]): string {
  if (!history.length) return 'No prior actions.'

  return history
    .slice(-MAX_HISTORY_ENTRIES)
    .map((item) => {
      const status = item.result.success ? '✓ success' : '✗ FAILED'
      const failNote = !item.result.success
        ? '\n  ⚠ Do NOT repeat this action. Try a different approach.'
        : ''
      return [
        `Step ${item.step} [${status}]`,
        `  Action: ${item.action.action} ${JSON.stringify(item.action.args ?? {})}`,
        `  Result: ${item.result.message}${failNote}`,
      ].join('\n')
    })
    .join('\n\n')
}
```

### Fix B — Add a retry-guard rule to the system prompt (`prompt.ts`)

```ts
'  RETRY RULE: If your previous action FAILED (marked ✗ FAILED in history), ' +
'  you MUST try a completely different action or index. ' +
'  Repeating the same failed action is forbidden.',
```

### Fix C — Detect and break retry loops in `Agent.ts`

```ts
// In the Agent loop, after getting actions from the LLM
const lastEntry = history[history.length - 1]
if (lastEntry && !lastEntry.result.success) {
  const isSameAction =
    action.action === lastEntry.action.action &&
    action.args?.index === lastEntry.action.args?.index
  if (isSameAction) {
    return {
      status: 'error',
      history,
      message: `Agent stuck: repeated the same failed action "${action.action}" on index ${action.args?.index}. Aborting.`,
    }
  }
}
```

---

## 5. Hallucination: LLM Calls `done` Too Early

**Symptom:** Agent returns `done` after a single `click` or `input`, before the form is submitted or the task goal is met.

**Root cause:** The model optimistically assumes an action completed the full task.

### Fix A — Strengthen the completion rules in the prompt (`prompt.ts`)

```ts
// Replace vague completion rules with specific criteria
'  DONE RULE A: Only call `done` when the GOAL stated in the task has been fully achieved, ' +
'  not just when a single action was taken.',
'  DONE RULE B: If the task says "fill and submit", you MUST perform BOTH the fill AND the submit ' +
'  before calling `done`.',
'  DONE RULE C: If you just clicked a submit button, wait for a success message or page change ' +
'  to appear in the next observation before calling `done`.',
'  DONE RULE D: If the page still shows an unfilled required field (marked `required` in the elements), ' +
'  do NOT call `done`.',
```

### Fix B — Add post-action observation validation in `Agent.ts`

After a submit/click, re-scan and check for error indicators before allowing `done`:

```ts
// After executing a click action, before processing the LLM's next response
if (action.action === 'click') {
  await new Promise<void>((r) => setTimeout(r, 600))
  const postObs = this.pageController.observe()
  const hasErrors = postObs.elements.some((el) =>
    el.label.toLowerCase().includes('error') ||
    el.label.toLowerCase().includes('invalid') ||
    el.label.toLowerCase().includes('required')
  )
  if (hasErrors) {
    // Inject a synthetic history note so the LLM sees the error
    history.push({
      step,
      observation: postObs.elementsText,
      action,
      result: {
        success: true,
        message: `Clicked element ${action.args?.index}, but validation errors are visible on the page. Task is NOT complete yet.`,
      },
    })
    // Skip to next step without asking the LLM again for done
    continue
  }
}
```

---

## 6. Hallucination: LLM Selects Wrong Dropdown Option

**Symptom:** `doSelect` returns `"No matching option found for 'Active'"` even when the option exists.

**Root causes:**
- LLM returned the option with extra whitespace or casing difference.
- The option has special Unicode characters (Arabic variants, diacritics).
- The option is inside a custom `role="combobox"` element, not a native `<select>`.

### Fix A — Extend `findMatchingOption` with token-level fallback (`actions.ts`)

```ts
function findMatchingOption(value: string, options: string[]): string | undefined {
  const normalizedQuery = normalizeText(value)

  // Pass 1: exact normalized match
  let match = options.find((o) => normalizeText(o) === normalizedQuery)
  if (match) return match

  // Pass 2: bidirectional containment
  match = options.find((o) => {
    const n = normalizeText(o)
    return n.includes(normalizedQuery) || normalizedQuery.includes(n)
  })
  if (match) return match

  // Pass 3: all meaningful words must be present
  match = options.find((o) => containsAllWords(o, value))
  if (match) return match

  // Pass 4: first word of query matches first word of option (prefix heuristic)
  const queryWords = meaningfulWords(value)
  if (queryWords.length > 0) {
    match = options.find((o) => {
      const optWords = meaningfulWords(o)
      return optWords.length > 0 && optWords[0] === queryWords[0]
    })
  }
  return match
}
```

### Fix B — Add filter map section to the prompt (`prompt.ts`)

The existing `buildFilterMap` helper produces a lookup table. Make sure it's always included:

```ts
// In buildInteractionPrompt, inside the user message
const filterMap = buildFilterMap(observation.elements)
const filterSection = filterMap
  ? `\nDropdown option reference (value → element index):\n${filterMap}`
  : ''

const user = [
  `Task: ${task}`,
  `Page: ${observation.title} (${observation.url})`,
  'Interactive elements:',
  observation.elementsText + filterSection,
  // ...
].join('\n\n')
```

### Fix C — Emit available options in the element description (`domScanner.ts`)

Ensure `describeElement` always serializes options for `<select>` and `role="combobox"`:

```ts
// In describeElement() or getLabel() for select elements
if (el instanceof HTMLSelectElement) {
  const options = Array.from(el.options).map((o) => o.text.trim()).filter(Boolean)
  const current = el.options[el.selectedIndex]?.text.trim() ?? ''
  return `FILTER DROPDOWN: ${current || '(none selected)'} | options: [${options.join(', ')}]`
}
```

---

## 7. Hallucination: LLM Invents a `navigate` URL

**Symptom:** LLM navigates to `/dashboard/users` when the correct path is `/admin/users`.

**Root cause:** When `pages` is not provided or the LLM ignores the path list.

### Fix A — Always provide `pages` config and include it in the prompt

```ts
// In mountAgentPanel or AgentConfig
const config: AgentConfig = {
  pages: {
    Dashboard:  { path: '/dashboard', sections: ['Revenue', 'Active Users', 'Growth'] },
    Users:      '/admin/users',
    Settings:   '/admin/settings',
    Reports:    { path: '/reports', subPages: { Monthly: '/reports/monthly', Annual: '/reports/annual' } },
  },
  // ...
}
```

### Fix B — Validate the navigate URL in `normalizeAction` (`tools.ts`)

```ts
// Accept a pages reference in normalizeAction options
export function normalizeAction(
  input: unknown,
  options?: { elementCount?: number; knownPaths?: string[] }
): AgentAction {
  // ... existing logic ...

  if (resolvedAction === 'navigate' && mergedArgs.url && options?.knownPaths) {
    const url = String(mergedArgs.url)
    const isKnown = options.knownPaths.some(
      (p) => url === p || url.startsWith(p + '?') || url.startsWith(p + '/')
    )
    if (!isKnown) {
      throw new Error(
        `Navigate URL "${url}" is not in the known page paths. ` +
        `Allowed: ${options.knownPaths.join(', ')}`
      )
    }
  }
  // ...
}
```

### Fix C — Add a strict navigate rule to the prompt (`prompt.ts`)

```ts
'  NAVIGATE STRICT RULE: The "url" arg for `navigate` MUST be copied EXACTLY from ' +
'  the KNOWN PAGE PATHS list below. Do not invent, shorten, or modify paths. ' +
'  If no path matches the user\'s intent, use scroll or click instead.',
```

---

## 8. Hallucination: LLM Types Wrong Date Format

**Symptom:** Date picker field receives `"2024-06-15"` but expected `"06/15/2024"` — silently rejected.

**Root cause:** `detectDateFormat` in `domScanner.ts` reads the placeholder, but the LLM still guesses.

### Fix A — Enrich the element label with format guidance (`domScanner.ts`)

```ts
// In getLabel / describeElement for date inputs
const fmt = detectDateFormat(el as HTMLInputElement)
if (fmt) {
  return `DATE INPUT (format: ${fmt}): ${labelText}`
}
```

### Fix B — Add a date format rule to the system prompt (`prompt.ts`)

```ts
'  DATE FORMAT RULE: For any element labelled "DATE INPUT (format: X)", the "text" arg ' +
'  MUST match format X exactly. Examples: ' +
'  format MM/DD/YYYY → "06/15/2024", format DD-MM-YYYY → "15-06-2024", ' +
'  format YYYY-MM-DD → "2024-06-15". Never use a different separator or order.',
```

### Fix C — Add runtime format validation in `doInput` (`actions.ts`)

```ts
function validateDateText(text: string, format: string): boolean {
  // Build a regex from the format string
  const regexStr = format
    .replace(/YYYY/g, '\\d{4}')
    .replace(/MM/g, '\\d{2}')
    .replace(/DD/g, '\\d{2}')
    .replace(/[-/.]/g, (sep) => `\\${sep}`)
  return new RegExp(`^${regexStr}$`).test(text)
}

// In doInput, before setting the value:
const placeholder = (el as HTMLInputElement).placeholder ?? ''
const detectedFmt = detectDateFormatFromPlaceholder(placeholder)
if (detectedFmt && !validateDateText(text, detectedFmt)) {
  return {
    success: false,
    message: `Date text "${text}" does not match required format "${detectedFmt}". Please re-format.`,
  }
}
```

---

## 9. Hallucination: LLM Interacts with Elements Behind a Modal

**Symptom:** Agent clicks a background button that is visually dimmed by a modal overlay.

**Root cause:** `findOpenModal` didn't detect the modal, so all elements were shown without the `[MODAL]` prefix.

### Fix A — Expand modal detection in `domScanner.ts`

```ts
function findOpenModal(doc: Document): Element | null {
  // Existing ARIA + class detection ...

  // Add: detect by computed z-index (modals often have very high z-index)
  const highZCandidates = Array.from(
    doc.querySelectorAll('[class*="overlay"], [class*="backdrop"], [class*="modal"]')
  ).filter((el) => {
    const z = parseInt(window.getComputedStyle(el as HTMLElement).zIndex ?? '0', 10)
    return z > 100 && isVisible(el as HTMLElement, window)
  })
  if (highZCandidates.length > 0) {
    // Return the candidate with highest z-index
    return highZCandidates.sort((a, b) => {
      const za = parseInt(window.getComputedStyle(a as HTMLElement).zIndex, 10)
      const zb = parseInt(window.getComputedStyle(b as HTMLElement).zIndex, 10)
      return zb - za
    })[0]
  }

  return null
}
```

### Fix B — Add an escape hatch for modal dismiss (`prompt.ts`)

```ts
'  MODAL CLOSE RULE: If [MODAL] elements are visible but none help complete the task, ' +
'  look for a [MODAL] close button (labelled "Close", "✕", "Cancel", "Dismiss") and click it ' +
'  before interacting with the background page.',
```

---

## 10. Hallucination: JSON Truncation / Parse Failures

**Symptom:** `Failed to parse LLM JSON response` — the model's output was cut off mid-JSON.

**Root cause:** `maxTokens` is too low, or the model generates verbose reasoning before the JSON.

### Fix A — Set appropriate `maxTokens` per model size (`LLMConfig`)

| Model type | Recommended `maxTokens` |
|---|---|
| GPT-4o / Claude via proxy | 300–500 |
| Groq (Llama 70B) | 400–600 |
| Local Llama 7B–14B | 600–900 (smaller models tend to be verbose) |
| Qwen / Mistral | 400–600 |

```ts
// In AgentConfig
maxTokens: 512,
```

### Fix B — Detect truncation via `finish_reason` and surface a clear error (`OpenAIClient.ts`)

The `finish_reason === 'length'` check is already in the codebase. Make sure it's wired:

```ts
const finishReason = data.choices?.[0]?.finish_reason
if (finishReason === 'length') {
  throw new Error(
    `LLM response was truncated (finish_reason: length). ` +
    `Increase maxTokens (current: ${this.config.maxTokens ?? 'unlimited'}) ` +
    `or simplify the prompt.`
  )
}
```

### Fix C — Use an output primer that forces JSON first (`prompt.ts`)

Move the JSON primer to guarantee the model starts outputting JSON immediately:

```ts
// System message — add at the very end:
'OUTPUT: Respond with ONLY the JSON object. Start your response with { and end with }. ' +
'No preamble. No explanation. No markdown. No comments.',

// User message — replace 'Your JSON action:' with:
'JSON:'
```

---

## 11. Hallucination: Arabic Text Not Matching Options or Sections

**Symptom:** `select` action fails for an Arabic dropdown option; section scroll fails for an Arabic section name.

**Root cause:** `normalizeArabic` in `text.ts` handles diacritics but might miss some letter normalization edge cases.

### Fix A — Extend `normalizeArabic` (`text.ts`)

```ts
function normalizeArabic(s: string): string {
  return s
    .replace(/[\u064B-\u065F\u0670]/g, '')  // harakat / diacritics
    .replace(/\u0640/g, '')                   // tatweel
    .replace(/[أإآٱ]/g, 'ا')                 // alef variants → bare alef
    .replace(/ة/g, 'ه')                       // teh marbuta → heh
    .replace(/ى/g, 'ي')                       // alef maqsura → yeh
    .replace(/\u0643/g, '\u06A9')             // Arabic kaf → extended kaf (optional, for Persian overlap)
    .replace(/\u06CC/g, '\u064A')             // Farsi yeh → Arabic yeh
    .replace(/\s+/g, ' ')                     // collapse whitespace inside
    .trim()
}
```

### Fix B — Add Arabic option test to `findMatchingOption` (`actions.ts`)

```ts
// Pass 5 in findMatchingOption: try normalizeArabic on both sides directly
import { normalizeArabic } from '../core/text'  // export this from text.ts

match = options.find((o) => normalizeArabic(o) === normalizeArabic(value))
```

---

## 12. Enhancement: Batch Actions (Reduce API Calls)

The LLM client already supports `AgentAction[]` batches. To get the model to USE batching:

### Update the system prompt to encourage batching (`prompt.ts`)

```ts
// In buildInteractionPrompt system message, add:
'BATCHING: When you are confident about multiple sequential actions (e.g. select a filter, ' +
'then select another filter, then call done), return them ALL in a single JSON array: ' +
'[{"action":"select","args":{"index":3,"value":"Active"}}, ' +
' {"action":"select","args":{"index":5,"value":"Mining"}}, ' +
' {"action":"done","args":{"result":"Filters applied"}}] ' +
'Only batch actions you are certain about. If uncertain, return a single action.',
```

### Validate batches in `normalizeActions` (`tools.ts`)

The existing function handles three shapes. Make sure errors in one batch item don't silently skip the others:

```ts
export function normalizeActions(input: unknown): AgentAction[] {
  if (Array.isArray(input)) {
    const results: AgentAction[] = []
    for (let i = 0; i < input.length; i++) {
      try {
        results.push(normalizeAction(input[i]))
      } catch (err) {
        throw new Error(`Batch action[${i}] is invalid: ${(err as Error).message}`)
      }
    }
    return results
  }
  // ... rest unchanged
}
```

---

## 13. Enhancement: Two-Phase Flow (Navigate then Interact)

When `twoPhase: true` and `pages` is provided, Phase 1 uses `buildNavigationPrompt` (no DOM elements — just a list of pages) and Phase 2 uses `buildInteractionPrompt` (full DOM scan).

### Correct `buildNavigationPrompt` template (`prompt.ts`)

```ts
export function buildNavigationPrompt(
  task: string,
  pages: Record<string, string | PageDescriptor>,
  currentUrl?: string,
): ChatMessage[] {
  const pathLines = formatPagePaths(pages)
  const system = [
    'You are a navigation agent. Your ONLY job is to decide which page to navigate to.',
    'Output a single JSON: {"thought":"<why>","action":"navigate","args":{"url":"<exact path>"}}',
    'Rules:',
    '  1. Pick the page that best matches the task.',
    '  2. Use ONLY paths from the list below — no invented URLs.',
    '  3. If already on the correct page, output: {"action":"done","args":{"result":"Already on correct page"}}',
    `Current URL: ${currentUrl ?? '(unknown)'}`,
    `Known pages:\n${pathLines}`,
  ].join('\n')

  const user = `Task: ${task}\n\nYour navigation JSON:`

  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}
```

---

## 14. Enhancement: `confirmAction` Safety Gate Pattern

Use `confirmAction` to block dangerous actions in production:

```ts
mountAgentPanel({
  // ...
  confirmAction: async (action) => {
    // Block all navigate actions to external domains
    if (action.action === 'navigate') {
      const url = action.args?.url ?? ''
      if (url.startsWith('http') && !url.includes(location.hostname)) {
        console.warn(`[Agent] Blocked external navigate: ${url}`)
        return false
      }
    }
    // Block clicks on elements labelled as delete/danger
    if (action.action === 'click') {
      // Optionally read from elementMap via a shared reference
      return window.confirm(`Allow agent to: ${action.action} index ${action.args?.index}?`)
    }
    return true
  },
})
```

---

## 15. Prompt Template: System Message Checklist

Every call to `buildInteractionPrompt` should produce a system message that covers all of these:

```
[ ] Role declaration:       "You are a browser page agent..."
[ ] Output format:          Schema with thought/action/args
[ ] Action vocabulary:      All 10 actions with required args
[ ] Index rules:            Must use index from list; never invent
[ ] Done rules:             Only when task goal is FULLY complete
[ ] Section rules:          SECTION: elements are scroll-only
[ ] Filter / search rules:  FILTER DROPDOWN vs SEARCH BOX distinction
[ ] Modal rules:            Only interact with [MODAL] elements when modal is open
[ ] Navigation rules:       Only use exact paths from KNOWN PAGE PATHS (when pages provided)
[ ] Batch encouragement:    Return array when confident about multiple steps
[ ] Date format rule:       Match the format shown in the label
[ ] Retry rule:             Do not repeat a ✗ FAILED action
[ ] Output primer:          "Start with { end with } — no preamble"
```

---

## 16. Testing Hallucination Fixes

For each fix, write a test that feeds a malformed LLM response through `normalizeAction` or `normalizeActions` and asserts the corrected output:

```ts
// tools.test.ts

test('synonym: tap → click', () => {
  const result = normalizeAction({ action: 'tap', args: { index: 3 } })
  expect(result.action).toBe('click')
})

test('flat-args recovery: index at top level', () => {
  const result = normalizeAction({ action: 'click', index: 5 })
  expect(result.args?.index).toBe(5)
})

test('thought-based index recovery', () => {
  const result = normalizeAction({
    action: 'click',
    thought: 'I will click element [7] to proceed',
  })
  expect(result.args?.index).toBe(7)
})

test('batch: array of actions', () => {
  const results = normalizeActions([
    { action: 'select', args: { index: 2, value: 'Active' } },
    { action: 'done', args: { result: 'Done' } },
  ])
  expect(results).toHaveLength(2)
  expect(results[0].action).toBe('select')
  expect(results[1].action).toBe('done')
})

test('Arabic option matching', () => {
  const match = findMatchingOption('الطلبات', ['الطَّلَبَات', 'المشاريع'])
  expect(match).toBe('الطَّلَبَات')
})
```

---

## File-to-Fix Matrix (Quick Reference)

| File | What to change | Hallucination it fixes |
|---|---|---|
| `src/core/prompt.ts` | Add/strengthen rules in system message | #1 action name, #3 section click, #5 early done, #7 navigate URL, #8 date format, #9 modal, #10 truncation |
| `src/core/tools.ts` | Synonym map, index range check, extended thought recovery | #1 action name, #2 bad index, #12 batch validation |
| `src/core/Agent.ts` | Retry-loop guard, post-submit error check | #4 repeat failures, #5 early done |
| `src/core/text.ts` | Extend `normalizeArabic`, export it | #11 Arabic matching |
| `src/page-controller/actions.ts` | Extended `findMatchingOption`, date format validation | #6 dropdown option, #8 date format |
| `src/page-controller/domScanner.ts` | Richer labels (date format, options list), z-index modal detection | #6 dropdown option, #8 date format, #9 modal |
| `src/llm/OpenAIClient.ts` | `finish_reason` truncation error, `jsonMode`, `maxTokens` | #10 JSON truncation |
