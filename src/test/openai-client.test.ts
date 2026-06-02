import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIClient, parseAgentActionResponse } from '../llm/OpenAIClient'

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

describe('OpenAIClient security guard', () => {
  it('refuses to talk directly to api.openai.com without opt-in', () => {
    expect(
      () =>
        new OpenAIClient({
          baseURL: 'https://api.openai.com/v1',
          apiKey: 'sk-leak',
          model: 'gpt-4o-mini',
        }),
    ).toThrow(/refusing to send the API key directly/)
  })

  it('allows direct provider when explicitly opted in', () => {
    expect(
      () =>
        new OpenAIClient({
          baseURL: 'https://api.openai.com/v1',
          apiKey: 'sk-leak',
          model: 'gpt-4o-mini',
          allowDirectProvider: true,
        }),
    ).not.toThrow()
  })

  it('allows custom proxy URLs by default', () => {
    expect(
      () =>
        new OpenAIClient({
          baseURL: 'https://proxy.example.com/v1',
          apiKey: 'proxy-token',
          model: 'gpt-4o-mini',
        }),
    ).not.toThrow()
  })
})

describe('OpenAIClient — Ollama-compatible endpoint', () => {
  it('calls Ollama via its OpenAI-compatible /v1/chat/completions endpoint', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"action":"done","args":{"result":"ok"}}' } }] }),
      )
    })
    globalThis.fetch = fetchMock as typeof fetch

    const client = new OpenAIClient({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'NA',
      model: 'llama3.2',
      temperature: 0,
    })

    const action = await client.getNextAction([{ role: 'user', content: 'Return done.' }])

    expect(action.action).toBe('done')
    expect(action.args?.result).toBe('ok')
    expect(fetchMock).toHaveBeenCalledOnce()

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://localhost:11434/v1/chat/completions')
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'llama3.2',
      temperature: 0,
    })
  })
})
