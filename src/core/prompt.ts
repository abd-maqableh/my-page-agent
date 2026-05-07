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

export function buildPrompt(task: string, observation: PageObservation, history: AgentHistoryEntry[]): ChatMessage[] {
  const system = [
    'You are a browser page agent.',
    'Choose exactly one next action to progress the task safely.',
    'Respond with valid JSON only using this shape:',
    '{"thought":"short reasoning","action":"click|input|select|scroll|wait|done","args":{...}}',
    'Use numeric index from the observed elements list.',
    'Use done when the task is completed.',
  ].join(' ')

  const user = [
    `Task: ${task}`,
    `Page: ${observation.title} (${observation.url})`,
    'Interactive elements:',
    observation.elementsText || '(none found)',
    'History:',
    formatHistory(history),
  ].join('\n\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}
