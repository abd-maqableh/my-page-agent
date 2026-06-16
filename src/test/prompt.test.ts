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
  it('includes item-action guidance only when item/menu elements are present', () => {
    const itemObs: PageObservation = {
      ...observation,
      elementsText: '[1] button "Per-item actions menu (Dubai Trip)"\n[2] div[role=combobox] "FILTER DROPDOWN: All Status"',
    }
    const [systemMessage] = buildPrompt('open the dubai trip and view it', itemObs, [])

    expect(systemMessage.content).toContain('Per-item actions menu')
    expect(systemMessage.content).toContain('They are VALID when the user asks to view, edit, open, manage, or inspect a specific item')
    expect(systemMessage.content).toContain('Only call `done` when EVERY part of the request is complete')
    expect(systemMessage.content).toContain('ITEM ACTION RULE')
  })

  it('prunes rule groups whose element types are absent from the page', () => {
    // The default observation has a FILTER DROPDOWN but no menus, tabs, sections,
    // or form controls — so those groups must be dropped, but filtering stays.
    const [systemMessage] = buildPrompt('show active items', observation, [])

    expect(systemMessage.content).toContain('=== FILTERING & SEARCH ===')
    expect(systemMessage.content).not.toContain('=== ITEMS & MENUS ===')
    expect(systemMessage.content).not.toContain('=== TABS & SECTIONS ===')
    expect(systemMessage.content).not.toContain('=== FORMS & INPUTS ===')
    // The export rule is only included when the task asks to export/download.
    expect(systemMessage.content).not.toContain('EXPORT RULE')
  })

  it('includes the export rule only for export/download tasks', () => {
    const [withExport] = buildPrompt('export to excel', observation, [])
    const [withoutExport] = buildPrompt('show active items', observation, [])

    expect(withExport.content).toContain('EXPORT RULE')
    expect(withoutExport.content).not.toContain('EXPORT RULE')
  })

  it('documents the strict object response format and the multi-filter rule', () => {
    const [systemMessage] = buildPrompt('show ready for signature exploration license applications', observation, [])

    expect(systemMessage.content).toContain('RESPONSE FORMAT')
    expect(systemMessage.content).toContain('"actions"')
    expect(systemMessage.content).toContain('BATCHING RULE')
    expect(systemMessage.content).toContain('SAFE-TO-CHAIN actions')
    expect(systemMessage.content).toContain('PAGE-CHANGING actions')
    expect(systemMessage.content).toContain('MULTI-FILTER RULE')
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