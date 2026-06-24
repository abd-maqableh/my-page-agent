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
  elementsText: JSON.stringify([
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
  ], null, 2),
}

describe('buildPrompt', () => {
  it('returns system + user messages', () => {
    const messages = buildPrompt('show sent applications', observation)
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('system')
    expect(messages[1].role).toBe('user')
  })

  it('includes agent identity in system prompt', () => {
    const [systemMessage] = buildPrompt('show sent applications', observation)
    expect(systemMessage.content).toContain('browser page agent')
    expect(systemMessage.content).toContain('PHASE 2')
  })

  it('includes action descriptions in system prompt', () => {
    const [systemMessage] = buildPrompt('show sent applications', observation)
    expect(systemMessage.content).toContain('`click')
    expect(systemMessage.content).toContain('`done')
    expect(systemMessage.content).toContain('`select')
    expect(systemMessage.content).toContain('`input')
  })

  it('includes retry rule in system prompt', () => {
    const [systemMessage] = buildPrompt('show sent applications', observation)
    expect(systemMessage.content).toContain('RETRY')
    expect(systemMessage.content).toContain('completely different')
  })

  it('includes batching instruction in system prompt', () => {
    const [systemMessage] = buildPrompt('show sent applications', observation)
    expect(systemMessage.content).toContain('BATCHING')
  })

  it('includes DOM elements in user message', () => {
    const [, userMessage] = buildPrompt('show sent applications', observation)
    expect(userMessage.content).toContain('PAGE ELEMENTS')
    expect(userMessage.content).toContain('"label": "Status"')
    expect(userMessage.content).toContain('New Request')
  })

  it('includes page title and url in user message', () => {
    const [, userMessage] = buildPrompt('show sent applications', observation)
    expect(userMessage.content).toContain('Applications')
    expect(userMessage.content).toContain('http://localhost:8080/applications')
  })

  it('includes max index hint in user message', () => {
    const [, userMessage] = buildPrompt('show sent applications', observation)
    expect(userMessage.content).toContain('Interactive elements on this page: 1 – 2')
  })

  it('includes filter dropdown values in user message', () => {
    const [, userMessage] = buildPrompt('show sent applications', observation)
    expect(userMessage.content).toContain('Sent')
    expect(userMessage.content).toContain('Rejected')
  })

  it('includes known page paths only when provided', () => {
    const pages = {
      Users: '/dashboard/user/list',
      Orders: '/dashboard/order',
      Settings: {
        path: '/dashboard/settings',
        subPages: {
          Profile: '/dashboard/settings/profile',
        },
      },
    }
    const [, userMessage] = buildPrompt('go to users', observation, pages)
    expect(userMessage.content).toContain('Known page paths')
    expect(userMessage.content).toContain('Users')
    expect(userMessage.content).toContain('url: "/dashboard/user/list"')
    expect(userMessage.content).toContain('Profile')
    expect(userMessage.content).toContain('url: "/dashboard/settings/profile"')
  })

  it('includes completed steps when provided', () => {
    const steps = [
      {
        step: 1,
        observation: '',
        action: { action: 'navigate' as const, args: { url: '/applications' } },
        result: { success: true, message: 'Navigated to /applications' },
      },
    ]
    const [, userMessage] = buildPrompt('filter by Sent', observation, undefined, steps)
    expect(userMessage.content).toContain('Steps already completed')
    expect(userMessage.content).toContain('navigate')
    expect(userMessage.content).toContain('Navigated to /applications')
  })

  it('includes conversation history when provided', () => {
    const history = [
      { role: 'user' as const, content: 'Show me applications' },
      { role: 'assistant' as const, content: 'Navigated to /applications' },
    ]
    const [, userMessage] = buildPrompt('filter by Sent', observation, undefined, [], history)
    expect(userMessage.content).toContain('CONVERSATION HISTORY')
    expect(userMessage.content).toContain('Show me applications')
    expect(userMessage.content).toContain('Navigated to /applications')
  })

  it('includes QA mode hints when enabled', () => {
    const [, userMessage] = buildPrompt('what does this show?', observation, undefined, [], [], true)
    expect(userMessage.content).toContain('Q&A MODE')
  })
})
