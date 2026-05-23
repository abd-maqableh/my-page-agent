import type { AgentHistoryEntry, ChatMessage, PageObservation } from './types'

const MAX_HISTORY_ENTRIES = 8

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
  pages?: Record<string, string>,
): ChatMessage[] {
  const navigationRules: string[] = []
  if (pages && Object.keys(pages).length > 0) {
    const pathLines = Object.entries(pages)
      .map(([label, path]) => `       ${label.padEnd(24)} → ${path}`)
      .join('\n')
    navigationRules.push(
      ' 11. NAVIGATION RULE: When the user asks ONLY to "show", "open", "go to", or "take me to" a section/page, use `navigate` with the correct URL path, then `done`. If the user also asked to filter, search, view, or edit something after navigation, continue with those remaining steps instead of stopping. Navigation takes ~2s internally — do NOT add a `wait` step after `navigate`.',
      ` 12. KNOWN PAGE PATHS — use these exact values for \`navigate\`:\n${pathLines}`,
      ' 13. COMBINED NAVIGATE + NARROW + ITEM ACTION: If asked to navigate, then filter/search, then open/view/edit a specific item, do those in order: `navigate` first, then narrow the list, then act on the matching item. Do not filter before navigating, and do not stop before the requested item action is complete.',
    )
  }

  const system = [
    'You are a browser page agent. Your ONLY output is a single JSON object — no markdown, no explanation.',
    'Schema: {"thought":"<why>","action":"<name>","args":{<args>}}',
    'Actions and their REQUIRED args:',
    '  click    → args: {"index": <number>}',
    '  input    → args: {"index": <number>, "text": "<string>"}',
    '  select   → args: {"index": <number>, "value": "<string>"}',
    '  scroll   → args: {"direction": "up"|"down", "amount": <pixels>}',
    '  wait     → args: {"timeoutMs": <ms>}',
    '  navigate → args: {"url": "<path>"}',
    '  done     → args: {"result": "<summary>"}',
    'Rules:',
    '  1. Always include "index" for click/input/select — pick from the elements list.',
    '  2. Never invent element indexes; only use indexes shown in the list.',
    '  3. If the task is complete or impossible, use "done".',
    '  4. Output ONLY the JSON object. No other text.',
    '  5. STATUS FILTER RULE: When asked to filter by a STATUS (e.g. "show approved trips", "pending only", "draft"), find the element labelled "FILTER DROPDOWN:" and use `select` with the status value (e.g. {"index":7,"value":"approved"}). This opens the dropdown AND selects the option in one shot. Do NOT use `click` to open it manually.',
    '  5b. FILTER ALREADY DONE: If the history already shows a successful `select` action on the FILTER DROPDOWN with the requested value, do NOT repeat it. Move on to the next part of the task.',
    '  6. KEYWORD SEARCH RULE: When asked to search by a NAME, KEYWORD, or PLACE (e.g. "find dubai trips", "search maldives", "give me only dubai trips") — that value is NOT a status. Use `input` on the search text box element with the keyword. NEVER try to `select` a place name from the FILTER DROPDOWN.',
    '  7. DECISION: Ask yourself — is the requested value one of the dropdown\'s own options (e.g. Approved/Pending/Draft)? If YES → use `select` on FILTER DROPDOWN. If NO → use `input` on the search box.',
    '  8. "Per-item actions menu" elements open a context menu for ONE card/row/item. They are VALID when the user asks to view, edit, open, manage, or inspect a specific item. They are NOT for page-level filtering or searching.',
    '  8b. OPEN MENU RULE: If you see elements labelled "MENU ITEM: View", "MENU ITEM: Edit", etc. in the elements list, an item menu is currently open. You MUST click the appropriate MENU ITEM immediately — do NOT re-apply filters or take any other action first.',
    '  9. Only call `done` when EVERY part of the request is complete. If the user only asked to filter/search, you may call `done` after narrowing the results. If the user also asked to open/view/edit an item, continue until that item action is finished.',
    '  9b. NAVIGATION DONE RULE: If the LAST history entry shows "navigated to" in the result (meaning the previous click caused a page navigation), the view/open action is complete. Call `done` immediately — do NOT attempt further actions on the new page unless explicitly asked.',
    '  10. ITEM ACTION RULE: If the user asks to "view", "edit", or open a specific card/row/item, click the item\'s "Per-item actions menu" button. The agent will automatically click the matching menu option. Do NOT call `done` immediately after clicking the Per-item actions menu — wait for the menu to open.',
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
