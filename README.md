# my-page-agent

An initial MVP of a **Page Agent–style** TypeScript library that runs in the browser, observes interactive DOM elements, asks an LLM what to do next, executes that action, and repeats until done. It supports OpenAI-compatible chat completions APIs and local Ollama models.

> This is an original MVP implementation for learning/prototyping.

## What it does

- Scans the current page for interactive elements (buttons, links, inputs, textareas, selects, ARIA roles, clickable/tabbable elements)
- Builds a text observation with stable numeric indexes for the current step
- Sends task + page observation + history to an OpenAI-compatible chat completions API or Ollama
- Expects JSON action output from the LLM
- Executes DOM actions and loops
- Includes a minimal floating panel UI and demo page

## Project structure

- `src/core/Agent.ts` — main agent loop
- `src/core/tools.ts` — action validation/normalization
- `src/core/prompt.ts` — prompt construction
- `src/core/types.ts` — shared TypeScript types
- `src/page-controller/PageController.ts` — page observation/action executor bridge
- `src/page-controller/domScanner.ts` — DOM scanning + indexed text rendering
- `src/page-controller/actions.ts` — DOM action implementations
- `src/llm/OpenAIClient.ts` — OpenAI-compatible `fetch` client + JSON parsing
- `src/llm/OllamaClient.ts` — Ollama package integration for local models
- `src/ui/Panel.ts` — floating UI panel
- `src/index.ts` — public API exports
- `src/main.ts` — demo entry point

## Development

```bash
npm install
npm run dev
```

Open the Vite URL shown in terminal.

### Available scripts

- `npm run dev` — run demo/dev server
- `npm run build` — typecheck + production build
- `npm run typecheck` — TypeScript checks
- `npm run lint` — lightweight lint via type checks
- `npm run test` — run unit tests (Vitest)

## Public API

```ts
import { MyPageAgent, mountAgentPanel } from 'my-page-agent'

const agent = new MyPageAgent({
  baseURL: 'https://api.openai.com/v1',
  apiKey: 'YOUR_API_KEY',
  model: 'gpt-4.1-mini',
  maxSteps: 8,
})

await agent.execute('Fill the form and submit it')

// Optional helper UI
mountAgentPanel({ baseURL, apiKey, model })
```

### Ollama example

Run Ollama locally, pull any chat model you want to use, then point the agent at it:

```bash
ollama pull llama3.2
```

```ts
import { MyPageAgent, mountAgentPanel } from 'my-page-agent'

const agent = new MyPageAgent({
  provider: 'ollama',
  baseURL: 'http://localhost:11434',
  model: 'llama3.2',
  maxSteps: 8,
})

await agent.execute('Fill the form and submit it')

mountAgentPanel({
  provider: 'ollama',
  baseURL: 'http://localhost:11434',
  model: 'llama3.2',
})
```

## Configuration

`MyPageAgent` accepts:

- `provider?: "openai"` — OpenAI-compatible chat completions API (default)
- `provider: "ollama"` — Ollama package integration
- `baseURL: string` — OpenAI-compatible API base URL, or Ollama host when `provider` is `"ollama"`
- `apiKey: string` — API key used in `Authorization: Bearer ...` for OpenAI-compatible APIs
- `model: string` — chat model name, including any locally installed Ollama model
- `temperature?: number`
- `maxSteps?: number` (default `10`)
- `callbacks?: { onStatus?, onStep? }`

## Action contract

The LLM should return JSON like:

```json
{
  "thought": "I should fill the name field first",
  "action": "input",
  "args": { "index": 1, "text": "Alice" }
}
```

Supported actions:

- `click` — `{ index }`
- `input` — `{ index, text }`
- `select` — `{ index, value }` or `{ index, text }`
- `scroll` — `{ direction: "up" | "down", amount? }`
- `wait` — `{ timeoutMs? }`
- `done` — `{ result? }`

Unknown/invalid actions fail with clear error messages.

## Demo

The default Vite app (`src/main.ts`) renders a simple form and mounts the floating panel automatically.

Use the panel to enter tasks like:

- `Fill name and email`
- `Select Developer in Role`
- `Click Submit Form`

## Limitations & security notes

- This MVP runs directly in the page context and can interact with visible interactive elements.
- It only sees a text abstraction of the DOM, not screenshots.
- Indexes are stable only for a single observation step and may change after DOM updates.
- LLM output is parsed and validated, but model mistakes can still produce poor actions.
- **Do not hardcode production API keys in browser code.** Browser-exposed keys are sensitive and can be extracted.
- Use sandbox/test pages first; agent actions can trigger real page side effects.
