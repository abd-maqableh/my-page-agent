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

    expect(withoutPages.content).not.toContain('KNOWN PAGE PATHS')
    expect(withPages.content).toContain('KNOWN PAGE PATHS')
    expect(withPages.content).toContain('Users')
    expect(withPages.content).toContain('/dashboard/user/list')
    expect(withPages.content).toContain('When the user asks ONLY to')
    expect(withPages.content).toContain('continue with those remaining steps instead of stopping')
    expect(withPages.content).toContain('COMBINED NAVIGATE + NARROW + ITEM ACTION')
  })
})