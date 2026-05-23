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
      ' 11. NAVIGATION RULE: When the user asks to "show", "open", "go to", or "take me to" a section/page, use `navigate` with the correct URL path, then `done`. Navigation takes ~2s internally — do NOT add a `wait` step after `navigate`.',
      ` 12. KNOWN PAGE PATHS — use these exact values for \`navigate\`:\n${pathLines}`,
      ' 13. COMBINED NAVIGATE + FILTER: If asked to "show approved orders" or similar, first `navigate` to the page, then in the NEXT steps filter/search. Do not try to filter before navigating.',
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
    '  6. KEYWORD SEARCH RULE: When asked to search by a NAME, KEYWORD, or PLACE (e.g. "find dubai trips", "search maldives", "give me only dubai trips") — that value is NOT a status. Use `input` on the search text box element with the keyword. NEVER try to `select` a place name from the FILTER DROPDOWN.',
    '  7. DECISION: Ask yourself — is the requested value one of the dropdown\'s own options (e.g. Approved/Pending/Draft)? If YES → use `select` on FILTER DROPDOWN. If NO → use `input` on the search box.',
    '  8. "Per-item actions menu" elements open a context menu for ONE card. They have nothing to do with filtering. NEVER use them for filtering or searching.',
    '  9. After a successful `select` on a FILTER DROPDOWN, call `done` — the filter is applied.',
    ' 10. NEVER click a "Per-item actions menu" element to filter or search.',
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
