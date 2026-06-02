# my-page-agent

A **Page Agent–style** TypeScript library that runs in the browser, observes interactive DOM elements, asks an LLM what to do next, executes that action, and repeats until done. Works with any OpenAI-compatible endpoint — point it at OpenAI, Ollama, Groq, Azure OpenAI, LM Studio, or any compatible provider.

> This is an original MVP implementation for learning/prototyping.

## What it does

- Scans the current page for interactive elements (buttons, links, inputs, textareas, selects, ARIA roles, clickable/tabbable elements)
- Builds a text observation with stable numeric indexes for the current step
- Sends task + page observation + history to any OpenAI-compatible chat completions endpoint
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
- `src/llm/OpenAIClient.ts` — universal OpenAI-compatible `fetch` client + JSON parsing
- `src/llm/createLLMClient.ts` — client factory
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
  baseURL: 'https://your-proxy.com/v1',  // any OpenAI-compatible endpoint
  apiKey: 'YOUR_API_KEY',
  model: 'gpt-4o',
  maxSteps: 8,
})

await agent.execute('Fill the form and submit it')

// Optional helper UI
mountAgentPanel({ baseURL, apiKey, model })
```

## Supported LLM providers

Any provider that supports the OpenAI `/v1/chat/completions` format works. You control the choice by setting `baseURL`:

| Provider | `baseURL` | `apiKey` |
|---|---|---|
| OpenAI (via proxy) | `https://your-proxy.com/v1` | your key |
| Ollama (local) | `http://localhost:11434/v1` | `NA` |
| Groq | `https://api.groq.com/openai/v1` | your key |
| Azure OpenAI | `https://resource.openai.azure.com/openai/deployments/model` | your key |
| LM Studio / Jan | `http://localhost:1234/v1` | `NA` |
| Any custom proxy | `https://your-backend.com/v1` | proxy token |

### Ollama example

Run Ollama locally, pull any chat model, then point the agent at its `/v1` endpoint:

```bash
ollama pull llama3.2
```

```ts
const agent = new MyPageAgent({
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'NA',
  model: 'llama3.2',
  maxSteps: 8,
})
```

## Configuration

`MyPageAgent` accepts:

- `baseURL: string` — the `/v1` endpoint of any OpenAI-compatible service
- `apiKey: string` — API key or `'NA'` for local models with no auth
- `model: string` — model name (e.g. `'gpt-4o'`, `'llama3.2'`, `'qwen3:14b'`)
- `temperature?: number`
- `maxSteps?: number` (default `10`)
- `callbacks?: { onStatus?, onStep? }`
- `confirmAction?: (action) => boolean | Promise<boolean>` — safety gate before each action
- `allowDirectProvider?: boolean` — opt-in to call known provider hosts directly (NOT recommended in production)

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
