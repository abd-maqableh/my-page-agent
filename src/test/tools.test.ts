import { describe, expect, it } from 'vitest'
import { normalizeAction, normalizeActions } from '../core/tools'

describe('normalizeAction — ACTION_SYNONYMS', () => {
  it('resolves tap → click', () => {
    const result = normalizeAction({ action: 'tap', args: { index: 3 } })
    expect(result.action).toBe('click')
    expect(result.args?.index).toBe(3)
  })

  it('resolves fill → input', () => {
    const result = normalizeAction({ action: 'fill', args: { index: 2, text: 'hello' } })
    expect(result.action).toBe('input')
    expect(result.args?.text).toBe('hello')
  })

  it('resolves submit → click', () => {
    const result = normalizeAction({ action: 'submit', args: { index: 5 } })
    expect(result.action).toBe('click')
  })

  it('resolves type → input', () => {
    const result = normalizeAction({ action: 'type', args: { index: 1, text: 'Alex' } })
    expect(result.action).toBe('input')
  })

  it('resolves choose → select', () => {
    const result = normalizeAction({ action: 'choose', args: { index: 3, value: 'Active' } })
    expect(result.action).toBe('select')
  })

  it('resolves finish → done', () => {
    const result = normalizeAction({ action: 'finish', args: { result: 'Done' } })
    expect(result.action).toBe('done')
  })

  it('resolves complete → done', () => {
    const result = normalizeAction({ action: 'complete', args: { result: 'Completed' } })
    expect(result.action).toBe('done')
  })

  it('resolves goto → navigate', () => {
    const result = normalizeAction({ action: 'goto', args: { url: '/users' } })
    expect(result.action).toBe('navigate')
  })

  it('still throws on truly unknown action', () => {
    expect(() => normalizeAction({ action: 'hack' })).toThrow('Invalid action')
  })
})

describe('normalizeAction — extended thought-based index recovery', () => {
  it('recovers index from [N] pattern', () => {
    const result = normalizeAction({ action: 'click', thought: 'I will click element [7] to proceed' })
    expect(result.args?.index).toBe(7)
  })

  it('recovers index from "element N" pattern', () => {
    const result = normalizeAction({ action: 'click', thought: 'click element 5' })
    expect(result.args?.index).toBe(5)
  })

  it('recovers index from "index N" pattern', () => {
    const result = normalizeAction({ action: 'click', thought: 'use index 3' })
    expect(result.args?.index).toBe(3)
  })

  it('recovers index from "item N" pattern', () => {
    const result = normalizeAction({ action: 'click', thought: 'select item 12' })
    expect(result.args?.index).toBe(12)
  })

  it('recovers index from "#N" pattern', () => {
    const result = normalizeAction({ action: 'click', thought: 'click #8 button' })
    expect(result.args?.index).toBe(8)
  })

  it('recovers index from "no. N" pattern', () => {
    const result = normalizeAction({ action: 'click', thought: 'click no. 4' })
    expect(result.args?.index).toBe(4)
  })

  it('recovers index from "number N" pattern', () => {
    const result = normalizeAction({ action: 'click', thought: 'pick number 6' })
    expect(result.args?.index).toBe(6)
  })
})

describe('normalizeAction — index range validation', () => {
  it('accepts valid index within range', () => {
    const result = normalizeAction({ action: 'click', args: { index: 3 } }, 10)
    expect(result.args?.index).toBe(3)
  })

  it('throws on out-of-range index', () => {
    expect(() =>
      normalizeAction({ action: 'click', args: { index: 99 } }, 10),
    ).toThrow(/out of range/)
  })

  it('throws on index 0 when elementCount is provided', () => {
    expect(() =>
      normalizeAction({ action: 'click', args: { index: 0 } }, 5),
    ).toThrow(/out of range/)
  })

  it('does not validate when elementCount is undefined', () => {
    expect(() => normalizeAction({ action: 'click', args: { index: 999 } })).not.toThrow()
  })
})

describe('normalizeAction — flat-arg recovery', () => {
  it('promotes top-level index to args', () => {
    const result = normalizeAction({ action: 'click', index: 4 })
    expect(result.args?.index).toBe(4)
  })

  it('promotes top-level text to args', () => {
    const result = normalizeAction({ action: 'input', index: 2, text: 'hello' })
    expect(result.args?.text).toBe('hello')
  })

  it('prefers explicit args over flat keys', () => {
    const result = normalizeAction({ action: 'click', args: { index: 7 }, index: 3 })
    expect(result.args?.index).toBe(7)
  })
})

describe('normalizeActions — batch validation', () => {
  it('returns a single action wrapped in an array', () => {
    const results = normalizeActions({ action: 'select', args: { index: 2, value: 'Active' } })
    expect(results).toHaveLength(1)
    expect(results[0].action).toBe('select')
  })

  it('normalizes a bare array of actions', () => {
    const results = normalizeActions([
      { action: 'select', args: { index: 2, value: 'Active' } },
      { action: 'done', args: { result: 'Done' } },
    ])
    expect(results).toHaveLength(2)
    expect(results[0].action).toBe('select')
    expect(results[1].action).toBe('done')
  })

  it('normalizes an object with an "actions" array', () => {
    const results = normalizeActions({
      thought: 'apply filters',
      actions: [
        { action: 'select', args: { index: 7, value: 'Ready' } },
        { action: 'done', args: { result: 'Filtered.' } },
      ],
    })
    expect(results).toHaveLength(2)
    expect(results[0].thought).toBe('apply filters')
    expect(results[1].action).toBe('done')
  })

  it('throws per-item error for invalid batch actions', () => {
    expect(() =>
      normalizeActions([
        { action: 'select', args: { index: 2, value: 'Active' } },
        { action: 'hack' },
      ]),
    ).toThrow(/Batch action\[1\] is invalid/)
  })

  it('passes elementCount to each action in the batch', () => {
    const results = normalizeActions(
      [{ action: 'click', args: { index: 3 } }, { action: 'click', args: { index: 5 } }],
      10,
    )
    expect(results).toHaveLength(2)
    expect(results[0].args?.index).toBe(3)
  })

  it('rejects out-of-range index in batch', () => {
    expect(() =>
      normalizeActions([{ action: 'click', args: { index: 99 } }], 5),
    ).toThrow(/Batch action\[0\] is invalid/)
  })
})

describe('normalizeAction — synonym + thought recovery combined', () => {
  it('resolves synonym and recovers index from thought', () => {
    const result = normalizeAction({ action: 'tap', thought: 'click element [5]' })
    expect(result.action).toBe('click')
    expect(result.args?.index).toBe(5)
  })

  it('resolves synonym, recovers index, and validates range', () => {
    const result = normalizeAction({ action: 'tap', thought: 'click element [3]', args: {} }, 10)
    expect(result.action).toBe('click')
    expect(result.args?.index).toBe(3)
  })
})
