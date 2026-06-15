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
        {
          thought: 'Fill name',
          action: 'input',
          args: { index: 1, text: 'Mona' },
        },
        {
          thought: 'Fill email',
          action: 'input',
          args: { index: 2, text: 'mona@example.com' },
        },
        {
          thought: 'Pick role',
          action: 'select',
          args: { index: 3, value: 'Designer' },
        },
        {
          thought: 'Submit form',
          action: 'click',
          args: { index: 4 },
        },
        {
          thought: 'Done',
          action: 'done',
          args: { result: 'Submitted demo form.' },
        },
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
        {
          thought: 'Click notification button',
          action: 'click',
          args: { index: 5 },
        },
        {
          thought: 'Done',
          action: 'done',
          args: { result: 'Notification clicked.' },
        },
      ]),
      maxSteps: 4,
    })

    const result = await agent.execute('Click show notification')
    const snapshot = captureSnapshot()

    expect(result.status).toBe('done')
    expect(snapshot.output).toBe('Notification button clicked.')
  })

  it('applies multiple filters one at a time, driven by the model', async () => {
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
      { thought: 'Apply the type filter', action: 'select', args: { index: 1, value: 'Mining License' } },
      { thought: 'Apply the status filter', action: 'select', args: { index: 2, value: 'Completed' } },
      { thought: 'Done', action: 'done', args: { result: 'Filtered.' } },
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
    // Exactly the three scripted turns — no extra auto-injected model calls.
    expect(client.calls).toBe(3)
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
      { thought: 'Select the requested status', action: 'select', args: { index: 2, value: 'Rejected' } },
      { thought: 'Done', action: 'done', args: { result: 'Filtered.' } },
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
    // Only one qualifier was requested, so the done-gate finds NO leftover task
    // words and accepts done without touching the other dropdown — no extra call.
    expect(selects[1].value).toBe('Rejected')
    expect(selects[0].value).toBe('All')
    expect(client.calls).toBe(2)
  })

  it('deterministically applies a missing second filter after an early done (JSON-mode behavior)', async () => {
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

    // Simulates the terse JSON-mode model: applies ONE filter, then calls done and
    // drops the second — and keeps saying done. The done-gate must apply the missing
    // type filter DETERMINISTICALLY (no further model turn that picks it).
    const client = new CountingScriptedLLMClient([
      { thought: 'Apply status', action: 'select', args: { index: 2, value: 'Completed' } },
      { thought: 'Done', action: 'done', args: { result: 'Filtered by status.' } },
      // Even if asked again, the lazy model just says done — the gate handles it.
      { thought: 'Still done', action: 'done', args: { result: 'Filtered by status.' } },
      { thought: 'Still done', action: 'done', args: { result: 'Filtered by status.' } },
    ])

    const agent = new MyPageAgent({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'NA',
      model: 'test-model',
      llmClient: client,
      maxSteps: 8,
    })

    const result = await agent.execute('Show completed mining license requests')
    const selects = Array.from(document.querySelectorAll('select')) as HTMLSelectElement[]

    expect(result.status).toBe('done')
    // BOTH filters end up applied — the type filter was applied by the deterministic
    // done-gate using the leftover task word "mining license".
    expect(selects[0].value).toBe('Mining License')
    expect(selects[1].value).toBe('Completed')
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

  it('single-call mode applies task-named filters deterministically even if the model returns a stray action', async () => {
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
          Region
          <select>
            <option>All</option>
            <option>Northern</option>
            <option>Southern</option>
            <option>Central</option>
          </select>
        </label>
        <button type="button">Reset</button>
      </main>
    `

    // Mirrors the reported bug: a terse single-call model returns ONE useless
    // click instead of selecting the two requested filters. The deterministic
    // pre/post passes must still apply BOTH "Mining License" and "Southern".
    const client = new CountingScriptedLLMClient([
      { thought: 'guessing', action: 'click', args: { index: 3 } },
    ])

    const agent = new MyPageAgent({
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'NA',
      model: 'test-model',
      llmClient: client,
      singleLLMCall: true,
      maxSteps: 4,
    })

    const result = await agent.execute('Show me the Mining License of Southern on government followup page')
    const selects = Array.from(document.querySelectorAll('select')) as HTMLSelectElement[]

    expect(result.status).toBe('done')
    expect(selects[0].value).toBe('Mining License')
    expect(selects[1].value).toBe('Southern')
    // Exactly ONE model round-trip — the filters were applied without the model.
    expect(client.calls).toBe(1)
  })
})