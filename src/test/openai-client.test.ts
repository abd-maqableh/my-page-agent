import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIClient, parseAgentActionResponse, parseAgentActions } from '../llm/OpenAIClient'

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

describe('parseAgentActions (batched output)', () => {
  it('parses a single action into a one-element array', () => {
    const actions = parseAgentActions('{"action":"select","args":{"index":3,"value":"Active"}}')
    expect(actions).toHaveLength(1)
    expect(actions[0].action).toBe('select')
  })

  it('parses an "actions" array and propagates the shared thought', () => {
    const actions = parseAgentActions(
      '{"thought":"apply both filters","actions":[{"action":"select","args":{"index":7,"value":"Ready"}},{"action":"select","args":{"index":9,"value":"Exploration"}},{"action":"done","args":{"result":"Filtered."}}]}',
    )
    expect(actions).toHaveLength(3)
    expect(actions.map((a) => a.action)).toEqual(['select', 'select', 'done'])
    expect(actions[0].thought).toBe('apply both filters')
    expect(actions[1].args?.value).toBe('Exploration')
  })

  it('parses a bare top-level array of actions', () => {
    const actions = parseAgentActions('[{"action":"input","args":{"index":1,"text":"hi"}},{"action":"done","args":{"result":"ok"}}]')
    expect(actions.map((a) => a.action)).toEqual(['input', 'done'])
  })

  it('parses a fenced batch array', () => {
    const actions = parseAgentActions('```json\n[{"action":"scroll","args":{"index":4}},{"action":"done","args":{"result":"done"}}]\n```')
    expect(actions).toHaveLength(2)
    expect(actions[0].action).toBe('scroll')
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

    const actions = await client.getNextActions([{ role: 'user', content: 'Return done.' }])

    expect(actions[0].action).toBe('done')
    expect(actions[0].args?.result).toBe('ok')
    expect(fetchMock).toHaveBeenCalledOnce()

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://localhost:11434/v1/chat/completions')
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'llama3.2',
      temperature: 0,
    })
  })
})

describe('OpenAIClient — performance knobs', () => {
  it('sends max_tokens and response_format only when configured', async () => {
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
      maxTokens: 400,
      jsonMode: true,
    })

    await client.getNextActions([{ role: 'user', content: 'go' }])

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body.max_tokens).toBe(400)
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('omits max_tokens and response_format by default', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"action":"done","args":{"result":"ok"}}' } }] }),
      )
    })
    globalThis.fetch = fetchMock as typeof fetch

    const client = new OpenAIClient({ baseURL: 'http://localhost:11434/v1', apiKey: 'NA', model: 'llama3.2' })
    await client.getNextActions([{ role: 'user', content: 'go' }])

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect('max_tokens' in body).toBe(false)
    expect('response_format' in body).toBe(false)
  })

  it('throws a clear timeout error when the request aborts', async () => {
    globalThis.fetch = vi.fn(async () => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }) as typeof fetch

    const client = new OpenAIClient({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'NA',
      model: 'llama3.2',
      requestTimeoutMs: 50,
    })

    await expect(client.getNextActions([{ role: 'user', content: 'go' }])).rejects.toThrow(/timed out after 50ms/)
  })
})
