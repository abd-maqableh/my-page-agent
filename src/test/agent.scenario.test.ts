import { afterEach, describe, expect, it } from 'vitest'
import { MyPageAgent } from '../index'
import type { AgentAction, ChatMessage, LLMClient } from '../core/types'

/**
 * Each constructor entry is ONE model turn. An entry may be a single action OR an
 * array of actions (a batch the agent runs without re-asking). This mirrors the
 * real client's `getNextActions`, which can return several actions per call.
 */
class ScriptedLLMClient implements LLMClient {
  private readonly turns: AgentAction[][]
  private pointer = 0

  constructor(turns: Array<AgentAction | AgentAction[]>) {
    this.turns = turns.map((turn) => (Array.isArray(turn) ? turn : [turn]))
  }

  async getNextActions(_messages: ChatMessage[]): Promise<AgentAction[]> {
    const turn = this.turns[this.pointer]
    if (!turn) {
      throw new Error('ScriptedLLMClient: no action available for this step.')
    }
    this.pointer += 1
    return turn
  }
}

class CountingScriptedLLMClient extends ScriptedLLMClient {
  calls = 0

  override async getNextActions(messages: Parameters<ScriptedLLMClient['getNextActions']>[0]) {
    this.calls += 1
    return super.getNextActions(messages)
  }
}

function captureSnapshot(root: ParentNode = document) {
  const query = (selector: string) =>
    root.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

  const form = root.querySelector<HTMLFormElement>('#demo-form')

  return {
    output: query('#output'),
    name: form?.elements.namedItem('name') instanceof HTMLInputElement
      ? form.elements.namedItem('name').value
      : '',
    email: form?.elements.namedItem('email') instanceof HTMLInputElement
      ? form.elements.namedItem('email').value
      : '',
    role: form?.elements.namedItem('role') instanceof HTMLSelectElement
      ? form.elements.namedItem('role').value
      : '',
  }
}

const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect

function mountDemoFixture(): void {
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 240,
      bottom: 48,
      width: 240,
      height: 48,
      toJSON() {
        return this
      },
    } as DOMRect
  }

  document.body.innerHTML = `
    <main>
      <form id="demo-form">
        <label>
          Name
          <input name="name" placeholder="Enter your name" />
        </label>
        <label>
          Email
          <input name="email" type="email" placeholder="name@example.com" />
        </label>
        <label>
          Role
          <select name="role">
            <option value="">Pick one</option>
            <option value="developer">Developer</option>
            <option value="designer">Designer</option>
            <option value="manager">Manager</option>
          </select>
        </label>
        <button type="submit">Submit Form</button>
      </form>

      <div class="actions">
        <button type="button" id="notify-btn">Show Notification</button>
        <a href="#" id="fake-link">Focusable Link</a>
        <textarea placeholder="Additional notes"></textarea>
        <p id="output"></p>
      </div>
    </main>
  `

  const output = document.querySelector<HTMLParagraphElement>('#output')
  const form = document.querySelector<HTMLFormElement>('#demo-form')
  const notifyBtn = document.querySelector<HTMLButtonElement>('#notify-btn')
  const fakeLink = document.querySelector<HTMLAnchorElement>('#fake-link')

  form?.addEventListener('submit', (event) => {
    event.preventDefault()
    output!.textContent = 'Form submitted (demo only).'
  })

  notifyBtn?.addEventListener('click', () => {
    output!.textContent = 'Notification button clicked.'
  })

  fakeLink?.addEventListener('click', (event) => {
    event.preventDefault()
    output!.textContent = 'Link clicked.'
  })
}

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect
  document.body.innerHTML = ''
})

describe('agent scenarios', () => {
  it('completes the form submission scenario', async () => {
    mountDemoFixture()
    const agent = new MyPageAgent({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'NA',
      model: 'test-model',
      llmClient: new ScriptedLLMClient([
        [
          { thought: 'Fill the form then submit', action: 'input', args: { index: 1, text: 'Mona' } },
          { action: 'input', args: { index: 2, text: 'mona@example.com' } },
          { action: 'select', args: { index: 3, value: 'Designer' } },
          { action: 'click', args: { index: 4 } },
          { action: 'done', args: { result: 'Submitted demo form.' } },
        ],
      ]),
      maxSteps: 8,
    })

    const result = await agent.execute('Fill the demo form and submit it')
    const snapshot = captureSnapshot()

    expect(result.status).toBe('done')
    expect(snapshot.name).toBe('Mona')
    expect(snapshot.email).toBe('mona@example.com')
    expect(snapshot.role).toBe('designer')
    expect(snapshot.output).toBe('Form submitted (demo only).')
  })

  it('completes the notification scenario', async () => {
    mountDemoFixture()
    const agent = new MyPageAgent({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'NA',
      model: 'test-model',
      llmClient: new ScriptedLLMClient([
        [
          { thought: 'Click notification button', action: 'click', args: { index: 5 } },
          { action: 'done', args: { result: 'Notification clicked.' } },
        ],
      ]),
      maxSteps: 4,
    })

    const result = await agent.execute('Click show notification')
    const snapshot = captureSnapshot()

    expect(result.status).toBe('done')
    expect(snapshot.output).toBe('Notification button clicked.')
  })

  it('applies multiple filters from a single batched model response', async () => {
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 240,
        bottom: 48,
        width: 240,
        height: 48,
        toJSON() {
          return this
        },
      } as DOMRect
    }

    document.body.innerHTML = `
      <main>
        <label>
          Request Type
          <select>
            <option>All</option>
            <option>Mining License</option>
            <option>Exploration License</option>
            <option>License Renewal</option>
          </select>
        </label>
        <label>
          Final Status
          <select>
            <option>All</option>
            <option>Completed</option>
            <option>Rejected</option>
            <option>Conditional Approval</option>
          </select>
        </label>
      </main>
    `

    const client = new CountingScriptedLLMClient([
      [
        { thought: 'Apply both filters then finish', action: 'select', args: { index: 1, value: 'Mining License' } },
        { action: 'select', args: { index: 2, value: 'Completed' } },
        { action: 'done', args: { result: 'Filtered.' } },
      ],
    ])

    const agent = new MyPageAgent({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'NA',
      model: 'test-model',
      llmClient: client,
      maxSteps: 6,
    })

    const result = await agent.execute('Show completed mining license requests')
    const selects = Array.from(document.querySelectorAll('select')) as HTMLSelectElement[]

    expect(result.status).toBe('done')
    expect(selects[0].value).toBe('Mining License')
    expect(selects[1].value).toBe('Completed')
    // The whole batch ran from ONE API round-trip.
    expect(client.calls).toBe(1)
  })

  it('applies a single filter without touching the other dropdowns', async () => {
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 240,
        bottom: 48,
        width: 240,
        height: 48,
        toJSON() {
          return this
        },
      } as DOMRect
    }

    document.body.innerHTML = `
      <main>
        <label>
          Request Type
          <select>
            <option>All</option>
            <option>Mining License</option>
            <option>Exploration License</option>
          </select>
        </label>
        <label>
          Final Status
          <select>
            <option>All</option>
            <option>Completed</option>
            <option>Rejected</option>
            <option>Conditional Approval</option>
          </select>
        </label>
      </main>
    `

    const client = new CountingScriptedLLMClient([
      [
        { thought: 'Select the requested status then finish', action: 'select', args: { index: 2, value: 'Rejected' } },
        { action: 'done', args: { result: 'Filtered.' } },
      ],
    ])

    const agent = new MyPageAgent({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'NA',
      model: 'test-model',
      llmClient: client,
      maxSteps: 4,
    })

    const result = await agent.execute('Show rejected requests')
    const selects = Array.from(document.querySelectorAll('select')) as HTMLSelectElement[]

    expect(result.status).toBe('done')
    // Only the requested dropdown was touched; the other stays at its default.
    expect(selects[1].value).toBe('Rejected')
    expect(selects[0].value).toBe('All')
    expect(client.calls).toBe(1)
  })

  it('applies two filters and finishes from a SINGLE batched model response', async () => {
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 240,
        bottom: 48,
        width: 240,
        height: 48,
        toJSON() {
          return this
        },
      } as DOMRect
    }

    document.body.innerHTML = `
      <main>
        <label>
          Request Type
          <select>
            <option>All</option>
            <option>Mining License</option>
            <option>Exploration License</option>
            <option>License Renewal</option>
          </select>
        </label>
        <label>
          Final Status
          <select>
            <option>All</option>
            <option>Completed</option>
            <option>Rejected</option>
            <option>Conditional Approval</option>
          </select>
        </label>
      </main>
    `

    // ONE model turn returns a batch of three actions. The agent must run them all
    // without calling the model again — proving the multi-action batching path.
    const client = new CountingScriptedLLMClient([
      [
        { thought: 'Apply both filters then finish', action: 'select', args: { index: 1, value: 'Mining License' } },
        { action: 'select', args: { index: 2, value: 'Completed' } },
        { action: 'done', args: { result: 'Filtered.' } },
      ],
    ])

    const agent = new MyPageAgent({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'NA',
      model: 'test-model',
      llmClient: client,
      maxSteps: 4,
    })

    const result = await agent.execute('Show completed mining license requests')
    const selects = Array.from(document.querySelectorAll('select')) as HTMLSelectElement[]

    expect(result.status).toBe('done')
    expect(selects[0].value).toBe('Mining License')
    expect(selects[1].value).toBe('Completed')
    // The whole batch ran from ONE API round-trip.
    expect(client.calls).toBe(1)
  })

  it('single-call mode surfaces the model\u2019s done message for an impossible request', async () => {
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 240,
        bottom: 48,
        width: 240,
        height: 48,
        toJSON() {
          return this
        },
      } as DOMRect
    }

    document.body.innerHTML = `
      <main>
        <label>
          Request Type
          <select>
            <option>All</option>
            <option>Mining License</option>
          </select>
        </label>
        <button type="button">Reset</button>
      </main>
    `

    // The request names nothing on the page, so the model returns ONLY a `done`
    // that explains the situation. The agent MUST surface that explanation rather
    // than the generic "Executed one-call plan." — and apply no filters.
    const explanation =
      'There is no "original page" here. Available filters: Request Type (Mining License).'
    const client = new CountingScriptedLLMClient([
      { thought: 'nothing matches', action: 'done', args: { result: explanation } },
    ])

    const agent = new MyPageAgent({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'NA',
      model: 'test-model',
      llmClient: client,
      maxSteps: 4,
    })

    const result = await agent.execute('show me the original page')
    const selects = Array.from(document.querySelectorAll('select')) as HTMLSelectElement[]

    expect(result.status).toBe('done')
    // The model's own explanation is surfaced verbatim — NOT a generic confirmation.
    expect(result.message).toBe(explanation)
    expect(result.message).not.toBe('Executed one-call plan.')
    // No filter was applied for an impossible request.
    expect(selects[0].value).toBe('All')
    expect(client.calls).toBe(1)
  })

  it('handles a pure navigation request through one model call', async () => {
    window.history.pushState({}, '', '/applications')
    document.body.innerHTML = '<main><h1>Applications</h1></main>'

    const client = new CountingScriptedLLMClient([
      { thought: 'already on target page', action: 'done', args: { result: 'Already on applications.' } },
    ])
    const agent = new MyPageAgent({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'NA',
      model: 'test-model',
      llmClient: client,
      pages: { Applications: '/applications', Dashboard: '/dashboard' },
    })

    const result = await agent.execute('go to applications')

    expect(result.status).toBe('done')
    expect(client.calls).toBe(1)
    expect(result.message.toLowerCase()).toContain('applications')
  })

  it('synthesizes a Done message when the model omits a done action', async () => {
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 240,
        bottom: 48,
        width: 240,
        height: 48,
        toJSON() {
          return this
        },
      } as DOMRect
    }

    document.body.innerHTML = `
      <main>
        <label>
          Request Type
          <select>
            <option>All</option>
            <option>Mining License</option>
          </select>
        </label>
        <label>
          Final Status
          <select>
            <option>All</option>
            <option>Completed</option>
            <option>Rejected</option>
          </select>
        </label>
      </main>
    `

    // The model returns ONLY a select (no trailing done). The agent must still
    // finish and synthesize a message from the last successful action.
    const client = new CountingScriptedLLMClient([
      { thought: 'apply the status', action: 'select', args: { index: 2, value: 'Rejected' } },
    ])

    const agent = new MyPageAgent({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'NA',
      model: 'test-model',
      llmClient: client,
      maxSteps: 4,
    })

    const result = await agent.execute('Show rejected requests')
    const selects = Array.from(document.querySelectorAll('select')) as HTMLSelectElement[]

    expect(result.status).toBe('done')
    expect(selects[1].value).toBe('Rejected')
    expect(result.message).toContain('Selected')
    expect(client.calls).toBe(1)
  })

  it('surfaces an LLM error as an error result (no retries)', async () => {
    document.body.innerHTML = '<main><button type="button">Hi</button></main>'

    let calls = 0
    const client: LLMClient = {
      async getNextActions() {
        calls += 1
        throw new Error('LLM request timed out after 120000ms.')
      },
    }

    const agent = new MyPageAgent({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'NA',
      model: 'test-model',
      llmClient: client,
    })

    const result = await agent.execute('do something')

    expect(result.status).toBe('error')
    expect(result.message).toContain('timed out')
    // One call only — no automatic retry loop.
    expect(calls).toBe(1)
  })

  it('falls through to a single model call when the requested page is unknown', async () => {
    document.body.innerHTML = '<main><button type="button">Reset</button></main>'

    const client = new CountingScriptedLLMClient([
      {
        thought: 'no such page',
        action: 'done',
        args: { result: 'There is no billing page. Available pages: Applications, Dashboard.' },
      },
    ])

    const agent = new MyPageAgent({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'NA',
      model: 'test-model',
      llmClient: client,
      pages: { Applications: '/applications', Dashboard: '/dashboard' },
    })

    const result = await agent.execute('go to the billing page')

    expect(result.status).toBe('done')
    // Unknown page → no deterministic navigation, exactly one model call.
    expect(client.calls).toBe(1)
    expect(result.message.toLowerCase()).toContain('billing')
  })

  it('select redirects to the dropdown that offers the value when the model targets a wrong element', async () => {
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(): DOMRect {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 240,
        bottom: 48,
        width: 240,
        height: 48,
        toJSON() {
          return this
        },
      } as DOMRect
    }

    // The model correctly chose `select value:"Sent"` but attached it to the wrong
    // index (the Refresh button) instead of the status dropdown. The select action
    // must faithfully execute the requested VALUE by redirecting to the dropdown
    // whose own options include "Sent" — without the model deciding for it.
    document.body.innerHTML = `
      <main>
        <button type="button">Refresh Applications List</button>
        <label>
          Status
          <select>
            <option>All Statuses</option>
            <option>Sent</option>
            <option>On Hold</option>
            <option>Rejected</option>
          </select>
        </label>
      </main>
    `

    const client = new CountingScriptedLLMClient([
      [
        // index 1 is the Refresh button, NOT the dropdown — the reported mistake.
        { thought: 'filter to sent', action: 'select', args: { index: 1, value: 'Sent' } },
        { action: 'done', args: { result: 'Filtered by Sent.' } },
      ],
    ])

    const agent = new MyPageAgent({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'NA',
      model: 'test-model',
      llmClient: client,
      maxSteps: 4,
    })

    const result = await agent.execute('show me sent applications')
    const select = document.querySelector('select') as HTMLSelectElement

    expect(result.status).toBe('done')
    // Faithful execution of the model's chosen value — Sent is applied.
    expect(select.value).toBe('Sent')
    expect(client.calls).toBe(1)
  })
})