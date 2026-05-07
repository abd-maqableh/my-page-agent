import { describe, expect, it } from 'vitest'
import { parseAgentActionResponse } from '../llm/OpenAIClient'

describe('parseAgentActionResponse', () => {
  it('parses plain JSON', () => {
    const action = parseAgentActionResponse('{"thought":"ok","action":"click","args":{"index":2}}')
    expect(action.action).toBe('click')
    expect(action.args?.index).toBe(2)
  })

  it('parses fenced JSON', () => {
    const action = parseAgentActionResponse('```json\n{"action":"done","args":{"result":"finished"}}\n```')
    expect(action.action).toBe('done')
    expect(action.args?.result).toBe('finished')
  })

  it('throws on invalid action', () => {
    expect(() => parseAgentActionResponse('{"action":"hack"}')).toThrow('Invalid action')
  })
})
