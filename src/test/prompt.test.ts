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
  it('includes minimal action and return-format instructions', () => {
    const [systemMessage] = buildPrompt('show sent applications', observation)

    expect(systemMessage.content).toContain('You are a browser page agent.')
    expect(systemMessage.content).toContain('Available actions and REQUIRED args')
    expect(systemMessage.content).toContain('- click')
    expect(systemMessage.content).toContain('- done')
    expect(systemMessage.content).toContain('Return ONLY one JSON object')
    expect(systemMessage.content).toContain('"actions"')
    expect(systemMessage.content).toContain('Runtime context (changes every request):')
    expect(systemMessage.content).toContain('PAGE ELEMENTS')
    expect(systemMessage.content).toContain('END OF PAGE ELEMENTS')
  })

  it('includes DOM elements as JSON with labels and descriptions in system', () => {
    const [systemMessage] = buildPrompt('show sent applications', observation)

    expect(systemMessage.content).toContain('"label": "Status"')
    expect(systemMessage.content).toContain('"description": "Filter dropdown.')
    expect(systemMessage.content).toContain('Options: New Request, Sent, Rejected')
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
    expect(withPages.content).toContain('Users')
    expect(withPages.content).toContain('url: "/dashboard/user/list"')
    expect(withPages.content).toContain('Profile')
    expect(withPages.content).toContain('url: "/dashboard/settings/profile"')
  })

  describe('new rules (hallucination fixes)', () => {
    it('includes SECTION RULE', () => {
      const [systemMessage] = buildPrompt('show sent applications', observation)
      expect(systemMessage.content).toContain('SECTION RULE:')
      expect(systemMessage.content).toContain('scroll landmarks ONLY')
    })

    it('includes RETRY RULE', () => {
      const [systemMessage] = buildPrompt('show sent applications', observation)
      expect(systemMessage.content).toContain('RETRY RULE:')
      expect(systemMessage.content).toContain('completely different action or index')
    })

    it('includes DONE RULES A/B/C/D', () => {
      const [systemMessage] = buildPrompt('show sent applications', observation)
      expect(systemMessage.content).toContain('DONE RULE A:')
      expect(systemMessage.content).toContain('DONE RULE B:')
      expect(systemMessage.content).toContain('DONE RULE C:')
      expect(systemMessage.content).toContain('DONE RULE D:')
    })

    it('includes NAVIGATE STRICT RULE', () => {
      const [systemMessage] = buildPrompt('show sent applications', observation)
      expect(systemMessage.content).toContain('NAVIGATE STRICT RULE:')
    })

    it('includes DATE FORMAT RULE', () => {
      const [systemMessage] = buildPrompt('show sent applications', observation)
      expect(systemMessage.content).toContain('DATE FORMAT RULE:')
    })

    it('includes MODAL rules', () => {
      const [systemMessage] = buildPrompt('show sent applications', observation)
      expect(systemMessage.content).toContain('MODAL CLOSE RULE:')
      expect(systemMessage.content).toContain('MODAL INTERACTION RULE:')
    })

    it('includes output primer', () => {
      const [systemMessage] = buildPrompt('show sent applications', observation)
      expect(systemMessage.content).toContain('Respond with ONLY the JSON object')
      expect(systemMessage.content).toContain('No preamble. No explanation. No markdown.')
    })

    it('includes BATCHING section with array example', () => {
      const [systemMessage] = buildPrompt('show sent applications', observation)
      expect(systemMessage.content).toContain('BATCHING:')
      expect(systemMessage.content).toContain('"action":"select"')
      expect(systemMessage.content).toContain('"action":"done"')
    })

    it('includes max index hint in user message', () => {
      const [, userMessage] = buildPrompt('show sent applications', observation)
      expect(userMessage.content).toContain('interactive element(s) on this page')
      expect(userMessage.content).toContain('Valid indexes: 1 –')
    })
  })
})
