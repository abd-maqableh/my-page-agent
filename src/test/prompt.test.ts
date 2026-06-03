import { describe, expect, it } from 'vitest'
import { buildPrompt } from '../core/prompt'
import type { PageObservation } from '../core/types'

const observation: PageObservation = {
  url: 'http://localhost:8080/dashboard/trip',
  title: 'Packages',
  elements: [],
  elementsText: '[1] input:text "Search"\n[2] div[role=combobox] "FILTER DROPDOWN: All Status"',
}

describe('buildPrompt', () => {
  it('keeps item-action guidance in the base prompt', () => {
    const [systemMessage] = buildPrompt('open the dubai trip and view it', observation, [])

    expect(systemMessage.content).toContain('Per-item actions menu')
    expect(systemMessage.content).toContain('They are VALID when the user asks to view, edit, open, manage, or inspect a specific item')
    expect(systemMessage.content).toContain('Only call `done` when EVERY part of the request is complete')
    expect(systemMessage.content).toContain('ITEM ACTION RULE')
  })

  it('adds navigation rules only when pages are provided', () => {
    const [withoutPages] = buildPrompt('go to users', observation, [])
    const [withPages] = buildPrompt('go to users', observation, [], {
      Users: '/dashboard/user/list',
      Orders: '/dashboard/order',
    })

    expect(withoutPages.content).not.toContain('use these exact values for')
    expect(withPages.content).toContain('KNOWN PAGE PATHS')
    expect(withPages.content).toContain('use these exact values for')
    expect(withPages.content).toContain('Users')
    expect(withPages.content).toContain('/dashboard/user/list')
    expect(withPages.content).toContain('When the user asks ONLY to')
    expect(withPages.content).toContain('continue with those remaining steps instead of stopping')
    expect(withPages.content).toContain('COMBINED NAVIGATE + NARROW + ITEM ACTION')
  })

  it('renders declared sections inline and adds the cross-page section rule', () => {
    const [withSections] = buildPrompt('show me Sales Performance', observation, [], {
      Sales: { path: '/dashboard/sales', sections: ['Payout Overview', 'Sales Performance'] },
      Orders: '/dashboard/order',
    })
    const [withoutSections] = buildPrompt('go to orders', observation, [], {
      Orders: '/dashboard/order',
    })

    expect(withSections.content).toContain('[sections: Payout Overview, Sales Performance]')
    expect(withSections.content).toContain('CROSS-PAGE SECTION RULE')
    // The cross-page rule only appears when at least one page declares sections.
    expect(withoutSections.content).not.toContain('CROSS-PAGE SECTION RULE')
  })

  it('flattens declared sub-pages into navigable paths', () => {
    const [withSubPages] = buildPrompt('go to roles', observation, [], {
      Users: { path: '/dashboard/user/list', subPages: { Roles: '/dashboard/user/role' } },
    })

    expect(withSubPages.content).toContain('/dashboard/user/role')
    expect(withSubPages.content).toContain('Roles')
  })
})