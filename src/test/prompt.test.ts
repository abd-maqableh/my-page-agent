import { describe, expect, it } from 'vitest'
import { buildPrompt } from '../core/prompt'
import type { PageObservation } from '../core/types'

const observation: PageObservation = {
  url: 'http://localhost:8080/applications',
  title: 'Applications',
  elements: [
    {
      index: 1,
      tag: 'button',
      role: null,
      type: null,
      label: 'Refresh Applications List',
      kind: 'interactive',
      description: 'Utility action to reload the applications list',
    },
    {
      index: 2,
      tag: 'div',
      role: 'combobox',
      type: null,
      label: 'Status',
      kind: 'interactive',
      description:
        'Filter dropdown. Current value: All Statuses. Options: New Request, Sent, Rejected.',
    },
  ],
  elementsText: '',
}

describe('buildPrompt', () => {
  it('includes minimal action and return-format instructions', () => {
    const [systemMessage] = buildPrompt('show sent applications', observation)

    expect(systemMessage.content).toContain('You are a browser page agent.')
    expect(systemMessage.content).toContain('Available actions and required args:')
    expect(systemMessage.content).toContain('- click: {"index": number}')
    expect(systemMessage.content).toContain('- done: {"result": string}')
    expect(systemMessage.content).toContain('Return ONLY one JSON object')
    expect(systemMessage.content).toContain('"actions"')
    expect(systemMessage.content).toContain('Runtime context (changes every request):')
    expect(systemMessage.content).toContain('Current DOM scanner output (raw):')
    expect(systemMessage.content).toContain('Current DOM elements (JSON):')
  })

  it('includes DOM elements as JSON with labels and descriptions in system', () => {
    const [systemMessage] = buildPrompt('show sent applications', observation)

    expect(systemMessage.content).toContain('"label": "Status"')
    expect(systemMessage.content).toContain('"description": "Filter dropdown. Current value: All Statuses. Options: New Request, Sent, Rejected."')
  })

  it('includes known page paths only when provided', () => {
    const [withoutPages] = buildPrompt('go to users', observation)
    const [withPages] = buildPrompt('go to users', observation, {
      Users: '/dashboard/user/list',
      Orders: '/dashboard/order',
      Settings: {
        path: '/dashboard/settings',
        subPages: {
          Profile: '/dashboard/settings/profile',
        },
      },
    })

    expect(withoutPages.content).not.toContain('Known page paths (for navigate):')
    expect(withPages.content).toContain('Known page paths (for navigate):')
    expect(withPages.content).toContain('Users -> /dashboard/user/list')
    expect(withPages.content).toContain('Profile -> /dashboard/settings/profile')
  })
})
