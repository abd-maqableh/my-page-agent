# My Page Agent — Complete Codebase Explanation

> **Audience:** Junior developers reading this codebase for the first time.  
> **Style:** Every meaningful line is explained — what it does, why it exists, and how it fits into the overall system.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture at a Glance](#2-architecture-at-a-glance)
3. [`src/core/types.ts` — Shared Type Definitions](#3-srccoretypensts--shared-type-definitions)
4. [`src/core/tools.ts` — Action Validation & Normalization](#4-srccoretools-ts--action-validation--normalization)
5. [`src/core/prompt.ts` — LLM Prompt Builder](#5-srccorepromptts--llm-prompt-builder)
6. [`src/core/Agent.ts` — The Agent Loop](#6-srccoreagenttts--the-agent-loop)
7. [`src/llm/createLLMClient.ts` — LLM Factory](#7-srclllmcreatelllmclientts--llm-factory)
8. [`src/llm/OpenAIClient.ts` — Universal LLM Client](#8-srcllmopenaicllientts--universal-llm-client)
9. [`src/core/text.ts` — Text Normalization Helpers](#9-srccoretextts--text-normalization-helpers)
10. [`src/page-controller/domScanner.ts` — DOM Inspector](#10-srcpage-controllerdomscannercts--dom-inspector)
11. [`src/page-controller/actions.ts` — DOM Actions](#11-srcpage-controlleractionscts--dom-actions)
12. [`src/page-controller/PageController.ts` — Page Facade](#12-srcpage-controllerpage-controllerts--page-facade)
13. [`src/ui/Panel.ts` — The Floating UI Panel](#13-srcuipaneltts--the-floating-ui-panel)
14. [`src/index.ts` — Public API Entry Point](#14-srcindexts--public-api-entry-point)
15. [`src/main.ts` — Demo Application](#15-srcmaints--demo-application)
16. [How Everything Connects — End-to-End Flow](#16-how-everything-connects--end-to-end-flow)

---

## 1. Project Overview

**My Page Agent** is an in-browser AI agent that can read a web page and autonomously interact with it — clicking buttons, filling forms, selecting options, scrolling, and navigating — based on a plain-English instruction from the user.

The agent works in a loop:

1. **Observe** — Scan the current page for all visible interactive elements (buttons, inputs, etc.).
2. **Think** — Send the observation and the task to an LLM (e.g. GPT-4o via your proxy, or a local Llama model via Ollama's OpenAI-compatible endpoint).
3. **Act** — Execute the action the LLM decides (e.g. `click` button index 3, `input` text into field index 7).
4. **Repeat** — Go back to step 1 until the task is done or the step limit is reached.

The project is written entirely in **TypeScript** and runs directly in the browser (no Node.js server needed). It ships as a library that can be embedded into any web application.

---

## 2. Architecture at a Glance

```
src/
├── core/
│   ├── types.ts          ← All shared TypeScript interfaces & type aliases
│   ├── tools.ts          ← Validates & normalises raw LLM action JSON
│   ├── prompt.ts         ← Builds the system + user messages sent to the LLM
│   └── Agent.ts          ← The main observe → think → act loop
│
├── llm/
│   ├── createLLMClient.ts  ← Factory: always returns the universal OpenAIClient
│   └── OpenAIClient.ts     ← Universal client: works with Ollama, OpenAI proxy, Groq, Azure, etc.
│
├── page-controller/
│   ├── domScanner.ts       ← Reads the DOM, assigns numeric indexes to elements
│   ├── actions.ts          ← Executes click/input/select/scroll/navigate/etc.
│   └── PageController.ts   ← Thin facade combining scanner + actions
│
├── ui/
│   └── Panel.ts            ← Floating chat-style panel rendered into the page
│
├── index.ts                ← Public library API (MyPageAgent class + mountAgentPanel)
└── main.ts                 ← Demo page that wires everything together
```

**Data flows in one direction:**

```
User types a task
      ↓
  MyPageAgent.execute(task)
      ↓
    Agent.execute(task)           ← orchestrates the loop
      ↓   ↑
  PageController.observe()        ← reads current DOM state
  buildPrompt(task, obs, history) ← formats LLM input
  LLMClient.getNextAction(msgs)   ← calls Ollama / OpenAI
  PageController.executeAction()  ← runs the chosen action on the page
```

---

## 3. `src/core/types.ts` — Shared Type Definitions

This file is the **contract** for the entire project. Every other file imports types from here. TypeScript uses these types to catch mistakes at compile time.

```ts
export type AgentActionName =
  | 'click'
  | 'input'
  | 'select'
  | 'scroll'
  | 'wait'
  | 'navigate'
  | 'clear'
  | 'press_key'
  | 'hover'
  | 'done'
```

- **What:** A union type (a "one of these strings" type) listing every action the agent can perform.
- **Why:** Prevents the agent from ever producing an action like `"tap"` or `"submit"` — only the listed verbs are valid.
- **Used in:** `tools.ts` (validation), `actions.ts` (the `switch` statement), `prompt.ts` (the system message lists them for the LLM).

---

```ts
export type AgentActionArgs = {
  index?: number
  text?: string
  value?: string
  direction?: 'up' | 'down'
  amount?: number
  timeoutMs?: number
  result?: string
  url?: string
  key?: string
}
```

- **What:** Defines every possible argument that an action can carry. All fields are optional (`?`) because different actions need different args (e.g. `click` only needs `index`; `scroll` needs `direction` and `amount`).
- **Why:** Gives TypeScript (and developers) a precise, documented set of expected inputs.

---

```ts
export interface AgentAction {
  thought?: string
  action: AgentActionName
  args?: AgentActionArgs
}
```

- **What:** The exact shape of the JSON object the LLM is expected to return.
- **`thought`** – An optional reasoning string (the LLM "thinks out loud"). Helps with debugging but is not required.
- **`action`** – The action verb (must be one of `AgentActionName`).
- **`args`** – The action's arguments.

---

```ts
export interface PageElementSummary {
  index: number
  tag: string
  role?: string | null
  type?: string | null
  label: string
  description?: string
  /**
   * Whether this entry is an actionable control or a scroll-only page landmark.
   * Used to group the serialized observation into clearly separated blocks so the
   * model never clicks a SECTION when it should select/filter.
   */
  kind?: 'interactive' | 'section'
}
```

- **What:** A structured description of one element on the page, as seen by the agent.
- **`index`** – A stable 1-based number assigned to this element. The LLM refers to elements *only* by their index.
- **`tag`** – The HTML tag name (`button`, `input`, `a`, etc.).
- **`role`** – The ARIA role (`button`, `tab`, `combobox`, etc.) if the element has one.
- **`type`** – The `type` attribute of `<input>` elements (`text`, `email`, `checkbox`, etc.).
- **`label`** – A human-readable name (e.g. `"Submit"`, `"Request Status"`).
- **`description`** – A rich prose description built by `describeElement()` in `domScanner.ts`. Includes state (disabled/required/checked), input type, available options for dropdowns, selection mode (single/multi), and semantic hints like "Search box for keyword filtering" or "Filter dropdown (combobox)".
- **`kind`** – Either `'interactive'` (buttons, inputs, dropdowns) or `'section'` (chart cards, widget panels). The LLM's system prompt uses this to prevent the model from trying to click a section landmark.

---

```ts
export interface PageObservation {
  url: string
  title: string
  elements: PageElementSummary[]
  elementsText: string
}
```

- **What:** Everything the agent knows about the current page at a given moment.
- **`url`** – The current page URL (used to detect navigation).
- **`title`** – The `<title>` of the document.
- **`elements`** – The full structured list of interactive elements and section landmarks.
- **`elementsText`** – A **JSON-serialized** version of `elements` that goes directly into the LLM prompt. Now serialized as structured JSON (not plain text lines) so the LLM can parse `description` fields with dropdown options, states, etc.

---

```ts
export interface ActionExecutionResult {
  success: boolean
  message: string
  done?: boolean
}
```

- **What:** What every action returns after it runs.
- **`success`** – Did the action execute without error?
- **`message`** – A human-readable description of what happened (e.g. `"Clicked element 3"`).
- **`done`** – Set to `true` only by the `done` action, signalling the agent should stop.

---

```ts
export interface AgentHistoryEntry {
  step: number
  observation: string
  action: AgentAction
  result: ActionExecutionResult
}
```

- **What:** One entry in the agent's memory — a record of what it saw, what it decided, and what happened.
- **Why:** Passed back to the LLM in subsequent steps so it doesn't repeat itself.

---

```ts
export interface AgentCallbacks {
  onStatus?: (status: string) => void
  onStep?: (entry: AgentHistoryEntry) => void
  /**
   * Two-phase flow only. Called after Phase 1 navigation so the host can
   * show the iframe and wait for it to load, then resolve the promise to
   * signal Phase 2 can start scanning the new DOM.
   */
  onPageReady?: () => Promise<void>
}
```

- **What:** Optional event hooks the consumer can attach to observe the agent's progress.
- **`onStatus`** – Fired with a short status string each time the agent moves to a new phase (e.g. `"Step 2: asking model"`).
- **`onStep`** – Fired at the end of each step with the full history entry.
- **`onPageReady`** – Two-phase flow only. After Phase 1 navigates to a new page, the agent calls this. The host shows the iframe, waits for it to finish loading, then resolves the promise. This signals Phase 2 can start scanning the DOM.
- **Why:** Decouples the agent from the UI — the Panel listens to these callbacks to update the display.

---

```ts
export interface ActionQueueItemResult {
  action: AgentAction
  result: ActionExecutionResult
}

export interface ActionQueueResult {
  items: ActionQueueItemResult[]
  /** True only when an explicit `done` action (or result.done) ended the queue. */
  done: boolean
  /** Set when an action failed; carries the failure message. */
  error?: string
}
```

- **`ActionQueueItemResult`** – Pairs an action with its execution result. One entry per action in a batch.
- **`ActionQueueResult`** – The result of executing a batch of actions. `items` contains the ordered results. `done` is `true` when an explicit `done` action ended the batch. `error` is set when any action in the batch failed.

---

```ts
export interface AgentRunResult {
  status: 'done' | 'error' | 'max_steps'
  history: AgentHistoryEntry[]
  message: string
}
```

- **What:** The final result returned by `agent.execute()`.
- **`status`** – How the run ended: success, error, or hit the step limit.
- **`history`** – Complete log of every step (useful for debugging or displaying to the user).
- **`message`** – A human-readable summary.

---

```ts
export interface LLMClient {
  /**
   * Ask the model for the next action(s). Returning more than one action lets the
   * agent run a whole batch (e.g. apply several filters, then `done`) from a SINGLE
   * API round-trip instead of one call per action.
   */
  getNextActions(messages: ChatMessage[]): Promise<AgentAction[]>
}
```

- **`LLMClient`** – An interface (a contract) that `OpenAIClient` must satisfy. The `Agent` only depends on this interface, making it easy to add new providers without touching the agent code.
- **`getNextActions`** – Returns an **array** of `AgentAction` (not a single action). This supports **batching**: the LLM can return `[{select: "Active"}, {select: "Mining"}, {done: "Filters applied"}]` in one API call, dramatically reducing latency compared to one API round-trip per action.

---

```ts
export interface LLMConfig {
  baseURL: string
  apiKey: string
  model: string
  temperature?: number
  /** Cap on generated tokens per call. Low cap (256–800) prevents slow, runaway generation. */
  maxTokens?: number
  /** When true, request response_format: { type: 'json_object' } for structured output. */
  jsonMode?: boolean
  /** Abort a single request after this many ms via AbortController. */
  requestTimeoutMs?: number
  allowDirectProvider?: boolean
}
```

- **What:** Universal configuration for any OpenAI-compatible endpoint.
- **`baseURL`** – The API endpoint. Point it at any compatible service:
  - Ollama local: `http://localhost:11434/v1`
  - OpenAI proxy: `https://your-proxy.com/v1`
  - Groq: `https://api.groq.com/openai/v1`
  - Azure OpenAI: `https://your-resource.openai.azure.com/openai/deployments/gpt-4o`
- **`apiKey`** – The bearer token. Use `'NA'` for local models with no authentication.
- **`model`** – Model identifier (e.g. `"gpt-4o"`, `"llama3.2"`, `"qwen3:14b"`).
- **`temperature`** – Randomness of responses (0 = deterministic).
- **`maxTokens`** – Caps `max_tokens` in the API request. The agent only needs small JSON actions; a low cap prevents runaway generation on verbose models.
- **`jsonMode`** – Requests `response_format: { type: 'json_object' }` so compatible servers (vLLM, SGLang, OpenAI) return ONLY valid JSON — this also suppresses long prose/think-traces.
- **`requestTimeoutMs`** – Aborts stuck inferences via `AbortController` so they fail fast instead of hanging.
- **`allowDirectProvider`** – Security opt-in; see `OpenAIClient.ts` for details.

---

```ts
export interface AgentConfigBase {
  /** Optional injected client for deterministic tests or custom runtimes. */
  llmClient?: LLMClient
  maxSteps?: number
  callbacks?: AgentCallbacks
  /** When true, uses two-phase flow: Phase 1 (navigate) → Phase 2 (interact). */
  twoPhase?: boolean
  /** The iframe's initial URL, provided by the host. Updated after each navigation. */
  currentUrl?: string
  confirmAction?: (action: AgentAction) => boolean | Promise<boolean>
  targetFrame?: HTMLIFrameElement
  pages?: Record<string, string | PageDescriptor>
}

export interface PageDescriptor {
  path: string
  sections?: string[]
  subPages?: Record<string, string | PageDescriptor>
}

export type AgentConfig = LLMConfig & AgentConfigBase
```

- **`maxSteps`** – Hard cap on loop iterations. Default is 10. Prevents infinite loops.
- **`confirmAction`** – A safety gate. Before executing any action, the agent calls this function if provided. If it returns `false`, the run aborts. Useful for production pages where you don't want the agent to accidentally submit a form.
- **`targetFrame`** – If set, the agent operates inside an `<iframe>` instead of the main window. Used for split-screen demo modes.
- **`pages`** – A name-to-location mapping for navigation. Each value is **either** a plain path string (`{ "Users": "/users" }`) **or** a `PageDescriptor` object that also declares the page's in-page `sections` and nested `subPages`.
- **`PageDescriptor`** – Rich description of a known page:
  - **`path`** – URL path the agent navigates to.
  - **`sections`** – Names of in-page sections (chart cards, widgets, panels) the user can scroll/jump to. They should match the on-page section headings (or `data-agent-section` attributes) so the DOM scanner can surface them as `SECTION:` landmarks after navigation. This lets the agent resolve a cross-page request like "show me Sales Performance" — it navigates to the owning page first, then scrolls to the section.
  - **`subPages`** – Nested sub-pages reachable from this page (label → path or descriptor).
- **`AgentConfig`** – The final config type combines LLM settings AND agent behaviour settings into one object.

---

```ts
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
```

- **What:** The standard OpenAI chat message format. Every LLM call is a list of these.
- **`role: 'system'`** – Sets the LLM's behaviour and rules.
- **`role: 'user'`** – The current task + page observation.
- **`role: 'assistant'`** – (Not used here, but part of the interface for completeness.)

---

## 4. `src/core/tools.ts` — Action Validation & Normalization

This file contains two functions that sit between the raw LLM output and the code that actually runs actions on the page.

```ts
const VALID_ACTIONS: AgentActionName[] = [
  'click', 'input', 'select', 'clear', 'press_key',
  'hover', 'scroll', 'wait', 'navigate', 'done'
]
```

- **What:** A runtime list of all valid action names, mirroring the `AgentActionName` type.
- **Why:** TypeScript types disappear at runtime. This array lets us check validity with a simple `includes()` call when we receive raw JSON from the LLM.

---

```ts
export function isValidActionName(action: string): action is AgentActionName {
  return VALID_ACTIONS.includes(action as AgentActionName)
}
```

- **What:** A **type guard** function. It checks if a string is a valid action name.
- **`action is AgentActionName`** – This special TypeScript return type tells the compiler: "if this function returns true, treat the argument as `AgentActionName` from that point on."
- **Why:** Lets us safely narrow the type when parsing untrusted LLM output.

---

```ts
export function normalizeAction(input: unknown): AgentAction {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid action payload: expected object.')
  }
```

- **`input: unknown`** – We accept anything here because we're parsing raw JSON. `unknown` forces us to check the type before using it — safer than `any`.
- The guard throws immediately if the input isn't an object at all.

---

```ts
  const raw = input as Record<string, unknown>
  if (!isValidActionName(String(raw.action ?? ''))) {
    throw new Error(`Invalid action: ${String(raw.action ?? 'unknown')}`)
  }
```

- `raw` – Cast to a dictionary type so we can read its properties.
- `String(raw.action ?? '')` – Coerce to string safely; `??` gives `''` if `action` is `null` or `undefined`.
- If the action name is not in our list (e.g. the LLM made up `"tap"`), we throw immediately.

---

```ts
  const flatArgs: Record<string, unknown> = {}
  const ARG_KEYS = ['index', 'text', 'value', 'direction', 'amount', 'timeoutMs', 'result', 'url', 'key']
  for (const key of ARG_KEYS) {
    if (key in raw) flatArgs[key] = raw[key]
  }
```

- **Why:** Some smaller LLMs (e.g. local Llama models) return flat JSON like `{"action":"click","index":3}` instead of properly nested JSON like `{"action":"click","args":{"index":3}}`.
- This loop collects any known arg keys from the top level of the raw object as a fallback.

---

```ts
  const argsValue = raw.args && typeof raw.args === 'object' ? raw.args : undefined
  const mergedArgs: Record<string, unknown> =
    argsValue !== undefined
      ? { ...(argsValue as Record<string, unknown>) }
      : Object.keys(flatArgs).length > 0
        ? { ...flatArgs }
        : {}
```

- **What:** Picks the best source for args. If the LLM returned a proper `args` object, use it. Otherwise, fall back to the flat args we just collected. If neither has content, use an empty object.
- **Why:** Makes the agent work with both well-behaved large models and quirky small models.

---

```ts
  const INDEX_ACTIONS = ['click', 'input', 'select', 'clear', 'hover']
  if (INDEX_ACTIONS.includes(String(raw.action)) && mergedArgs.index === undefined) {
    const thought = typeof raw.thought === 'string' ? raw.thought : ''
    const match = thought.match(/\[(\d+)\]/) ?? thought.match(/element\s+(\d+)/i)
    if (match) {
      mergedArgs.index = parseInt(match[1], 10)
    }
  }
```

- **What:** A last-resort recovery. If an action that *requires* an index (like `click`) somehow has no `index`, we scan the model's `thought` text for patterns like `"element [5]"` or `"element 5"` and extract the number.
- **Why:** Some models write the index in their thought but forget to put it in `args`.

---

```ts
  const args = Object.keys(mergedArgs).length > 0 ? (mergedArgs as AgentAction['args']) : undefined

  return {
    thought: typeof raw.thought === 'string' ? raw.thought : undefined,
    action: raw.action as AgentActionName,
    args,
  }
}
```

- Returns a clean, typed `AgentAction` object. `args` is `undefined` (not `{}`) when empty — consistent with the type definition.

---

```ts
export function normalizeActions(input: unknown): AgentAction[] {
  if (Array.isArray(input)) {
    return input.map((item) => normalizeAction(item))
  }
  if (input && typeof input === 'object' && Array.isArray((input as Record<string, unknown>).actions)) {
    const obj = input as Record<string, unknown>
    const sharedThought = typeof obj.thought === 'string' ? obj.thought : undefined
    return (obj.actions as unknown[]).map((item) => {
      // Propagate top-level thought to batched actions that lack their own
      if (sharedThought && item && typeof item === 'object' &&
          !('thought' in (item as Record<string, unknown>))) {
        return normalizeAction({ thought: sharedThought, ...(item as Record<string, unknown>) })
      }
      return normalizeAction(item)
    })
  }
  return [normalizeAction(input)]
}
```

- **What:** Normalizes a model response into a LIST of actions. Supports THREE shapes:
  1. A single action object: `{"action":"select","args":{...}}` → `[action]`
  2. An object with an `actions` array: `{"thought":"...","actions":[{...},{...}]}` → `[action, action]`
  3. A bare array: `[{...},{...}]` → `[action, action]`
- **`sharedThought`** – If the wrapper object has a top-level `thought`, it's propagated to any batched action that lacks its own `thought`.
- **Why:** The LLM can now return batches of actions in one response. `normalizeActions` handles all the shapes a model might emit, wrapping everything into a consistent `AgentAction[]`.

---

## 5. `src/core/prompt.ts` — LLM Prompt Builder

This file is responsible for constructing the exact messages sent to the LLM. The prompt system is now **split into two functions** to support the two-phase execution flow.

- **`buildNavigationPrompt(task, pages, currentUrl?)`** — Phase 1 only. Minimal prompt with NO DOM elements. The LLM only decides which page to `navigate` to. Lists all known pages with their paths and declared sections.
- **`buildInteractionPrompt(task, observation, pages?, completedSteps?)`** — Phase 2 (and single-phase). Full DOM scan with filter map, completed steps, and all interaction rules. This is the main prompt for all DOM interactions.
- **`buildFilterMap(elements)`** — Helper that builds a "value → dropdown index" lookup table from scanned combobox elements, so the LLM doesn't need to parse JSON to find which dropdown has which option.
- **`formatPagePaths(pages, indent?)`** — Recursively flattens the `pages` map into aligned `label → url` lines with inline section hints.
- **`buildPrompt`** — **Deprecated** alias for `buildInteractionPrompt`, kept for backward compatibility.

The original single-prompt design (`buildPrompt`) is still available but the split design means Phase 1 never wastes tokens on DOM elements the LLM can't yet see, and Phase 2 benefits from a focused interaction-only system message.

```ts
import type { AgentHistoryEntry, ChatMessage, PageDescriptor, PageObservation } from './types'
  if (!history.length) {
    return 'No prior actions.'
  }

  return history
    .slice(-MAX_HISTORY_ENTRIES)
    .map((item) => {
      return [
        `Step ${item.step}`,
        `Action: ${item.action.action} ${JSON.stringify(item.action.args ?? {})}`,
        `Result: ${item.result.success ? 'success' : 'error'} - ${item.result.message}`,
      ].join('\n')
    })
    .join('\n\n')
}
```

- **What:** Converts the history array into a readable plain-text block.
- **`slice(-MAX_HISTORY_ENTRIES)`** – Takes only the *last* 8 entries. If there are 20 steps, steps 1–12 are dropped.
- **Why:** The LLM needs to know what it already tried so it doesn't repeat a failed action.
- **Example output:**
  ```
  Step 1
  Action: click {"index":3}
  Result: success - Clicked element 3
  
  Step 2
  Action: input {"index":5,"text":"John"}
  Result: success - Entered text into element 5
  ```

---

```ts
export function buildPrompt(
  task: string,
  observation: PageObservation,
  history: AgentHistoryEntry[],
  pages?: Record<string, string | PageDescriptor>,
): ChatMessage[] {
```

- **`task`** – The user's instruction (e.g. `"Fill the form with my name John and submit"`).
- **`observation`** – The current state of the page (URL, title, element list).
- **`history`** – What the agent has done so far in this run.
- **`pages`** – Optional page map for navigation rules. Values may be plain paths or `PageDescriptor` objects (with `sections` / `subPages`).
- Returns `ChatMessage[]` — an array ready to be sent directly to the LLM.

---

```ts
  const navigationRules: string[] = []
  if (pages && Object.keys(pages).length > 0) {
    const pathLines = formatPagePaths(pages)
    navigationRules.push(
      ' 11. NAVIGATION RULE: ...',
      ` 12. KNOWN PAGE PATHS — use these exact values for \`navigate\`:\n${pathLines}`,
      ' 13. COMBINED NAVIGATE + NARROW + ITEM ACTION: ...',
      ' 13b. BUTTON-VS-NAVIGATE RULE: ...',
    )
    if (hasDeclaredSections(pages)) {
      navigationRules.push(' 12b. CROSS-PAGE SECTION RULE: ...')
    }
  }
```

- **What:** Dynamically appends navigation-specific rules *only when* a page map was provided.
- **Why:** These rules tell the LLM exactly which paths to use for `navigate` actions. Without them, the LLM would guess URLs and likely get a 404.
- **`formatPagePaths(pages)`** – Helper that flattens the (possibly nested) `pages` map into aligned `label → path` lines. When a page declares `sections`, it appends an inline `[sections: A, B, C]` hint; `subPages` are rendered indented with a `↳` marker.
- **`hasDeclaredSections(pages)`** – Recursively checks whether any page (or sub-page) declares `sections`. Only then is **Rule 12b (CROSS-PAGE SECTION RULE)** added: it tells the LLM that when the user asks for a section name, it must first `navigate` to the owning page (if not already there), then follow the SECTION FOCUS RULE (24) to `scroll` to the matching `SECTION: <name>` element — never calling `done` after only navigating.


---

```ts
  const system = [
    'You are a browser page agent. Your ONLY output is a single JSON object — no markdown, no explanation.',
    'Schema: {"thought":"<why>","action":"<name>","args":{<args>}}',
    'Actions and their REQUIRED args:',
    '  click     → args: {"index": <number>}',
    // ... more actions
    'Rules:',
    '  1. Always include "index" for click/input/select/clear/hover — pick from the elements list.',
    // ... many more rules
  ].join('\n')
```

- **What:** The **system prompt** — the LLM's operating instructions. It tells the model its role, what format to output, every action with its args, and 24 carefully crafted rules.
- **Why each rule exists:**
  - Rules 1–4: Basic JSON discipline — always include index, don't invent indexes, use `done` when finished, output only JSON.
  - Rule 5: Dropdown filtering — explains how `FILTER DROPDOWN` elements work.
  - Rule 6–7: Search vs. filter — prevents the model from trying to `select` a name from a dropdown.
  - Rule 8: Context menus — tells the model about per-item action menus.
  - Rules 9–10: Completion rules — prevents premature `done` calls.
  - Rules 15–24: Handle modals, form validation, checkboxes, date pickers, disabled elements, read-only tasks, etc.
- **Design principle:** Every rule was added to fix a specific real-world failure mode.

---

```ts
  const user = [
    `Task: ${task}`,
    `Page: ${observation.title} (${observation.url})`,
    'Interactive elements (index • tag • label):',
    observation.elementsText || '(none found)',
    'History:',
    formatHistory(history),
    'Your JSON action:',
  ].join('\n\n')
```

- **What:** The **user message** — the per-step context. Tells the LLM:
  1. What the user wants to accomplish.
  2. What page it's currently on.
  3. Every visible interactive element with its index and label.
  4. What it has done so far.
- **`'Your JSON action:'`** – A cue that tells the model "respond with the JSON now". This is a common prompting technique called an *output primer*.

---

```ts
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}
```

- Returns two messages: the system prompt (static rules) and the user message (dynamic context). This is the standard OpenAI chat format.

---

## 6. `src/core/Agent.ts` — The Agent Loop

This is the **brain** of the project. It orchestrates the observe → think → act cycle. Now supports **two execution modes**:

- **Two-phase** (`twoPhase: true`): Phase 1 decides which page to navigate to (no DOM needed), Phase 2 interacts with the loaded page DOM.
- **Single-phase** (default): Direct interaction with the current page, using batch actions for efficiency.

Both modes use **batch actions** — the LLM returns an `AgentAction[]` array, allowing multiple actions per API round-trip (e.g. apply several filters then `done`).

```ts
import { createLLMClient } from '../llm/createLLMClient'
import { PageController } from '../page-controller/PageController'
import { buildNavigationPrompt, buildInteractionPrompt } from './prompt'
import type { AgentConfig, AgentHistoryEntry, AgentRunResult, LLMClient } from './types'
```

- **Why each import:** The agent needs an LLM client (to get batches of actions), a PageController (to observe and act on the page), and BOTH prompt builders — `buildNavigationPrompt` for Phase 1 navigation and `buildInteractionPrompt` for Phase 2 interaction.

---

```ts
export class Agent {
  private readonly client: LLMClient
  private readonly pageController: PageController
  private readonly callbacks?: AgentConfig['callbacks']
  private readonly confirmAction?: AgentConfig['confirmAction']
  private readonly pages?: AgentConfig['pages']
  private readonly twoPhase: boolean
```

- **`client: LLMClient`** – Typed as the *interface*, not a concrete class. This is **dependency inversion**. Can also be injected via `config.llmClient` for tests.
- **`twoPhase`** – When `true` AND `pages` is provided AND `callbacks.onPageReady` exists, the agent uses the two-phase flow.
  private readonly client: LLMClient
  private readonly pageController: PageController
  private readonly callbacks?: AgentConfig['callbacks']
  private readonly confirmAction?: AgentConfig['confirmAction']
  private readonly pages?: AgentConfig['pages']
```

- **`private readonly`** – Fields are set once in the constructor and never reassigned. `private` means external code cannot access them directly.
- **`client: LLMClient`** – Typed as the *interface*, not a concrete class. This is **dependency inversion** — the agent doesn't care if it's talking to Ollama or OpenAI.

---

```ts
  constructor(config: AgentConfig) {
    this.maxSteps = config.maxSteps ?? 10
    this.client = createLLMClient(config)
    this.pageController = new PageController(config.targetFrame)
    this.callbacks = config.callbacks
    this.confirmAction = config.confirmAction
    this.pages = config.pages
  }
```

- **`config.maxSteps ?? 10`** – If `maxSteps` is not provided, default to 10. The `??` (nullish coalescing) operator returns the right side only when the left is `null` or `undefined`.
- **`createLLMClient(config)`** – The factory decides which client to instantiate based on `config.provider`.
- **`new PageController(config.targetFrame)`** – Passing `targetFrame` lets the agent control an `<iframe>` instead of the main page.

---

```ts
  async execute(task: string): Promise<AgentRunResult> {
    if (!task.trim()) {
      throw new Error('Task is required.')
    }

    const history: AgentHistoryEntry[] = []
```

- **`async`** – Because calling the LLM is an asynchronous network request, the whole method is `async`.
- **`task.trim()`** – Validates that the task isn't blank or just whitespace. Failing fast with a clear error is better than producing confusing LLM output.
- **`history`** – Starts empty and grows with each step. It is the agent's short-term memory.

---

```ts
    for (let step = 1; step <= this.maxSteps; step += 1) {
```

- The main loop. Counts steps from 1. When `step` exceeds `maxSteps`, the loop exits and the run is terminated with `status: 'max_steps'`.

---

```ts
      this.callbacks?.onStatus?.(`Step ${step}: observing page`)
      const observation = this.pageController.observe()
```

- **`?.`** – Optional chaining. If `callbacks` is `undefined`, or `onStatus` is `undefined`, nothing happens (no error).
- **`observe()`** – Scans the current page for interactive elements and returns a `PageObservation`. This is the agent's "eyes".

---

```ts
      this.callbacks?.onStatus?.(`Step ${step}: asking model`)
      const messages = buildPrompt(task, observation, history, this.pages)

      let action
      try {
        action = await this.client.getNextAction(messages)
      } catch (error) {
        return {
          status: 'error',
          history,
          message: error instanceof Error ? error.message : 'Failed to get model action',
        }
      }
```

- **`buildPrompt`** – Formats the observation and history into LLM messages.
- **`await this.client.getNextAction(messages)`** – Sends the messages to the LLM and waits for a response. This is the network call.
- **`try/catch`** – If the LLM call fails (network error, API error), the agent returns an `error` result immediately instead of crashing.
- **`error instanceof Error ? error.message : '...'`** – Safe error message extraction. In JavaScript, anything can be `throw`n, so we check the type before accessing `.message`.

---

```ts
      this.callbacks?.onStatus?.(`Step ${step}: executing ${action.action}`)

      if (this.confirmAction) {
        const allowed = await this.confirmAction(action)
        if (!allowed) {
          return {
            status: 'error',
            history,
            message: `Action "${action.action}" was rejected by confirmAction.`,
          }
        }
      }
```

- **`confirmAction`** – The safety gate. If the consumer provided this function, it's called with the proposed action. If it returns `false`, the run stops. Useful for auditing or blocking dangerous actions (e.g. preventing `navigate` to external URLs).

---

```ts
      const prevUrl = observation.url

      const result = await this.pageController.executeAction(action)
```

- **`prevUrl`** – Saved *before* executing so we can compare with the URL *after* the action to detect navigation.
- **`executeAction`** – Runs the action on the DOM. Returns whether it succeeded and a description.

---

```ts
      if (action.action === 'click' || action.action === 'input' || action.action === 'select') {
        await new Promise<void>((resolve) => setTimeout(resolve, 600))
      }
```

- **What:** After DOM-mutating actions, we wait 600ms before observing again.
- **Why:** React and other frameworks re-render asynchronously. If we observe immediately after a click, we might see the DOM in an intermediate state (e.g. a dropdown that hasn't opened yet, or validation errors that haven't appeared yet).
- **`new Promise<void>((resolve) => setTimeout(resolve, 600))`** – Creates an awaitable delay. `<void>` means this promise doesn't resolve with a value.

---

```ts
      const nextObsForUrl = this.pageController.observe()
      const nextUrl = nextObsForUrl.url
      const navigated = action.action === 'click' && nextUrl !== prevUrl
```

- **What:** After the delay, observe the page again — but this observation is only used to check for URL changes.
- **`navigated`** – `true` if a click caused the URL to change. Used to detect links that navigate to new pages.

---

```ts
      const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
      const navigatedToDetail = navigated && UUID_RE.test(nextUrl) && !UUID_RE.test(prevUrl)
```

- **`UUID_RE`** – A regular expression that matches a UUID (e.g. `550e8400-e29b-41d4-a716-446655440000`).
- **`navigatedToDetail`** – Detects "list → detail" navigation patterns, where clicking an item in a list takes you to a detail page with a UUID in the URL. This is a common pattern in admin dashboards.

---

```ts
      const annotatedResult = navigated
        ? { ...result, message: `${result.message} → navigated to ${nextUrl}` }
        : result
```

- **`{ ...result, message: '...' }`** – Object spread creates a *new* object with all of `result`'s properties, but overrides `message`. The original `result` is unchanged (immutability).
- **Why:** Enriches the history with navigation information so the LLM (and the developer reading logs) knows a page transition occurred.

---

```ts
      const entry: AgentHistoryEntry = {
        step,
        observation: observation.elementsText,
        action,
        result: annotatedResult,
      }
      history.push(entry)
      this.callbacks?.onStep?.(entry)
```

- Appends the completed step to history and notifies any listeners (e.g. the Panel UI).

---

```ts
      if (!result.success) {
        return { status: 'error', history, message: result.message }
      }
```

- If the action failed (e.g. `"Element not found for index 5"`), the loop stops immediately. Attempting the next step on a broken state would just compound the error.

---

```ts
      if (action.action === 'click' && !navigated) {
        const menuItems = nextObsForUrl.elements.filter((el) => el.label.startsWith('MENU ITEM:'))
        if (menuItems.length > 0) {
          const taskLower = task.toLowerCase()
          const isViewIntent = /\b(view|open|see|show|details?|look)\b/.test(taskLower)
          const isEditIntent = /\b(edit|update|modify|change)\b/.test(taskLower)
          const target =
            menuItems.find((el) => isViewIntent && el.label.toLowerCase().includes('view')) ??
            menuItems.find((el) => isEditIntent && el.label.toLowerCase().includes('edit')) ??
            menuItems[0]
          // ... auto-clicks the menu item
        }
      }
```

- **MENU AUTO-CLICK logic:** When the agent clicks a "⋯" (ellipsis) button to open a context menu, a new set of `MENU ITEM:` elements appears in the DOM. Instead of sending another LLM request (which wastes time and money), the agent automatically clicks the menu item that best matches the user's intent.
- **`/\b(view|open|see...)\b/.test(taskLower)`** – `\b` is a word boundary in regex, ensuring we match whole words only (e.g. "view" but not "overview").
- **`?? menuItems[0]`** – If no intent-matched item is found, click the first available menu item as a fallback.

---

```ts
      if (navigatedToDetail) {
        this.callbacks?.onStatus?.('Done')
        return {
          status: 'done',
          history,
          message: `Navigated to ${nextUrl}`,
        }
      }
```

- **Why:** When the agent has navigated to a detail page (URL contains UUID), the task of "open/view this item" is considered complete. The agent stops instead of trying to do more on the detail page.

---

```ts
      if (action.action === 'done' || result.done) {
        this.callbacks?.onStatus?.('Done')
        return {
          status: 'done',
          history,
          message: result.message,
        }
      }
    }
```

- **Normal completion:** When the LLM returns `{"action":"done","args":{"result":"Form submitted successfully"}}`, the loop ends with `status: 'done'`.

---

```ts
    return {
      status: 'max_steps',
      history,
      message: `Stopped after ${this.maxSteps} steps.`,
    }
  }
}
```

- **What:** The fallthrough case. If the loop exhausts all `maxSteps` without hitting `done` or `error`, this is returned.
- **Why:** Prevents infinite loops. The consumer can inspect the history to understand why the task didn't complete.

---

## 7. `src/llm/createLLMClient.ts` — LLM Factory

```ts
import { OpenAIClient } from './OpenAIClient'
import type { LLMClient, LLMConfig } from '../core/types'

export function createLLMClient(config: LLMConfig): LLMClient {
  return new OpenAIClient(config)
}
```

- **What:** A simple **factory function** — always creates an `OpenAIClient`.
- **Why:** The `Agent` calls `createLLMClient(config)` without needing to know which client class is used. The provider is selected by the user via `baseURL` — no `provider` flag needed.
- **How to use any LLM:** Just point `baseURL` at the provider's OpenAI-compatible endpoint. Ollama, Groq, LM Studio, Azure OpenAI, and custom proxies all work this way.

---

## 8. `src/llm/OpenAIClient.ts` — Universal LLM Client

This file handles communication with **any** OpenAI-compatible REST API. The main method is now `getNextActions` (returns `AgentAction[]` for batching), and the config supports `maxTokens`, `jsonMode`, and `requestTimeoutMs`.

```ts
interface ChatCompletionsResponse {
  choices?: Array<{
    message?: {
      content?: string | null
    }
    finish_reason?: string | null
  }>
  // OpenAI returns { error: { message } }; native Ollama errors can be { error: "string" }.
  error?: { message?: string } | string
}
```

- **What:** A TypeScript interface for the shape of the API response.
- **`finish_reason`** – Added to detect `'length'` (truncation) and surface an actionable error instead of a confusing JSON parse failure.
- **`error`** – Can be either an OpenAI-style object `{ message: "..." }` or a bare string (Ollama). The `readErrorMessage` helper handles both.

---

```ts
function extractJSON(text: string): string {
  // ... finds the FIRST JSON value — either { } or [ ] — and returns it
  // via balanced-bracket extraction. Supporting arrays lets the model emit
  // a batch of actions (e.g. [{select},{select},{done}]) in one response.
```

- **What:** Now supports extracting both `{...}` objects AND `[...]` arrays. Walks the string maintaining brace/bracket-depth to find the first complete JSON value.
- **Why:** The model can now return a bare array like `[{"action":"select","args":...},{"action":"done",...}]` directly, which our `normalizeActions` handles.

---

```ts
export function parseAgentActions(raw: string): AgentAction[] {
  let payload: unknown
  try {
    payload = JSON.parse(extractJSON(raw))
  } catch (error) {
    throw new Error(`Failed to parse LLM JSON response: ...`)
  }
  const actions = normalizeActions(payload)
  if (actions.length === 0) {
    throw new Error('LLM response contained no valid action.')
  }
  return actions
}
```

- **What:** Replaces `parseAgentActionResponse`. Parses the LLM response into **one or more** actions (supports batched arrays).
- **`normalizeActions(payload)`** – Handles single action objects, `{actions:[...]}` wrappers, and bare arrays.

---

```ts
export function parseAgentActionResponse(raw: string): AgentAction {
  return parseAgentActions(raw)[0]
}
```

- **What:** Backward-compatible wrapper. Returns only the **first** action from `parseAgentActions`.

---

```ts
export class OpenAIClient implements LLMClient {
  async getNextActions(messages: ChatMessage[]): Promise<AgentAction[]> {
    // ... POSTs to /chat/completions with:
    //   - model, temperature, messages
    //   - max_tokens (if config.maxTokens is set)
    //   - response_format: { type: 'json_object' } (if config.jsonMode is true)
    //   - AbortController timeout (if config.requestTimeoutMs is set)
    //
    // Logs request/response timing to console with color-coded groups.
    // Checks finish_reason === 'length' for truncation errors.
    // Returns parseAgentActions(content).
  }
}
```
    let escaped = false
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i]
      if (escaped) { escaped = false; continue }
      if (ch === '\\' && inString) { escaped = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return candidate.slice(start, i + 1)
      }
    }
  }

  throw new Error('LLM response did not include a JSON object.')
}
```

- **What:** A **bracket-balancing** JSON extractor. It finds the first `{`, then counts opening and closing braces (tracking whether we're inside a string to avoid being fooled by `{` or `}` inside quoted values). When `depth` returns to 0, we've found the matching closing `}`.
- **Why:** Some models append extra text after the JSON object. `JSON.parse` would fail on `{"action":"click"}Here is what I did...`. This approach robustly isolates just the JSON.

---

```ts
export function parseAgentActionResponse(raw: string): AgentAction {
  let payload: unknown
  try {
    payload = JSON.parse(extractJSON(raw))
  } catch (error) {
    throw new Error(`Failed to parse LLM JSON response: ${error instanceof Error ? error.message : 'invalid json'}`)
  }

  return normalizeAction(payload)
}
```

- **What:** The two-step response parser: extract JSON text → parse JSON → normalize/validate the action.
- **Why it's exported:** Reusable by any future custom client implementations.

---

```ts
const DIRECT_PROVIDER_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.mistral.ai',
  'api.cohere.ai',
  'api.cohere.com',
  'api.groq.com',
  'api.together.xyz',
]
```

- **What:** A list of well-known AI provider hostnames.
- **Why:** API keys sent from a browser page are visible in the browser's network tab and in client-side JavaScript. If a developer accidentally sets `baseURL` to `https://api.openai.com`, their key is exposed to anyone who visits the page. This list lets us warn them.

---

```ts
function assertSafeBaseURL(baseURL: string, allowDirectProvider: boolean | undefined): void {
  let host: string
  try {
    host = new URL(baseURL).hostname.toLowerCase()
  } catch {
    throw new Error(`OpenAIClient: invalid baseURL "${baseURL}"`)
  }

  if (!allowDirectProvider && DIRECT_PROVIDER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new Error(
      `OpenAIClient: refusing to send the API key directly to "${host}" from the browser. ` +
        'Route requests through a backend proxy you control, or pass `allowDirectProvider: true` ' +
        'to acknowledge the risk (NOT recommended for production).',
    )
  }
}
```

- **What:** A security check that runs at construction time.
- **`new URL(baseURL).hostname`** – Parses the URL to extract just the hostname (e.g. `"api.openai.com"` from `"https://api.openai.com/v1"`). If `baseURL` isn't a valid URL, `new URL()` throws.
- **`host.endsWith(`.${h}`)`** – Also catches subdomains like `enterprise.api.openai.com`.
- **`allowDirectProvider: true`** – An explicit opt-in that says "I know the risks". Useful for development or internal tools.

---

```ts
export class OpenAIClient implements LLMClient {
  private readonly config: LLMConfig

  constructor(config: LLMConfig) {
    assertSafeBaseURL(config.baseURL, config.allowDirectProvider)
    this.config = config
  }
```

- The security check runs first. If it throws, the client is never created.

---

```ts
  async getNextAction(messages: ChatMessage[]): Promise<AgentAction> {
    const baseURL = this.config.baseURL.replace(/\/$/, '')
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: this.config.temperature,
        messages,
      }),
    })
```

- **`baseURL.replace(/\/$/, '')`** – Removes a trailing slash from the base URL, so the final URL doesn't look like `https://proxy.example.com//chat/completions`.
- **`fetch`** – The browser's native HTTP API. No third-party HTTP library needed.
- **`Authorization: Bearer ${...}`** – The OpenAI API authentication format.
- **`JSON.stringify`** – Converts the request body object to a JSON string for the HTTP body.

---

```ts
    const data = (await response.json()) as ChatCompletionsResponse

    if (!response.ok) {
      throw new Error(data.error?.message ?? `LLM request failed with status ${response.status}`)
    }

    const content = data.choices?.[0]?.message?.content
    if (!content) {
      throw new Error('LLM did not return message content.')
    }

    return parseAgentActionResponse(content)
  }
}
```

- **`response.ok`** – `true` if the HTTP status code is 200–299.
- **`data.error?.message`** – The OpenAI error format includes an `error.message` field. If it's present, use it; otherwise fall back to the HTTP status code.
- **`data.choices?.[0]?.message?.content`** – Deep optional chaining through the response structure. If any level is `undefined` (empty response, unexpected shape), `content` is `undefined`.

---

## 9. `src/core/text.ts` — Text Normalization Helpers

This file provides **Unicode-aware text normalization** used across the DOM scanner, action executors, and intent router. It handles Arabic diacritics, letter variants, filler words, and plural/article canonicalization — all essential for matching section names, dropdown options, and filter values in a bilingual (Arabic/English) application.

```ts
function normalizeArabic(s: string): string {
  return s
    .replace(/[\u064B-\u065F\u0670]/g, '') // harakat / diacritics
    .replace(/\u0640/g, '') // tatweel
    .replace(/[أإآٱ]/g, 'ا')  // unify alef variants
    .replace(/ة/g, 'ه')        // teh marbuta → heh
    .replace(/ى/g, 'ي')        // alef maqsura → yeh
}
```

- **What:** Strips Arabic diacritical marks (fatha, damma, kasra, sukun, shadda, etc.), the tatweel (kashida) elongation character, and normalizes common letter variants to a canonical form.
- **Why:** Arabic text can be written with or without diacritics, and certain letters have multiple forms (e.g. أ, إ, آ, ٱ are all variants of alef). Without normalization, "الطلبات" and "الطَّلَبَات" would not match, and cross-page section lookups would fail.

---

```ts
export function normalizeText(s: string): string {
  return normalizeArabic(s.toLowerCase()).replace(/\s+/g, ' ').trim()
}
```

- **What:** The primary normalization entry point. Lowercases the string, applies Arabic normalization, collapses all whitespace sequences to a single space, and trims.
- **Why:** This is the foundation for ALL fuzzy comparisons in the codebase — `looseMatch`, `meaningfulWords`, `findMatchingOption` in actions.ts, and section matching in domScanner.ts all call this first.

---

```ts
const FILLER_WORDS = new Set([
  // English
  'the', 'a', 'an', 'and', 'by', 'for', 'of', 'in', 'on', 'at', 'to', 'me', 'my',
  'please', 'can', 'you', 'i', 'want', 'show', 'open', 'go', 'goto', 'take',
  'navigate', 'view', 'display', 'page', 'screen', 'section', 'widget',
  'chart', 'panel', 'tab', 'overview',
  // Arabic
  'في', 'الي', 'إلي', 'علي', 'من', 'عن', 'او', 'و', 'ثم', 'لو', 'سمحت',
  'اعرض', 'أعرض', 'اظهر', 'أظهر', 'افتح', 'إفتح', 'انتقل', 'إنتقل', 'اذهب',
  'خذني', 'وديني', 'صفحه', 'قسم', 'شاشه', 'لوحه', 'اريد', 'أريد', 'ابغي', 'ممكن',
])
```

- **What:** A set of words that carry no semantic meaning for section/filter matching — articles, conjunctions, navigation verbs, and generic UI terms.
- **Why:** When matching a user request like "show me the Sales Performance chart" against a section titled "Sales Performance", the words "show", "me", "the", "chart" should be ignored. Only the meaningful words "Sales" and "Performance" should drive the match. This applies to both English and Arabic.

---

```ts
function canonicalWord(w: string): string {
  let out = w
  if (/^\p{Script=Arabic}/u.test(out) && out.length > 4 && out.startsWith('ال')) out = out.slice(2)
  if (/^[a-z0-9]+$/.test(out) && out.length > 4) out = out.replace(/(es|s)$/, '')
  return out
}
```

- **What:** Produces a canonical word form for set comparison.
- **`/^\p{Script=Arabic}/u`** — Unicode property escape that matches any Arabic-script character. This is how we detect the script without hardcoding Arabic Unicode ranges.
- **`out.startsWith('ال')`** — Strips the Arabic definite article "ال" (al-, meaning "the") so "الطلبات" and "طلبات" compare equal.
- **`out.replace(/(es|s)$/, '')`** — Strips trailing English plural suffixes so "applications" and "application" compare equal.
- **Why:** Ensures singular/plural and definite/indefinite forms match. Without this, "الطلبات" would not match "طلبات" and every section lookup would require exact spelling.

---

```ts
export function meaningfulWords(s: string): string[] {
  return normalizeText(s)
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !FILLER_WORDS.has(w))
    .map(canonicalWord)
}
```

- **What:** Splits a string into its meaningful, normalized words.
- **`/[^\p{L}\p{N} ]/gu`** — Removes everything that's not a Unicode letter, digit, or space. This strips punctuation, emoji, and special characters while preserving Arabic script.
- **`filter((w) => w.length >= 2 && !FILLER_WORDS.has(w))`** — Drops single-character words and filler/navigation words.
- **`map(canonicalWord)`** — Canonicalizes each remaining word.
- **Why:** This is the core word extraction logic used by the DOM scanner's section matching pass. When scanning for declared sections like "Sales Performance", each heading's text is processed through `meaningfulWords` and compared against the declared section name's `meaningfulWords`.

---

```ts
export function containsAllWords(text: string, label: string): boolean {
  const textWords = new Set(meaningfulWords(text))
  const labelWords = meaningfulWords(label)
  return labelWords.length > 0 && labelWords.every((w) => textWords.has(w))
}
```

- **What:** Returns `true` when every meaningful word of `label` appears in `text`'s word set.
- **Why:** This is an "all-words-contained" check — it ensures the label is a subset of the text, not an exact match. So "Sales Performance This Month" would match a heading that says "Sales Performance" because both meaningful words appear.

---

```ts
export function looseMatch(a: string, b: string): boolean {
  const na = normalizeText(a)
  const nb = normalizeText(b)
  if (!na || !nb) return false
  return na === nb || na.includes(nb) || nb.includes(na)
}
```

- **What:** Bidirectional containment match on normalized strings. Returns `true` if either normalized string contains the other.
- **Why:** Used by action executors for option/value matching in dropdowns. If the LLM says `"active"` but the dropdown option is `"Active"` or `"Show Active Only"`, `looseMatch` still finds the match.

---

**Usage across the codebase:**

| Consumer | Functions Used | Purpose |
|---|---|---|
| `domScanner.ts` | `meaningfulWords` | Match declared section names against heading text for the SECTION pass |
| `actions.ts` | `normalizeText`, `looseMatch` | Fuzzy option/value matching in `findMatchingOption`, `selectOnDropdown`, and `findByText` |
| Intent router | `containsAllWords` | Match user intent keywords against menu items and page labels |

---

## 10. `src/page-controller/domScanner.ts` — DOM Inspector

This is the largest and most complex file. It is responsible for "seeing" the page — turning raw HTML elements into a structured, numbered list that the LLM can reason about.

```ts
import type { PageElementSummary } from '../core/types'

export interface ScanResult {
  elements: PageElementSummary[]
  elementMap: Map<number, Element>
  text: string
}
```

- **`elements`** – Structured array of found elements.
- **`elementMap`** – A `Map` (dictionary) from index number → DOM `Element`. This is the lookup table used by `actions.ts` to find the actual element when the LLM says `{"index": 3}`.
- **`text`** – The pre-formatted string version, ready to paste into the LLM prompt.

---

```ts
const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="treeitem"]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')
```

- **What:** A CSS selector string that matches every element a user (or agent) could possibly interact with.
- **Why it's comprehensive:** Modern web apps use custom components with ARIA roles instead of native HTML elements. A component library button might be a `<div role="button">`, not a `<button>`. We must catch both.
- **`[tabindex]:not([tabindex="-1"])`** – Elements with a positive tabindex are keyboard-focusable and thus interactive. `tabindex="-1"` means programmatically focusable but not in the tab order.

---

```ts
function isVisible(el: Element, win: Window & typeof globalThis): boolean {
  if (typeof (el as HTMLElement).focus !== 'function') {
    return false
  }

  if (el.closest('[aria-hidden="true"], [inert]')) {
    return false
  }

  const rect = (el as HTMLElement).getBoundingClientRect()
  const style = win.getComputedStyle(el as HTMLElement)
  if (style.pointerEvents === 'none') return false
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
}
```

- **What:** Determines whether an element is truly visible and interactable.
- **`typeof (el as HTMLElement).focus !== 'function'`** – Non-HTML elements (like SVG elements) might not have `focus`. If so, they're not interactable.
- **`el.closest('[aria-hidden="true"], [inert]')`** – Even if an element is technically on the page, if it (or an ancestor) is `aria-hidden` or `inert`, it's hidden from assistive technology and should be hidden from the agent too.
- **`getBoundingClientRect()`** – Returns the element's size and position. Elements with `width: 0` or `height: 0` are invisible.
- **`style.pointerEvents === 'none'`** – CSS can disable clicks on an element. We treat those as non-interactable.

---

```ts
function stateSuffix(el: Element): string {
  const parts: string[] = []
  const ariaDisabled = el.getAttribute('aria-disabled') === 'true'
  const disabled = (el as HTMLInputElement).disabled === true || ariaDisabled
  // ... checks for readOnly, required, invalid, expanded, pressed, current, checked
  return parts.length ? ` (${parts.join(', ')})` : ''
}
```

- **What:** Generates a state string like `" (disabled, required)"` or `" (checked)"`.
- **Why:** The LLM needs to know an element's current state. A disabled submit button shouldn't be clicked. A `(required)` field must be filled. A `(checked)` toggle shouldn't be toggled again.
- **`(el as HTMLInputElement).disabled`** – TypeScript doesn't know that all `Element`s have `disabled`; only `HTMLInputElement` does. The cast tells TypeScript we're intentionally accessing this.

---

```ts
function getInputPrefix(el: HTMLInputElement): string | null {
  const type = (el.type || 'text').toLowerCase()
  switch (type) {
    case 'search':   return 'SEARCH BOX'
    case 'date':     return 'DATE PICKER'
    case 'file':     return 'FILE UPLOAD'
    case 'number':   return 'NUMBER INPUT'
    case 'email':    return 'EMAIL INPUT'
    case 'password': return 'PASSWORD INPUT'
    case 'checkbox': return 'CHECKBOX'
    case 'radio':    return 'RADIO'
    case 'submit':   return 'SUBMIT BUTTON'
    // ...
    default:         return null
  }
}
```

- **What:** Maps HTML input `type` attributes to semantic prefix strings.
- **Why:** Instead of the LLM seeing `input:email "email"`, it sees `"EMAIL INPUT: email"`. The prefix tells the LLM what type of interaction is expected (type text, pick a date, upload a file, etc.).

---

```ts
function detectDateFormat(el: HTMLInputElement): string | null {
  const ph = (el.placeholder || '').trim()
  if (!ph) return null
  if (/^[YMDHmsAP]{1,4}([/\-. :])[YMDHmsAP]{1,4}(\1[YMDHmsAP]{1,4})*$/i.test(ph)) {
    return ph
  }
  return null
}
```

- **What:** Detects custom date input fields (like those from MUI X DatePicker) that use `type="text"` but have a date-format placeholder like `MM/DD/YYYY`.
- **Why:** If the LLM doesn't know the expected format, it might type `2023-08-15` into a field that expects `08/15/2023` and the picker silently rejects it.
- **Regex explanation:** `[YMDHmsAP]{1,4}` matches date/time placeholder letters; `([/\-. :])` captures the separator; `\1` backreference ensures all separators match (e.g. all `/` or all `-`).

---

```ts
function getLabel(el: Element): string {
  const aria = el.getAttribute('aria-label')?.trim()
  const labelledBy = ariaLabelledByText(el)
  const title = el.getAttribute('title')?.trim()
  const baseText = aria || labelledBy || title || ''
```

- **What:** The main labelling function. For each element, it tries to find the best human-readable description.
- **Priority order:** `aria-label` → `aria-labelledby` (reads text from another element) → `title` attribute → derived from content.

---

The `getLabel` function then handles each element type specifically:

- **`HTMLInputElement`** – Uses `getInputPrefix`, then reads from `labels`, `placeholder`, or `name`.
- **`HTMLTextAreaElement`** – Reads from `labels` or `placeholder`.
- **`HTMLSelectElement`** – Returns `"FILTER DROPDOWN: <currently selected option>"`.
- **`HTMLButtonElement[type=submit]`** – Returns `"SUBMIT BUTTON: <text>"`.
- **`role="tab"`** – Returns `"TAB: <text>"` with `(active)` if currently selected.
- **`role="combobox"`** – Returns `"FILTER DROPDOWN: <text>"`.
- **`role="menuitem"`** – Returns `"MENU ITEM: <text>"`.
- **`role="switch"`** – Returns `"TOGGLE: <text>"`.
- **Ellipsis/icon-only buttons** – These have no text. The function walks up the DOM to find a card/row ancestor and returns `"Per-item actions menu (Card Title)"`.

These standardised prefixes are crucial — the LLM's system prompt has rules keyed to these exact prefixes (e.g. `STATUS FILTER RULE` targets `FILTER DROPDOWN`, `CHECKBOX / TOGGLE RULE` targets `TOGGLE`).

---

```ts
function findOpenModal(doc: Document): Element | null {
  const candidates = new Set<Element>()
  doc.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]').forEach((el) => candidates.add(el))

  const MODAL_HINT = /\b(modal|dialog|drawer|overlay|sheet)\b/i
  const NON_BLOCKING = /\b(popover|menu|tooltip|snackbar|toast|notification|backdrop)\b/i
  doc.querySelectorAll('[class]').forEach((el) => {
    const cls = el.getAttribute('class') || ''
    if (!MODAL_HINT.test(cls) || NON_BLOCKING.test(cls)) return
    candidates.add(el)
  })
  // ... pick the topmost visible candidate
}
```

- **What:** Detects if a modal dialog is currently open.
- **Why:** When a modal is open, the agent should ONLY interact with elements inside the modal. The background page elements are visually dimmed and non-interactive. Ignoring this leads to the agent clicking things it shouldn't be able to see.
- **Two detection strategies:**
  1. Semantic (ARIA roles) — reliable for well-built components.
  2. CSS class heuristic — catches framework modals that don't always set ARIA roles (e.g. some older Bootstrap modals).

---

```ts
export function scanInteractiveElements(
  root: ParentNode = document,
  win: Window & typeof globalThis = window,
): ScanResult {
  const doc: Document = ...
  const openModal = findOpenModal(doc)

  const all = Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR))
  const seen = new Set<Element>()

  const uniqueVisible = all.filter((el) => {
    if (seen.has(el) || !isVisible(el, win)) return false
    if (el.closest('[data-agent-panel]')) return false
    if (openModal && !openModal.contains(el)) return false
    // ... dedupe wrapper+input patterns
    seen.add(el)
    return true
  })
```

- **`root.querySelectorAll(INTERACTIVE_SELECTOR)`** – Finds all matching elements in the DOM.
- **`Array.from(...)`** – Converts the `NodeList` to a regular JavaScript array (for `.filter()`, `.map()`, etc.).
- **`el.closest('[data-agent-panel]')`** – Excludes the agent's own floating panel. If the panel itself had a "Run Agent" button, the agent might try to click it — that would be a circular disaster.
- **`openModal && !openModal.contains(el)`** – When a modal is open, filters out all elements NOT inside the modal.
- **Deduplication:** Some UI libraries render both a wrapper button and an inner checkbox input. Only the wrapper should be listed (it has the readable label; our `doClick` action handles forwarding clicks to the inner input automatically).

---

```ts
  const elementMap = new Map<number, Element>()
  const elements: PageElementSummary[] = uniqueVisible.map((el, i) => {
    const index = i + 1    // 1-based indexing
    elementMap.set(index, el)

    const rawLabel = getLabel(el)
    const label = openModal ? `[MODAL] ${rawLabel}` : rawLabel

    return { index, tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), type: getType(el), label }
  })
```

- **`i + 1`** – Elements are indexed starting from 1, not 0. This matches the human convention ("element 1") and avoids bugs where `index 0` might be falsy.
- **`openModal ? '[MODAL] ${rawLabel}'`** – Prefixes each element's label with `[MODAL]` when a dialog is open. The LLM's system prompt Rule 15 says to only interact with `[MODAL]` elements.

---

**The SECTION PASS** (the second part of `scanInteractiveElements`):

```ts
  if (!openModal) {
    // ... find data-agent-section elements
    // ... find heading+chart containers heuristically
    sections.forEach(({ el, name }) => {
      const index = elements.length + 1
      elementMap.set(index, el)
      elements.push({ index, tag: ..., role: ..., type: null, label: `SECTION: ${name}` })
    })
  }
```

- **What:** After cataloguing interactive elements, the scanner also finds "section" containers (chart cards, widget panels, etc.) and adds them as non-interactive `SECTION:` elements.
- **Why:** This lets the LLM use `scroll {index}` to scroll a specific section into view when the user asks "show me the Revenue Chart".
- **Two detection strategies:**
  1. Explicit `data-agent-section="Chart Name"` attribute — app developers can opt-in specific sections.
  2. Heuristic — finds containers that have a heading AND contain a chart/table/list (three levels of filtering to avoid false positives).

---

## 11. `src/page-controller/actions.ts` — DOM Actions

This file contains all the functions that physically interact with the DOM — clicking, typing, selecting, scrolling, etc. Now uses `normalizeText` and `looseMatch` from `text.ts` for fuzzy matching. Supports 10 action types via individual `do*` functions and batch execution via `runActionQueue`.

```ts
import { normalizeText } from '../core/text'
// ...
function findMatchingOption(value: string, options: string[]): string | undefined {
  const normalizedQuery = normalizeText(value)
  return options.find((option) => {
    const normalizedOption = normalizeText(option)
    return normalizedOption === normalizedQuery ||
           normalizedOption.includes(normalizedQuery) ||
           normalizedQuery.includes(normalizedOption)
  })
}
```

- **What:** A three-way bidirectional fuzzy match using `normalizeText` from `text.ts`. Matches exact, contains, or contained-by — all case-insensitive and Arabic-aware.
- **Why:** The LLM might say `"active"` but the dropdown option is `"Active"` or `"Show Active Only"`. This handles all cases without requiring the LLM to guess the exact option text.

---

New actions added since the original version:

| Action | Handler | Description |
|---|---|---|
| `clear` | `doClear` | Clears `<input>`, `<textarea>`, or `contentEditable` using the native prototype setter (to trigger React's change detection). |
| `press_key` | `doPressKey` | Dispatches `keydown` → `keypress` → `keyup` sequence. Maps common key names (`enter`, `escape`, `tab`, `arrowup`, etc.) to their key codes. |
| `hover` | `doHover` | Dispatches `mouseover` → `mouseenter` → `mousemove` events on the target element. |

---

```ts
export async function runActionQueue(
  actions: AgentAction[],
  elementMap: Map<number, Element>,
  doc: Document = document,
  win: Window & typeof globalThis = window,
): Promise<ActionQueueResult>
```

- **What:** Executes a batch of actions in order. Stops on the first failed action or explicit `done`. Returns `{ items, done, error? }` where `items` pairs each action with its result.
- **Why:** The LLM now returns arrays of actions. This runs them sequentially without additional API round-trips, dramatically reducing latency for multi-action tasks like "apply filter A and filter B".

**Key improvements in existing actions:**

- **`doSelect` / `selectOnDropdown`**: Now handles MUI comboboxes robustly — opens via `mousedown` → `mouseup` → `click`, waits for the listbox portal, matches options using `normalizeText`, types into the input for search-as-you-type comboboxes, dismisses with Escape after selection, and returns available options on mismatch. Also includes **robust target resolution**: if the model targets a non-dropdown element, `findDropdownForValue` redirects to the dropdown whose options actually contain the requested value.
- **`doInput`**: Now fires `blur` after input (needed by masked date pickers) and uses `InputEvent` with `inputType: 'insertFromPaste'` (needed by mask libraries).
- **`doNavigate`**: Now polls `document.readyState` until `'complete'` instead of a fixed sleep, with a 4s cap.
      const el = doc.querySelector(selector)
      if (el) return resolve(el)
      if (Date.now() - start < timeoutMs) setTimeout(check, 50)
      else resolve(null)
    }
    setTimeout(check, 50)
  })
}
```

- **What:** A polling function that repeatedly checks for a DOM element to appear, up to `timeoutMs` milliseconds.
- **Why:** When clicking a combobox, the dropdown portal renders asynchronously. We can't immediately query for `[role="listbox"]` — it might not exist yet.
- **`setTimeout(check, 50)`** – Checks every 50ms. Not too aggressive (doesn't block the browser), not too slow.
- **`resolve(null)` on timeout** – Returns `null` instead of throwing, so callers can handle the "not found" case gracefully.

---

```ts
function getElement(index: number | undefined, args: AgentAction['args'], elementMap: Map<number, Element>): Element {
  if (index !== undefined && index !== null) {
    const el = elementMap.get(index)
    if (el) return el
    throw new Error(`Element not found for index ${index}`)
  }

  const candidates = Object.values(args ?? {}).filter((v): v is string => typeof v === 'string')
  for (const candidate of candidates) {
    const numMatch = candidate.match(/\[(\d+)\]/) ?? candidate.match(/^(\d+)$/)
    if (numMatch) {
      const el = elementMap.get(parseInt(numMatch[1], 10))
      if (el) return el
    }
    const el = findByText(candidate, elementMap)
    if (el) return el
  }

  throw new Error('Missing required arg: index')
}
```

- **What:** Resolves an `index` argument to an actual DOM `Element`.
- **Primary path:** `elementMap.get(index)` — direct O(1) lookup by number.
- **Fallback 1:** Extract a number from a string in args like `"[5]"` or `"5"`.
- **Fallback 2:** Text search — scan all element labels for a match. Handles cases where a model describes an element by name instead of index.
- **Why fallbacks:** Defensive programming. Even with the best prompting, a model occasionally formats its output unexpectedly.

---

```ts
function doClick(index, args, elementMap, doc, win): Promise<ActionExecutionResult> {
  const el = getElement(index, args, elementMap)
  (el as HTMLElement).focus()
```

- **`.focus()`** – Mimics the browser's natural behavior — when a user clicks an element, the browser focuses it first. Some components (e.g. React event-driven ones) behave differently without focus.

---

```ts
  if (el.getAttribute('role') === 'combobox') {
    el.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, cancelable: true, view: win }))
    el.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, cancelable: true, view: win }))
    el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, view: win }))
    return waitForElement('[role="listbox"]', 1500, doc).then(...)
  }
```

- **Why dispatch mousedown + mouseup + click:** Most `<button>` elements respond to `click`. But custom combobox components (MUI, Headless UI, Radix) often listen for `mousedown` because they need to prevent the default focus-stealing behavior of `click`. Dispatching all three events covers both patterns.
- **`bubbles: true`** – Events bubble up the DOM tree, as they would from a real user interaction.
- **`view: win`** – The `window` object for this event. Required for `MouseEvent`.

---

```ts
  const innerToggle = el.querySelector('input[type="checkbox"], input[type="radio"]') as HTMLInputElement | null
  if (innerToggle && el !== innerToggle && !(el instanceof HTMLInputElement)) {
    innerToggle.click()
    return Promise.resolve({ success: true, message: `Clicked element ${index} (toggled inner ${innerToggle.type})` })
  }
```

- **Why:** Toggle/switch components in MUI, Chakra, etc. render as `<label>` or `<button>` wrapping a hidden `<input type="checkbox">`. Clicking the wrapper alone doesn't toggle the checkbox — event propagation is often stopped by the framework. We must click the inner `<input>` directly.

---

```ts
  const isSubmit =
    (el as HTMLButtonElement).type === 'submit'
    || el.closest('form') !== null && /save|create|submit|confirm|apply|update/i.test(...)
  if (isSubmit) {
    return new Promise((resolve) => {
      win.setTimeout(() => resolve({ success: true, ... }), 700)
    })
  }
```

- **Why the 700ms delay:** After clicking a submit button, the form may run async validation (network requests, complex state updates). If we snapshot the page immediately after the click, validation errors might not have appeared yet. The delay gives them time to surface.

---

```ts
function doInput(index, text, args, elementMap, win): ActionExecutionResult {
  // ...
  const proto = tag === 'input' ? win.HTMLInputElement.prototype : win.HTMLTextAreaElement.prototype
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (nativeSetter) {
    nativeSetter.call(inputEl, text)
  } else {
    inputEl.value = text
  }
```

- **Why the native setter trick:** In React, form elements are "controlled" — their `value` is managed by React state. Directly setting `inputEl.value = text` bypasses React's internal state tracker, so the input appears filled but React doesn't know about it (so submitting the form would send the old empty value).
- The fix: use the **native prototype setter** (from before React wrapped it with a custom setter). When called, this triggers React's change detection, making it think the user typed the value.

---

```ts
  const InputEventCtor = (win as unknown as { InputEvent?: typeof InputEvent }).InputEvent
  if (InputEventCtor) {
    el.dispatchEvent(new InputEventCtor('input', { bubbles: true, data: text, inputType: 'insertFromPaste' }))
  } else {
    el.dispatchEvent(new win.Event('input', { bubbles: true }))
  }
  el.dispatchEvent(new win.Event('change', { bubbles: true }))
  el.dispatchEvent(new win.FocusEvent('blur', { bubbles: true }))
  if (typeof inputEl.blur === 'function') inputEl.blur()
```

- **`inputType: 'insertFromPaste'`** – Masked input libraries (date pickers, phone number formatters) inspect `inputType` to decide how to process the event. `insertFromPaste` signals "this is a whole value being pasted" and causes them to parse the full string at once.
- **`blur`** – Many masked date pickers only commit (validate and reformat) the value on blur. Without firing blur, the input might revert visually.

---

```ts
async function doSelect(index, value, args, elementMap, doc, win): Promise<ActionExecutionResult> {
  // Native <select>
  if (el.tagName.toLowerCase() === 'select') {
    const match = Array.from(selectEl.options).find((option) => {
      const optText = option.text.toLowerCase()
      const optValue = option.value.toLowerCase()
      return optText === normalizedQuery || optValue === normalizedQuery
        || optText.includes(normalizedQuery) || normalizedQuery.includes(optText)
        || optValue.includes(normalizedQuery) || normalizedQuery.includes(optValue)
    })
```

- **Why fuzzy matching:** The LLM might say `"active"` but the actual option value is `"Active"` (capitalized) or `"ACTIVE"`. The six-way comparison handles case differences and substring containment, making selection robust.

---

```ts
function doScroll(direction, amount, index, args, elementMap, win): ActionExecutionResult {
  if (index !== undefined && index !== null) {
    const el = getElement(index, args, elementMap)
    (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' })
    const html = el as HTMLElement
    const prev = html.style.outline
    html.style.outline = '2px solid var(--agent-focus-color, #1976d2)'
    win.setTimeout(() => { html.style.outline = prev }, 1500)
    return { success: true, message: `Scrolled element ${index} into view` }
  }
  // ...
}
```

- **`scrollIntoView`** – Smoothly scrolls the viewport until the element is visible.
- **Outline highlight:** Adds a blue border around the focused section for 1.5 seconds so the user can visually see what the agent scrolled to.
- **`var(--agent-focus-color, #1976d2)`** – Uses a CSS variable with a default fallback. App developers can override the highlight color with `--agent-focus-color`.
- **`prev`** – Saves the element's previous outline value so restoring it doesn't clear a pre-existing outline style.

---

```ts
async function doNavigate(url: string, win: Window & typeof globalThis): Promise<ActionExecutionResult> {
  if (!url) throw new Error('Missing required arg: url')
  win.location.href = url
  await new Promise((resolve) => setTimeout(resolve, 1800))
  return { success: true, message: `Navigated to ${url}` }
}
```

- **`win.location.href = url`** – Triggers a browser navigation. For SPAs (Single Page Applications), this is handled by the router; for traditional apps, it loads a new page.
- **1800ms delay** – SPA routers (React Router, Vue Router) need time to match the new route and re-render the page. The agent waits before observing again.

---

```ts
function doPressKey(index, key, args, elementMap, doc, win): ActionExecutionResult {
  // ...
  const keyMap: Record<string, { key: string; code: string; keyCode: number }> = {
    enter:    { key: 'Enter',    code: 'Enter',    keyCode: 13 },
    escape:   { key: 'Escape',   code: 'Escape',   keyCode: 27 },
    // ...
  }
  const info = keyMap[key.toLowerCase()] ?? { key, code: key, keyCode: 0 }

  for (const type of ['keydown', 'keypress', 'keyup'] as const) {
    target?.dispatchEvent(new win.KeyboardEvent(type, { key: info.key, code: info.code, keyCode: info.keyCode, bubbles: true, cancelable: true }))
  }
}
```

- **Why dispatch all three events:** Some listeners are on `keydown`, others on `keyup` or `keypress`. For maximum compatibility, we dispatch all three in sequence, just like a real keystroke.
- **`keyCode`** – A legacy property. Modern code uses `key`, but many older libraries still check `keyCode`.
- **`?? { key, code: key, keyCode: 0 }`** – If the key isn't in our map (e.g. `"a"`, `"F5"`), fall through with a best-effort generic event.

---

```ts
export async function runAction(action: AgentAction, elementMap: Map<number, Element>, doc = document, win = window): Promise<ActionExecutionResult> {
  try {
    switch (action.action) {
      case 'click':    return doClick(...)
      case 'input':    return doInput(...)
      case 'select':   return doSelect(...)
      case 'scroll':   return doScroll(...)
      case 'wait':     return doWait(...)
      case 'navigate': return doNavigate(...)
      case 'clear':    return doClear(...)
      case 'press_key':return doPressKey(...)
      case 'hover':    return doHover(...)
      case 'done':     return { success: true, message: action.args?.result ?? 'Agent marked task as done.', done: true }
      default:         return { success: false, message: `Unknown action: ...` }
    }
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : 'Unknown execution error' }
  }
}
```

- **What:** The dispatcher — the single entry point that routes an `AgentAction` to the correct `do*` function.
- **`try/catch` around the whole thing** – If ANY action throws (e.g. element not found), the error is caught and returned as a failed `ActionExecutionResult` instead of crashing the agent loop.
- **`done` case** – Not an actual DOM action. It just signals the run is complete by setting `done: true`.

---

## 12. `src/page-controller/PageController.ts` — Page Facade

```ts
import type { AgentAction, ActionExecutionResult, ActionQueueResult, PageObservation } from '../core/types'
import { runAction, runActionQueue } from './actions'
import { scanInteractiveElements } from './domScanner'

export class PageController {
  private elementMap = new Map<number, Element>()
  private readonly targetFrame?: HTMLIFrameElement
  private readonly declaredSections: string[]
  private fallbackUrl = ''
```

- **`elementMap`** – Persisted across calls. When `observe()` runs, it updates this map. When `executeAction()` / `executeActionQueue()` runs, it uses this map.
- **`declaredSections`** – Section names from the `pages` config, passed to the scanner for `SECTION:` landmark generation.
- **`fallbackUrl`** – Stored URL for cross-origin iframe scenarios where `contentWindow.location` is inaccessible.

---

**New/changed methods:**

**`readUrl(): string`**  
Safely reads the current URL, returning `""` on cross-origin errors. Keeps `fallbackUrl` in sync when readable.

**`getEffectiveUrl(): string`**  
Always returns a URL: real iframe URL when readable, otherwise the fallback provided by the host.

**`setFallbackUrl(url: string): void`**  
Stores a fallback URL. Called by the Agent after each navigation so the URL stays accurate for cross-origin iframes.

**`waitForStability(idleMs = 180, maxMs = 1500): Promise<void>`**  
Uses `MutationObserver` to wait until the DOM is quiet (no mutations for `idleMs`), capped at `maxMs`. Much faster than fixed sleeps on quick pages, more reliable on slow ones (async renders, React portals).

**`executeActionQueue(actions: AgentAction[]): Promise<ActionQueueResult>`**  
Calls `runActionQueue(actions, elementMap, doc, win)`, then waits for stability after each `click`/`input`/`select` action. Returns the full `ActionQueueResult`.

## 13. `src/ui/Panel.ts` — The Floating UI Panel

This file creates the visible UI — a floating panel that the user types tasks into and watches results appear.

```ts
export interface PanelController {
  execute(task: string): Promise<AgentRunResult>
  onStatus(handler: (status: string) => void): void
  onStep(handler: (line: string) => void): void
}
```

- **What:** An interface for the Panel's dependency. The Panel doesn't import `MyPageAgent` directly — it only uses this interface.
- **Why this pattern:** Inversion of control / dependency injection. Makes the Panel testable in isolation (you can pass a mock controller) and decoupled from the agent implementation.

---

```ts
export class Panel {
  private static readonly MAX_LOG_ENTRIES = 8

  private readonly controller: PanelController
  private readonly root: HTMLDivElement
  private readonly taskInput: HTMLTextAreaElement
  private readonly statusEl: HTMLDivElement
  private readonly logEl: HTMLUListElement
```

- **`private static readonly MAX_LOG_ENTRIES`** – A class-level constant shared by all Panel instances. `static` means it belongs to the class itself, not to each instance.
- **`root`** – The outermost container div. All other elements are children of this.
- All DOM elements are created in the constructor, stored as fields, and reused throughout the component's lifecycle.

---

```ts
  constructor(controller: PanelController) {
    this.controller = controller
    this.root = document.createElement('div')
    this.taskInput = document.createElement('textarea')
    this.statusEl = document.createElement('div')
    this.logEl = document.createElement('ul')
    this.render()
    this.bindControllerEvents()
  }
```

- Creates all DOM elements, then calls `render()` (to style and structure them) and `bindControllerEvents()` (to hook up callbacks).

---

```ts
  mount(parent: ParentNode = document.body): void {
    parent.appendChild(this.root)
  }
```

- **`parent: ParentNode = document.body`** – Default argument: if no parent is specified, append to `document.body`. The `= document.body` is evaluated at call time, making it flexible.

---

```ts
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
```

- **`onStatus`** – Updates the status line each time the agent changes phase.
- **`onStep`** – Adds a new log entry at the **top** (`prepend`) each time a step completes, so the most recent step is always visible first.
- **`while (...) removeChild`** – Keeps the log capped at 8 entries. If there were 9 items, the oldest one (last child) is removed. This prevents the panel from growing infinitely.

---

```ts
  private render(): void {
    Object.assign(this.root.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '2147483647',
      width: '360px',
      background: '#0f172a',
      color: '#f8fafc',
      border: '1px solid #334155',
      borderRadius: '12px',
      // ...
    })
```

- **`Object.assign(element.style, {...})`** – A concise way to set multiple inline CSS properties at once.
- **`zIndex: '2147483647'`** – The maximum value for `z-index` (2^31 - 1). Ensures the panel renders on top of everything else on the page, even modals.
- **`position: 'fixed'`** – The panel stays in the bottom-right corner even when the page scrolls.
- **`#0f172a` / `#f8fafc`** – Tailwind CSS-style dark background and light text.

---

```ts
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
```

- **`runBtn.disabled = true`** – Prevents double-clicking. While the agent is running, the button is disabled.
- **`try/finally`** – `finally` runs whether the agent succeeded, failed, or threw. This guarantees the button is always re-enabled, even if something unexpected happens.

---

## 14. `src/index.ts` — Public API Entry Point

This is the file a consumer imports when using the library. It wraps the internal `Agent` class in a clean, minimal public interface.

```ts
export class MyPageAgent {
  private readonly config: AgentConfig
  private readonly statusListeners = new Set<(status: string) => void>()
  private readonly stepListeners = new Set<(line: string) => void>()
  private readonly agent: Agent
```

- **`Set` instead of `Array`** – A `Set` guarantees no duplicate listeners. If you accidentally register the same handler twice, it's only called once.

---

```ts
  constructor(config: AgentConfig) {
    this.config = config
    this.agent = new Agent({
      ...config,
      callbacks: {
        onStatus: (status) => {
          this.statusListeners.forEach((listener) => listener(status))
          this.config.callbacks?.onStatus?.(status)
        },
        onStep: (entry) => {
          const line = `Step ${entry.step}: ${entry.action.action} → ${entry.result.message}`
          this.stepListeners.forEach((listener) => listener(line))
          this.config.callbacks?.onStep?.(entry)
        },
      },
    })
  }
```

- **Why intercept callbacks:** `MyPageAgent` needs to broadcast events to both:
  1. Its own listeners (registered via `onStatus()` and `onStep()` methods).
  2. The original callbacks provided in `config`.
- The `...config` spread passes all original config through, then overrides `callbacks` with new functions that do both tasks.
- **`onStep` transforms the entry** – The `Agent` emits structured `AgentHistoryEntry` objects. `MyPageAgent` converts them to plain strings (`"Step 1: click → Clicked element 3"`) for listeners registered via the simpler `onStep(handler)` method.

---

```ts
  async execute(task: string): Promise<AgentRunResult> {
    return this.agent.execute(task)
  }

  onStatus(handler: (status: string) => void): void {
    this.statusListeners.add(handler)
  }

  onStep(handler: (line: string) => void): void {
    this.stepListeners.add(handler)
  }
}
```

- Simple delegation and registration methods. `execute` delegates directly to the inner `Agent`. `onStatus`/`onStep` add handlers to the sets.

---

```ts
export function mountAgentPanel(config: AgentConfig, parent?: ParentNode): MyPageAgent {
  const agent = new MyPageAgent(config)
  const panel = new Panel({
    execute: (task) => agent.execute(task),
    onStatus: (handler) => agent.onStatus(handler),
    onStep: (handler) => agent.onStep(handler),
  })

  panel.mount(parent)
  return agent
}
```

- **What:** A convenience function that creates an agent AND mounts the floating panel in one call.
- **Why return `agent`:** The caller might want to call `agent.execute()` programmatically (e.g. from their own UI), not just through the panel.
- **`{ execute: ..., onStatus: ..., onStep: ... }`** – This object literal satisfies the `PanelController` interface. TypeScript checks the shape; no explicit `implements` keyword is needed (this is called **structural typing**).

---

```ts
export type { AgentConfig, AgentRunResult, AgentHistoryEntry, LLMConfig } from './core/types'
```

- **Why re-export types:** Consumers of the library should import types from the library's public entry point, not dig into internal files. This line makes all essential types available from a single `import` path.

---

## 15. `src/main.ts` — Demo Application

This file is not part of the library — it's a standalone demo page that shows the agent in action.

```ts
import './style.css'
import { mountAgentPanel } from './index'
```

- **`'./style.css'`** – Vite (the build tool) handles CSS imports. The styles are injected into the page at build time.

---

```ts
const app = document.querySelector<HTMLDivElement>('#app')
if (!app) {
  throw new Error('App root not found')
}
```

- **`document.querySelector<HTMLDivElement>('#app')`** – TypeScript generic tells the compiler this will be a `<div>` (or `null`). The `<HTMLDivElement>` parameter is a **type assertion**.
- **`if (!app) throw`** – Fails loudly and immediately if the HTML template doesn't have `<div id="app">`. Better than a cryptic `null` error later.

---

```ts
app.innerHTML = `
  <main class="demo-container">
    <h1>My Page Agent MVP Demo</h1>
    <form class="card" id="demo-form">
      <label>Name <input name="name" placeholder="Enter your name" /></label>
      <label>Email <input name="email" type="email" placeholder="name@example.com" /></label>
      <label>Role
        <select name="role">
          <option value="">Pick one</option>
          <option value="developer">Developer</option>
          <!-- ... -->
        </select>
      </label>
      <button type="submit">Submit Form</button>
    </form>
    <!-- ... -->
  </main>
`
```

- **What:** Builds the demo HTML by setting `innerHTML`. This creates a form for the agent to practice on — text inputs, an email field, a dropdown, and a submit button.
- **Why `innerHTML` and not separate `createElement` calls:** For a demo page, template literals are much more readable. `innerHTML` is fine here because the content is a static string with no user-provided input (no XSS risk).

---

```ts
form?.addEventListener('submit', (event) => {
  event.preventDefault()
  output!.textContent = 'Form submitted (demo only).'
})
```

- **`event.preventDefault()`** – Stops the browser from actually submitting the form (which would navigate to a new page or reload). The demo just shows a confirmation message.
- **`output!`** – The `!` (non-null assertion) tells TypeScript "I know this isn't null". Used here because we already checked the HTML is correct above.

---

```ts
mountAgentPanel({
  // Point baseURL at any OpenAI-compatible endpoint:
  //   Ollama local:  'http://localhost:11434/v1'  (apiKey: 'NA')
  //   Groq:          'https://api.groq.com/openai/v1'
  //   OpenAI proxy:  'https://your-proxy.com/v1'
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'NA',
  model: 'llama3.2',
  temperature: 0,
  maxSteps: 8,
})
```

- **What:** The only line needed to add the agent to any page.
- **`baseURL`** – Points at a local Ollama server using its OpenAI-compatible `/v1` endpoint. Change this to any other provider's URL with no other code changes needed.
- **`apiKey: 'NA'`** – Local Ollama doesn't require authentication; this is a placeholder.
- **`temperature: 0`** – Deterministic output — the model always makes the same choice for the same input, which makes the agent's behavior predictable and reproducible.
- **`maxSteps: 8`** – A conservative limit for the demo page. 8 steps is enough for "fill this form and submit".

---

## 16. How Everything Connects — End-to-End Flow

Here is a complete walkthrough of what happens when a user types `"Fill the name with Alex and submit the form"` and clicks **Run Agent**:

```
1. Panel.render() button click handler fires
   └─ calls controller.execute("Fill the name with Alex and submit the form")
      └─ calls MyPageAgent.execute(task)
         └─ calls Agent.execute(task)

2. Agent loop — Step 1:
   a. PageController.observe()
      └─ scanInteractiveElements(document, window)
         ├─ querySelectorAll(INTERACTIVE_SELECTOR) → finds all buttons, inputs, etc.
         ├─ isVisible() filters to only on-screen, clickable elements
         ├─ getLabel() labels each element: "INPUT: Enter your name", "SUBMIT BUTTON: Submit Form", etc.
         └─ returns ScanResult { elements, elementMap, text }
      └─ returns PageObservation { url, title, elements, elementsText }

   b. buildPrompt(task, observation, history, pages)
      └─ formats system rules + current elements + empty history
      └─ returns [ {role:"system", content: "..."}, {role:"user", content: "..."} ]

   c. LLMClient.getNextAction(messages)  ← network call to Ollama
      └─ Ollama returns: {"thought":"I need to fill the name field","action":"input","args":{"index":1,"text":"Alex"}}
      └─ parseAgentActionResponse() extracts and validates the JSON
      └─ normalizeAction() returns: { thought: "...", action: "input", args: { index: 1, text: "Alex" } }

   d. PageController.executeAction({ action: "input", args: { index: 1, text: "Alex" } })
      └─ runAction() → doInput(1, "Alex", args, elementMap, win)
         └─ getElement(1, args, elementMap) → looks up index 1 → returns the name <input>
         └─ uses native setter trick to set value to "Alex"
         └─ dispatches input + change + blur events
         └─ returns { success: true, message: "Entered text into element 1" }

   e. Waits 600ms for React re-render
   f. Checks URL — not changed
   g. history.push({ step: 1, observation: "...", action: {...}, result: {...} })
   h. callbacks.onStep() → Panel prepends "Step 1: input → Entered text into element 1" to the log

3. Agent loop — Step 2:
   a. Observe again — the name input now shows "Alex"
   b. buildPrompt — history now contains Step 1
   c. LLM decides: {"action":"click","args":{"index":4}}  (the submit button)
   d. doClick(4, ...) → (el as HTMLElement).click() → form submits → output shows "Form submitted (demo only)."
   e. 700ms delay (submit button heuristic)
   f. URL not changed (demo prevented default)
   g. No menu items appeared
   h. history.push(step 2 entry)

4. Agent loop — Step 3:
   a. Observe — page still on same URL, form still visible
   b. LLM sees form submitted message in elements, decides: {"action":"done","args":{"result":"Form filled with Alex and submitted."}}
   c. result.done = true → Agent returns { status: "done", history: [...], message: "Form filled with Alex and submitted." }

5. Back in MyPageAgent.execute() → returns AgentRunResult to Panel
6. Panel updates status: "Status: done - Form filled with Alex and submitted."
7. Run button re-enabled.
```

---

## Summary

| Layer | Files | Responsibility |
|---|---|---|
| **Types** | `types.ts` | Contracts that all other layers depend on |
| **Core** | `Agent.ts`, `prompt.ts`, `tools.ts` | The agent loop, LLM prompt construction, action parsing |
| **LLM** | `createLLMClient.ts`, `OpenAIClient.ts` | Talking to AI models |
| **Page Control** | `PageController.ts`, `domScanner.ts`, `actions.ts` | Seeing and interacting with the DOM |
| **UI** | `Panel.ts` | Floating user interface |
| **Public API** | `index.ts` | Library entry point |
| **Demo** | `main.ts` | Standalone demo application |

The key design principles throughout the codebase:

- **Separation of concerns** — Each file has a single, clear responsibility.
- **Interface-driven design** — The Agent depends on `LLMClient` (interface), not `OpenAIClient` (concrete). This makes adding new providers trivial: just implement the interface.
- **Defensive programming** — Raw LLM output is validated and normalized before use. DOM actions fail gracefully with descriptive errors rather than crashing.
- **Security by default** — Sending API keys directly from the browser is blocked unless explicitly opted into.
- **Progressive enhancement** — The library works with any web app without requiring framework-specific code.
