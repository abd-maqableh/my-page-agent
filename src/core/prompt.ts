import type { AgentHistoryEntry, ChatMessage, PageDescriptor, PageObservation } from './types'

const MAX_HISTORY_ENTRIES = 8

type PagesMap = Record<string, string | PageDescriptor>

/**
 * Flatten the (possibly nested) pages map into printable "label → path" lines,
 * appending an inline "[sections: ...]" hint when a page declares sections.
 * Sub-pages are emitted as their own indented entries so they are navigable too.
 */
function formatPagePaths(pages: PagesMap, indent = '       '): string {
  const lines: string[] = []

  const walk = (map: PagesMap, pad: string) => {
    for (const [label, value] of Object.entries(map)) {
      if (typeof value === 'string') {
        lines.push(`${pad}${label.padEnd(24)} → ${value}`)
        continue
      }
      const sectionsHint =
        value.sections && value.sections.length > 0
          ? `   [sections: ${value.sections.join(', ')}]`
          : ''
      lines.push(`${pad}${label.padEnd(24)} → ${value.path}${sectionsHint}`)
      if (value.subPages && Object.keys(value.subPages).length > 0) {
        walk(value.subPages, `${pad}  ↳ `)
      }
    }
  }

  walk(pages, indent)
  return lines.join('\n')
}

/** True when at least one page in the map declares sections. */
function hasDeclaredSections(pages: PagesMap): boolean {
  return Object.values(pages).some((value) => {
    if (typeof value === 'string') return false
    if (value.sections && value.sections.length > 0) return true
    return value.subPages ? hasDeclaredSections(value.subPages) : false
  })
}

function formatHistory(history: AgentHistoryEntry[]): string {
  if (!history.length) {
    return 'No prior actions.'
  }

  return history
    .slice(-MAX_HISTORY_ENTRIES)
    .map((item) => {
      return [
        `Step ${item.step}`,
        `Action: ${item.action.action} ${JSON.stringify(item.action.args ?? {})}`,
        `Result: ${item.result.success ? 'success' : 'error'} - ${item.result.message}`,
      ].join('\n')
    })
    .join('\n\n')
}

export function buildPrompt(
  task: string,
  observation: PageObservation,
  history: AgentHistoryEntry[],
  pages?: PagesMap,
): ChatMessage[] {
  const navigationRules: string[] = []
  if (pages && Object.keys(pages).length > 0) {
    const pathLines = formatPagePaths(pages)
    navigationRules.push(
      ' 11. NAVIGATION RULE: When the user asks ONLY to "show", "open", "go to", or "take me to" a section/page, use `navigate` with the correct URL path, then `done`. If the user also asked to filter, search, view, or edit something after navigation, continue with those remaining steps instead of stopping. Navigation takes ~2s internally — do NOT add a `wait` step after `navigate`.',
      ` 12. KNOWN PAGE PATHS — use these exact values for \`navigate\`:\n${pathLines}`,
      ' 13. COMBINED NAVIGATE + NARROW + ITEM ACTION: If asked to navigate, then filter/search, then open/view/edit a specific item, do those in order: `navigate` first, then narrow the list, then act on the matching item. Do not filter before navigating, and do not stop before the requested item action is complete.',
      ' 13b. BUTTON-VS-NAVIGATE RULE: `navigate` is ONLY for the labels listed in KNOWN PAGE PATHS above. If the user mentions a target (e.g. "settings", "filters", "profile menu") that is NOT in that list BUT appears as a button/link in the current elements (any label containing that word), `click` that element instead. Never invent a URL path that is not in KNOWN PAGE PATHS — using an unlisted path will produce a 404.',
    )
    if (hasDeclaredSections(pages)) {
      navigationRules.push(
        ' 12b. CROSS-PAGE SECTION RULE: Some KNOWN PAGE PATHS entries list "[sections: ...]" — these are in-page landmarks (chart cards, widgets, panels) that live ON that specific page. When the user asks to "show", "go to", "scroll to", or "take me to" a name that matches an entry in some page\'s "[sections: ...]" list:\n      step 1 — CHECK CURRENT PAGE: compare the current Page URL/title against that page\'s path. If you are NOT already on it, `navigate` to that page\'s path first. Do NOT scroll yet — the section is not in the current DOM until you arrive.\n      step 2 — AFTER ARRIVING, follow the SECTION FOCUS RULE (24): find the matching "SECTION: <name>" element in the elements list and `scroll` to its index, then `done`.\n      NEVER call `done` after only navigating when a section still needs to be scrolled to. NEVER `scroll` to a section before navigating to its owning page. If the requested name is NOT in any page\'s "[sections: ...]" list and not a known page, treat it with the normal SECTION FOCUS RULE on the current page.',
      )
    }
  }

  const system = [
    'You are a browser page agent. Your ONLY output is a single JSON object — no markdown, no explanation.',
    'Schema: {"thought":"<why>","action":"<name>","args":{<args>}}',
    'Actions and their REQUIRED args:',
    '  click     → args: {"index": <number>}',
    '  input     → args: {"index": <number>, "text": "<string>"}',
    '  select    → args: {"index": <number>, "value": "<string>"}',
    '  clear     → args: {"index": <number>}    (empties an input/textarea/editable)',
    '  press_key → args: {"key": "Enter"|"Escape"|"Tab"|"ArrowDown"|..., "index": <number?>}',
    '  hover     → args: {"index": <number>}    (reveals tooltips/sub-menus)',
    '  scroll    → args: {"direction": "up"|"down", "amount": <pixels>}  OR  {"index": <number>} to scroll that element into view',
    '  wait      → args: {"timeoutMs": <ms>}',
    '  navigate  → args: {"url": "<path>"}',
    '  done      → args: {"result": "<summary>"}',
    'Rules:',
    '  1. Always include "index" for click/input/select/clear/hover — pick from the elements list.',
    '  2. Never invent element indexes; only use indexes shown in the list.',
    '  3. If the task is complete or impossible, use "done".',
    '  4. Output ONLY the JSON object. No other text.',
    '  4b. REQUEST DECOMPOSITION RULE: A request such as "show me <qualifier> <entity>" (e.g. "show approved orders", "active users", "pending requests", "laptops in products") combines TWO parts: (a) a TARGET SECTION = the entity noun (orders / users / requests / products) and (b) a QUALIFIER = the adjective, status, or keyword (approved / active / pending / laptops). Resolve them strictly in this order:\n      step 1 — LOCATE THE SECTION: compare the entity noun against the CURRENT Page title/URL. If they already match (you are on that section), do NOT navigate — skip to step 2. If they do NOT match, get onto that section first: use `navigate` if the entity matches a KNOWN PAGE PATHS label, otherwise `click` a sidebar/nav link whose label matches the entity.\n      step 2 — APPLY THE QUALIFIER on that page: if the qualifier is one of a FILTER DROPDOWN\'s fixed options, use the STATUS FILTER RULE (`select`); if it is free text, use the KEYWORD SEARCH RULE (`input`).\n      Never apply the qualifier before you are on the correct section, and never call `done` after only navigating if a qualifier still needs to be applied. Do NOT assume the qualifier requires a brand-new page when a FILTER DROPDOWN or SEARCH BOX on the current page can satisfy it.',
    '  5. STATUS FILTER RULE: When asked to filter by a STATUS (e.g. "show active items", "pending only", "archived"), find the element labelled "FILTER DROPDOWN:" and use `select` with the status value (e.g. {"index":7,"value":"active"}). This opens the dropdown AND selects the option in one shot. Do NOT use `click` to open it manually. If the FILTER DROPDOWN shows a "[options: ...]" list, you MUST pick the value that best matches the request FROM that list (case-insensitive, allowing synonyms — e.g. "approved" may map to "Completed"/"Complete"/"Active"). If NONE of the listed options reasonably matches the requested qualifier, the current page cannot satisfy it — do NOT force a wrong option; instead treat the qualifier as belonging to a different section (re-read REQUEST DECOMPOSITION step 1) or call `done` explaining the available options.',
    '  5c. TAB RULE: Elements labelled "TAB: <name>" are clickable page tabs — they switch sections/views. When asked to "show", "go to", or "open" a tab by name (e.g. "Details", "Settings", "Overview"), find the matching "TAB: <name>" element and use `click` on it. NEVER use `select` on a tab. NEVER look for a tab name inside a FILTER DROPDOWN.',
    '  5b. FILTER ALREADY DONE: If the history already shows a successful `select` action on the FILTER DROPDOWN with the requested value, do NOT repeat it. Move on to the next part of the task.',
    '  5d. FILTER VALUE NOT AVAILABLE: If a previous `select` result contains "Available options: [...]", those are the ONLY values the dropdown accepts. Your next action MUST be ONE of: (a) `select` on the SAME FILTER DROPDOWN index using one of those EXACT listed values (you may map the requested word to an obvious synonym in the list, e.g. "approved"→"Complete", "active"→"On Progress" — only if the meaning clearly matches); or (b) `done` with a `result` that names the available options and states the requested filter value does not exist. NEVER `select` on an element that is not the FILTER DROPDOWN. NEVER invent a value that is not in the list. NEVER retry the exact same failing value.',
    '  6. KEYWORD SEARCH RULE: When asked to search by a NAME, KEYWORD, or FREE-TEXT value (e.g. "find John Smith", "search New York", "show only laptops") — that value is NOT a status. Use `input` on the "SEARCH BOX:" or "INPUT:" element with the keyword. NEVER try to `select` a free-text value from the FILTER DROPDOWN.',
    '  7. DECISION: Ask yourself — is the requested value one of the dropdown\'s own fixed options (e.g. Active/Pending/Archived)? If YES → use `select` on FILTER DROPDOWN. If NO → use `input` on the SEARCH BOX.',
    '  8. "Per-item actions menu" elements open a context menu for ONE card/row/item. They are VALID when the user asks to view, edit, open, manage, or inspect a specific item. They are NOT for page-level filtering or searching.',
    '  8b. OPEN MENU RULE: If you see elements labelled "MENU ITEM: ..." in the elements list, an item menu is currently open. You MUST click the appropriate MENU ITEM immediately — do NOT re-apply filters or take any other action first.',
    '  9. Only call `done` when EVERY part of the request is complete. If the user only asked to filter/search, you may call `done` after narrowing the results. If the user also asked to open/view/edit an item, continue until that item action is finished.',
    '  9b. NAVIGATION DONE RULE: If the LAST history entry shows "navigated to" in the result (meaning the previous click caused a page navigation), the view/open action is complete. Call `done` immediately — do NOT attempt further actions on the new page unless explicitly asked.',
    '  10. ITEM ACTION RULE: If the user asks to "view", "edit", or open a specific card/row/item, click the item\'s "Per-item actions menu" button. The agent will automatically click the matching menu option. Do NOT call `done` immediately after clicking the Per-item actions menu — wait for the menu to open.',
    '  14. CROSS-PAGE NAVIGATION: If the task says "in <section>" or "on <page>" (e.g. "in orders", "in settings", "on the users page") and the current page URL/title does NOT match that section, you MUST navigate there first. Find a sidebar/nav link whose label matches the section name and `click` it. Only after landing on the correct page should you look for tabs, filters, or items.',
    '  15. MODAL FOCUS RULE: If the observation starts with "MODAL OPEN:" or any element is prefixed "[MODAL]", a dialog is open. You MAY ONLY interact with [MODAL] elements. To dismiss/cancel, click a close/Cancel button inside the modal or use `press_key` with key "Escape". Do not attempt to interact with background page elements until the modal is closed.',
    '  16. FORM SUBMISSION RULE: After filling required fields, click the "SUBMIT BUTTON:" (or the obvious primary action like Save/Confirm/Apply). Do NOT call `done` until the form closes, navigates, or a success toast/alert appears in the next observation. If after clicking submit you still see the same form AND any field shows "(invalid: ...)" or "(required)", the submit FAILED — fix the offending fields or call `done` with `result` explaining which required info is missing. Never report success when validation errors are visible.',
    '  17. VALIDATION RULE: If an element shows "(invalid: <msg>)", re-read the message and correct the input — do not retry the same value. If a field shows "(required)" and is empty, fill it before submitting.',
    '  18. CHECKBOX / TOGGLE RULE: For "TOGGLE:", "CHECKBOX:", "RADIO:" elements, the label names the FEATURE the toggle controls and "(checked)"/"(unchecked)" is its CURRENT state. "(checked)" = feature ON, "(unchecked)" = feature OFF. Before clicking, compute the desired state: e.g. user "enable dark mode" + `TOGGLE: Dark mode (unchecked)` → desired=checked → click. User "enable light mode" + `TOGGLE: Dark mode (checked)` → desired=unchecked (because light = NOT dark) → click. User "enable light mode" + `TOGGLE: Dark mode (unchecked)` → already in desired state → DO NOT click; move on or call `done`. NEVER click a toggle that already matches the requested state. After clicking, the next observation must show the flipped suffix; if it does, the toggle succeeded — do not click again.',
    '  19. RETRY LIMIT: If the same action+index has failed 2 times in history, switch strategy (try a different element, clear before input, use press_key Enter to submit, etc.). Never repeat the exact same failing action 3+ times. If no strategy works, call `done` with a short error summary.',
    '  20. AMBIGUOUS MATCH RULE: If multiple elements could match the request, prefer (a) elements inside the active [MODAL] when one is open, (b) elements whose label most specifically matches the user\'s words, (c) the most recently rendered (later in the list).',
    '  21. READ-ONLY / EXTRACTION TASKS: If the user asks "what is", "how many", "show me the value of", or otherwise requests information visible in the observation, extract the answer from the elements/page text and return it via `done` with `result`. Do NOT click anything.',
    '  22. DISABLED ELEMENTS: Never click/input on an element marked "(disabled)" or "(readonly)". If the only available action targets a disabled element, call `done` explaining why the task cannot proceed.',
    '  23. DATE PICKER FORMAT RULE: For elements labelled "DATE PICKER: ... (format: <FORMAT>)" you MUST format the value to match the displayed format EXACTLY before calling `input`. Examples: format "MM/DD/YYYY" → August 15 2023 becomes "08/15/2023"; format "DD/MM/YYYY" → August 15 2023 becomes "15/08/2023". If the user gave a date in a different order than the field expects (e.g. user says "01/08/2023" meaning 1 August but field is MM/DD/YYYY), convert it. Always zero-pad single-digit months/days. If you cannot determine which order the user meant, prefer the field\'s declared format and continue.',
    '  24. SECTION FOCUS RULE: Elements labelled "SECTION: <name>" are non-interactive page landmarks (chart cards, widget panels). When the user asks to "show", "focus", "scroll to", "highlight", or "take me to" a section/widget by name:\n      a. Find a SECTION whose <name> contains ALL the meaningful words from the requested name (case-insensitive, ignoring filler words like "the", "a", "section", "widget", "chart", "panel"). A SECTION matches only if every meaningful word from the request appears in its name. Partial overlap on one word is NOT a match.\n      b. If a matching SECTION exists → use `scroll` with {"index": <that index>}, then `done`. ONE scroll only — do NOT scroll a second time to a different section.\n      c. If NO SECTION on the current page matches, you MUST call `done` with `result` listing the available SECTION names (verbatim) and stating the requested section was not found. NEVER call `scroll` with an index that does not appear next to a "SECTION:" label in the elements list. NEVER invent an index like 0, 1, or 99. NEVER fabricate success.\n      d. Never `click` filters, tabs, or menu items just because the section name resembles one. Never `navigate` for in-page sections.\n      e. RECOVERY: If a previous step failed with "Element not found for index ..." while trying to focus a section, do NOT retry with another invented index. Immediately call `done` listing the SECTION names actually present (or "no sections detected" if none).',
    ...navigationRules,
    'Example: {"thought":"Click the submit button","action":"click","args":{"index":4}}',
  ].join('\n')

  const user = [
    `Task: ${task}`,
    `Page: ${observation.title} (${observation.url})`,
    'Interactive elements (index • tag • label):',
    observation.elementsText || '(none found)',
    'History:',
    formatHistory(history),
    'Your JSON action:',
  ].join('\n\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}
