import type { AgentRunResult } from '../core/types'

export interface PanelController {
  execute(task: string): Promise<AgentRunResult>
  onStatus(handler: (status: string) => void): void
  onStep(handler: (line: string) => void): void
}

export class Panel {
  private static readonly MAX_LOG_ENTRIES = 8

  private readonly controller: PanelController
  private readonly root: HTMLDivElement
  private readonly taskInput: HTMLTextAreaElement
  private readonly statusEl: HTMLDivElement
  private readonly logEl: HTMLUListElement

  constructor(controller: PanelController) {
    this.controller = controller
    this.root = document.createElement('div')
    this.taskInput = document.createElement('textarea')
    this.statusEl = document.createElement('div')
    this.logEl = document.createElement('ul')
    this.render()
    this.bindControllerEvents()
  }

  mount(parent: ParentNode = document.body): void {
    parent.appendChild(this.root)
  }

  private bindControllerEvents(): void {
    this.controller.onStatus((status) => {
      this.statusEl.textContent = `Status: ${status}`
    })

    this.controller.onStep((line) => {
      const item = document.createElement('li')
      item.textContent = line
      this.logEl.prepend(item)
      while (this.logEl.children.length > Panel.MAX_LOG_ENTRIES) {
        this.logEl.removeChild(this.logEl.lastElementChild as Node)
      }
    })
  }

  private render(): void {
    Object.assign(this.root.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '2147483647',
      width: '360px',
      maxWidth: 'calc(100vw - 32px)',
      background: '#0f172a',
      color: '#f8fafc',
      border: '1px solid #334155',
      borderRadius: '12px',
      padding: '12px',
      fontFamily: 'system-ui, sans-serif',
      boxShadow: '0 10px 20px rgba(0, 0, 0, 0.25)',
    })

    const title = document.createElement('h3')
    title.textContent = 'My Page Agent MVP'
    title.style.margin = '0 0 8px'
    title.style.fontSize = '14px'

    this.taskInput.placeholder = 'Instruction (e.g. Fill the form and submit)'
    Object.assign(this.taskInput.style, {
      width: '100%',
      minHeight: '60px',
      resize: 'vertical',
      background: '#020617',
      color: '#f8fafc',
      border: '1px solid #334155',
      borderRadius: '8px',
      padding: '8px',
      boxSizing: 'border-box',
    })

    const runBtn = document.createElement('button')
    runBtn.type = 'button'
    runBtn.textContent = 'Run Agent'
    Object.assign(runBtn.style, {
      marginTop: '8px',
      padding: '8px 10px',
      borderRadius: '8px',
      border: '1px solid #475569',
      background: '#1d4ed8',
      color: '#fff',
      cursor: 'pointer',
    })

    this.statusEl.textContent = 'Status: idle'
    this.statusEl.style.marginTop = '8px'
    this.statusEl.style.fontSize = '12px'

    this.logEl.style.margin = '8px 0 0'
    this.logEl.style.padding = '0 0 0 20px'
    this.logEl.style.maxHeight = '140px'
    this.logEl.style.overflow = 'auto'
    this.logEl.style.fontSize = '12px'

    runBtn.addEventListener('click', async () => {
      const task = this.taskInput.value.trim()
      if (!task) {
        this.statusEl.textContent = 'Status: enter a task first'
        return
      }

      runBtn.disabled = true
      this.statusEl.textContent = 'Status: running'
      try {
        const result = await this.controller.execute(task)
        this.statusEl.textContent = `Status: ${result.status} - ${result.message}`
      } catch (error) {
        this.statusEl.textContent = `Status: error - ${error instanceof Error ? error.message : 'unknown'}`
      } finally {
        runBtn.disabled = false
      }
    })

    this.root.append(title, this.taskInput, runBtn, this.statusEl, this.logEl)
  }
}
