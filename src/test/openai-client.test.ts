import { afterEach, describe, expect, it, vi } from 'vitest'
import { OllamaClient } from '../llm/OllamaClient'
import { parseAgentActionResponse } from '../llm/OpenAIClient'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

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

describe('OllamaClient', () => {
  it('requests a JSON chat action through Ollama', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ message: { content: '{"action":"done","args":{"result":"ok"}}' } }))
    })
    globalThis.fetch = fetchMock as typeof fetch

    const client = new OllamaClient({
      provider: 'ollama',
      baseURL: 'http://localhost:11434',
      model: 'llama3.2',
      temperature: 0,
    })

    const action = await client.getNextAction([{ role: 'user', content: 'Return done.' }])

    expect(action.action).toBe('done')
    expect(action.args?.result).toBe('ok')
    expect(fetchMock).toHaveBeenCalledOnce()

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://localhost:11434/api/chat')
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'llama3.2',
      format: 'json',
      stream: false,
      options: { temperature: 0 },
    })
  })
})
