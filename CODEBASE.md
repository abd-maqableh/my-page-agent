# My Page Agent — Full Codebase Explanation

A browser-based AI agent that reads a live web page, asks a language model what action to take next, executes that action on the DOM, and repeats — until the task is done, an error occurs, or the step limit is reached.

---

## Table of Contents

1. [Entry Points](#1-entry-points)
2. [Core — Agent](#2-core--agent)
3. [Core — Prompt Builder](#3-core--prompt-builder)
4. [Core — Action Normalizer](#4-core--action-normalizer)
5. [Core — Types](#5-core--types)
6. [LLM Clients](#6-llm-clients)
7. [Page Controller](#7-page-controller)
8. [DOM Scanner](#8-dom-scanner)
9. [DOM Actions](#9-dom-actions)
10. [UI Panel](#10-ui-panel)
11. [Data Flow Summary](#11-data-flow-summary)

---

## 1. Entry Points

### `src/index.ts`

The public surface of the library. Consumers import from here.

---

#### `class MyPageAgent`

Public facade that wraps the internal `Agent` and re-emits its events to registered listeners.

| Member | Description |
|---|---|
| `config` | Stored `AgentConfig` (LLM provider settings + agent options). |
| `statusListeners` | `Set` of `(status: string) => void` handlers registered via `onStatus()`. |
| `stepListeners` | `Set` of `(line: string) => void` handlers registered via `onStep()`. |
| `agent` | Internal `Agent` instance, created in the constructor. |

**`constructor(config)`**  
Creates the internal `Agent` with a custom `callbacks` object. The `onStatus` callback fans out to all registered `statusListeners` and also forwards to any user-supplied `config.callbacks.onStatus`. The `onStep` callback formats the history entry as a human-readable string (`"Step 2: click → Clicked element 4"`) before fanning out.

**`execute(task): Promise<AgentRunResult>`**  
Delegates directly to `Agent.execute(task)`.

**`onStatus(handler)`**  
Adds `handler` to `statusListeners`. Called every time the agent changes state (e.g. `"Step 1: observing page"`).

**`onStep(handler)`**  
Adds `handler` to `stepListeners`. Called after every step with a formatted one-line summary.

---

#### `mountAgentPanel(config, parent?): MyPageAgent`

Factory function. Creates a `MyPageAgent`, creates a `Panel` UI, wires them together using the agent's `execute`, `onStatus`, and `onStep` methods, and mounts the panel to `parent` (defaults to `document.body`). Returns the agent so callers can call `execute()` programmatically too.

---

## 2. Core — Agent

### `src/core/Agent.ts`

The brain of the system. Runs the observe → think → act loop.

---

#### `class Agent`

| Member | Description |
|---|---|
| `maxSteps` | Maximum loop iterations before giving up. Defaults to `10`. |
| `client` | `LLMClient` instance (OpenAI or Ollama), created by `createLLMClient`. |
| `pageController` | `PageController` instance for reading and acting on the DOM. |
| `callbacks` | Optional `onStatus` / `onStep` hooks. |
| `confirmAction` | Optional gate function called before every action. |
| `pages` | Optional map of page names → URL paths (or `PageDescriptor` objects with `sections` / `subPages`) for `navigate` actions and section jumps. |

---

**`constructor(config)`**  
Resolves `maxSteps` (default 10), creates the LLM client, and creates a `PageController` (optionally scoped to an iframe). It also gathers every declared section name from the `pages` config via `collectDeclaredSections(config.pages)` — a recursive walk that collects `PageDescriptor.sections` (including from nested `subPages`) — and passes that list to the `PageController` so the scanner can surface `SECTION:` landmarks. Callbacks and guards are stored too.

---

**`execute(task): Promise<AgentRunResult>`**  
The main step loop. Returns `{ status: 'done' | 'error' | 'max_steps', history, message }`.

Each iteration does the following:

1. **Observe** — calls `pageController.observe()` to snapshot the current DOM. Captures `prevUrl` before executing any action.
2. **Build prompt** — calls `buildPrompt(task, observation, history, pages)` to assemble the `ChatMessage[]` array.
3. **Ask LLM** — calls `client.getNextAction(messages)`. If this throws, returns `{ status: 'error' }`.
4. **`confirmAction` gate** — if a gate is configured, awaits it. If it returns `false`, returns `{ status: 'error' }`.
5. **Execute action** — calls `pageController.executeAction(action)`.
6. **Settle delay** — waits 600 ms for `click`, `input`, or `select` to allow React/SPA re-renders to finish.
7. **Post-action observe** — calls `pageController.observe()` again to read `nextUrl`.
8. **URL change detection** — compares `nextUrl` to `prevUrl`. Sets `navigated = true` if they differ (only for `click` actions). Checks `UUID_RE` to determine whether the navigation landed on a detail page (`navigatedToDetail`). Annotates the result message with `→ navigated to {url}` if navigation occurred.
9. **Record history** — pushes the `AgentHistoryEntry` and fires `onStep`.
10. **Error check** — if `result.success` is `false`, returns `{ status: 'error' }`.
11. **Menu auto-click** — if the action was a `click` and no navigation occurred, checks whether the new observation contains elements labelled `MENU ITEM:`. If so, picks the best matching item based on task intent (`view`/`open` keywords → "View" menu item; `edit`/`modify` keywords → "Edit" menu item; fallback to first item). Auto-clicks it, waits 800 ms, then checks `afterMenuUrl`. If the menu click caused a UUID navigation, returns `{ status: 'done' }` immediately. Otherwise continues the loop.
12. **Detail-page shortcut** — if `navigatedToDetail` is `true` (a direct click landed on a UUID URL), returns `{ status: 'done' }` without waiting for the LLM to issue a `done` action.
13. **Done check** — if `action.action === 'done'` or `result.done === true`, returns `{ status: 'done' }`.
14. **Max-steps check** — after all steps, returns `{ status: 'max_steps' }`.

---

## 3. Core — Prompt Builder

### `src/core/prompt.ts`

Assembles the structured `ChatMessage[]` payload sent to the LLM each step.

---

**`formatHistory(history): string`**  
Takes the last 8 `AgentHistoryEntry` items and formats each as:
```
Step N
Action: click {"index":4}
Result: success - Clicked element 4
```
Entries older than 8 steps are dropped to keep the prompt concise.

---

**`buildPrompt(task, observation, history, pages?): ChatMessage[]`**  
Returns a two-message array:

- **System message** — a fixed set of behavioural rules:
  - Action schema: 7 named actions with their required args.
  - Rules 1–10: how to pick element indexes, when to use `select` vs `input`, how to handle filter dropdowns vs search boxes, per-item action menus, when to call `done`.
  - Rule 9b (updated): if the **last history entry** shows `"navigated to"` in its result message, the view/open action is complete — call `done` immediately.
  - Rule 10 (updated): when the user wants to view/edit an item, click the `"Per-item actions menu"` button; the agent (not the LLM) will auto-click the matching menu item — so the LLM must **not** call `done` immediately after the menu click.
  - Rules 11–13 (conditional, only when `pages` is provided): navigation rules and the known path map (rendered by `formatPagePaths`, which flattens nested sub-pages and appends inline `[sections: ...]` hints).
  - Rule 12b CROSS-PAGE SECTION RULE (conditional, only when any page declares `sections`): navigate to a section's owning page first, then scroll to the matching `SECTION: <name>` landmark.
  - Rule 24 SECTION FOCUS RULE: scroll to a `SECTION: <name>` landmark on the current page.

- **User message** — the task text, current page URL/title, the numbered element list, and the formatted history.

---

## 4. Core — Action Normalizer

### `src/core/tools.ts`

Sanitises raw LLM output into a typed, predictable `AgentAction`.

---

**`isValidActionName(action): action is AgentActionName`**  
Type-guard: returns `true` if `action` is one of the 7 valid action names (`click`, `input`, `select`, `scroll`, `wait`, `navigate`, `done`).

---

**`normalizeAction(input): AgentAction`**  
Accepts an `unknown` value (the parsed JSON from the LLM) and returns a clean `AgentAction`. Handles:

- **Nested args** — standard `{"action":"click","args":{"index":3}}`.
- **Flat args** — some small models return `{"action":"click","index":3}` without wrapping in `args`. The function collects any known arg keys (`index`, `text`, `value`, `direction`, `amount`, `timeoutMs`, `result`, `url`) from the top-level object and uses them as `args`.
- **Index from thought** — last resort: if `index` is still missing for `click`/`input`/`select`, parses the `thought` string for patterns like `[5]` or `element 5`.

---

## 5. Core — Types

### `src/core/types.ts`

All shared TypeScript interfaces and type aliases.

| Type / Interface | Description |
|---|---|
| `AgentActionName` | Union of the 7 valid action strings. |
| `AgentActionArgs` | Optional arguments bag: `index`, `text`, `value`, `direction`, `amount`, `timeoutMs`, `result`, `url`. |
| `AgentAction` | `{ thought?, action, args? }` — the JSON object the LLM emits each step. |
| `PageElementSummary` | Snapshot of one interactive DOM element: `index`, `tag`, `role`, `type`, `label`. |
| `PageObservation` | Current page state: `url`, `title`, `elements[]`, `elementsText` (the text block sent to the LLM). |
| `ActionExecutionResult` | `{ success, message, done? }` — result of executing one action. |
| `AgentHistoryEntry` | One completed step: `step`, `observation`, `action`, `result`. |
| `AgentCallbacks` | `{ onStatus?, onStep? }` — lifecycle hooks. |
| `AgentRunResult` | Final outcome: `{ status: 'done' \| 'error' \| 'max_steps', history, message }`. |
| `LLMClient` | Interface: one method `getNextAction(messages): Promise<AgentAction>`. |
| `OpenAIConfig` | `baseURL`, `apiKey`, `model`, `temperature?`, `allowDirectProvider?`. |
| `OllamaConfig` | `provider: 'ollama'`, `baseURL?`, `model`, `temperature?`. |
| `LLMConfig` | `{ baseURL, apiKey, model, temperature?, allowDirectProvider? }` — universal config for any OpenAI-compatible endpoint. |
| `AgentConfigBase` | `maxSteps?`, `callbacks?`, `confirmAction?`, `targetFrame?`, `pages?` (`Record<string, string \| PageDescriptor>`). |
| `PageDescriptor` | `{ path, sections?: string[], subPages?: Record<string, string \| PageDescriptor> }` — rich page description for in-page section jumps and nested sub-pages. |
| `AgentConfig` | `LLMConfig & AgentConfigBase` — the single config object consumers pass. |
| `ChatMessage` | `{ role: 'system' \| 'user' \| 'assistant', content: string }`. |

---

## 6. LLM Clients

### `src/llm/createLLMClient.ts`

**`createLLMClient(config): LLMClient`**  
Factory. Always returns `new OpenAIClient(config)`. Any OpenAI-compatible endpoint is supported by pointing `baseURL` at it.

---

### `src/llm/OpenAIClient.ts`

Universal client for any OpenAI-compatible HTTP API — works with OpenAI (via proxy), Ollama (`/v1`), Groq, Azure OpenAI, LM Studio, and others.

**`assertSafeBaseURL(baseURL, allowDirectProvider)`**  
Security guard. Parses the hostname and refuses to continue if it matches a known public provider domain (e.g. `api.openai.com`, `api.anthropic.com`) unless `allowDirectProvider: true` is explicitly set. This prevents accidental API key exposure from the browser.

**`extractJSON(text): string`**  
Strips markdown code fences (` ```json ... ``` `) if present. Then walks the string character-by-character maintaining a brace-depth counter and string/escape state to extract the first complete, balanced `{...}` JSON object. This tolerates LLMs that append prose after the JSON.

**`parseAgentActionResponse(raw): AgentAction`**  
Calls `extractJSON` → `JSON.parse` → `normalizeAction`. Turns raw model text into a typed action.

**`class OpenAIClient`**  
`getNextAction(messages)` — POSTs to `{baseURL}/chat/completions` with the model name, temperature, and messages. Reads `choices[0].message.content` from the response and calls `parseAgentActionResponse`.

---

## 7. Page Controller

### `src/page-controller/PageController.ts`

Abstracts the target document/window so the agent works identically on the host page or inside an iframe.

---

**`class PageController`**

| Member | Description |
|---|---|
| `elementMap` | `Map<number, Element>` — index → DOM element, rebuilt every `observe()` call. |
| `targetFrame` | Optional `<iframe>` reference. When set, all DOM access goes through `contentDocument`/`contentWindow`. |
| `declaredSections` | `string[]` of section names gathered from the `pages` config (via `PageDescriptor.sections`). Passed into the scanner so it can surface matching titles as `SECTION:` landmarks. |

**`getDocWin(): { doc, win }`**  
Returns the correct `Document` and `Window` pair — either from the iframe or the host page.

**`observe(): PageObservation`**  
Calls `scanInteractiveElements(doc, win, declaredSections)`, updates `elementMap`, and returns `{ url, title, elements, elementsText }`.

**`executeAction(action): Promise<ActionExecutionResult>`**  
Calls `runAction(action, this.elementMap, doc, win)` with the correct document/window context.

---

## 8. DOM Scanner

### `src/page-controller/domScanner.ts`

Scans the page and produces a numbered list of visible, interactive elements.

---

**`isVisible(el, win): boolean`**  
Returns `true` only if the element has a non-zero bounding rect, is not `display:none`, and is not `visibility:hidden`.

---

**`getLabel(el): string`**  
Derives a human-readable label using this priority:
1. `aria-label` attribute
2. `title` attribute
3. For `<input>`: associated `<label>` text, then `placeholder`
4. For `<select>`: `"FILTER DROPDOWN: {selected option}"` or `"FILTER DROPDOWN (no selection)"`
5. For `role="combobox"`: `"FILTER DROPDOWN: {text content}"`
6. For `role="menuitem"`: `"MENU ITEM: {text}"`
7. For `role="option"`: `"DROPDOWN OPTION: {text}"`
8. `textContent` — but ellipsis-only buttons (`...`, `⋯`, `⋮`) become `"Per-item actions menu ({card title})"` so the LLM knows their purpose
9. Fallback: `"{tagName} element"`

---

**`getType(el): string | null`**  
Returns the `type` attribute for `<input>` elements (e.g. `"text"`, `"checkbox"`); `null` for everything else.

---

**`scanInteractiveElements(root, win, declaredSections?): ScanResult`**  
1. Queries all elements matching the interactive CSS selector list (`button`, `a[href]`, `input`, `textarea`, `select`, and ARIA roles `button`, `link`, `textbox`, `combobox`, `menuitem`, `option`, `[onclick]`, `[tabindex]`).
2. Deduplicates and filters to visible elements only.
3. Excludes any element inside `[data-agent-panel]` (the agent's own Panel UI, so the LLM cannot accidentally interact with it).
4. Assigns 1-based numeric indexes and builds the `elementMap`.
5. Serialises to a text block: `[1] button "Submit"`, `[2] input:text "Search"`, etc.

**Section landmark pass.** The scanner also emits non-interactive `SECTION: <name>` landmarks so the agent can scroll to in-page sections. It matches headings against `declaredSections` (the names declared in the `pages` config). Because many section titles are **spans / `Typography`, not `<h1>`–`<h6>`**, the scanner inspects a broad set of title-like elements (`h1–h6, span, strong, b, p, legend, figcaption, [class*="title"]`), compares each element's own text against the declared names (ignoring filler words), and resolves the nearest card container to anchor the landmark.

---

## 9. DOM Actions

### `src/page-controller/actions.ts`

Implements every action the LLM can request, dispatching real DOM events.

---

**`waitForElement(selector, timeoutMs, doc): Promise<Element | null>`**  
Polls the DOM every 50 ms until a matching element appears or the timeout elapses. Used to wait for MUI dropdown portals after opening a combobox.

---

**`findByText(query, elementMap): Element | undefined`**  
Fuzzy fallback: iterates `elementMap` values comparing labels (lowercased, whitespace-collapsed). Returns the first element whose label equals or contains the query.

---

**`getElement(index, args, elementMap): Element`**  
Resolves a DOM element from `elementMap`. Priority:
1. Numeric `index` directly from the map.
2. Scan string values in `args` for patterns like `[5]` or `"5"` — extracts and re-looks up.
3. `findByText` label search using any string in `args`.
4. Throws if nothing matches.

---

**`doClick(index, args, elementMap, doc, win): Promise<ActionExecutionResult>`**  
Focuses the element. For `role="combobox"` (MUI Select), dispatches the full `mousedown → mouseup → click` sequence and waits up to 1500 ms for the listbox portal to appear. For everything else, calls `.click()`.

---

**`doInput(index, text, args, elementMap, win): ActionExecutionResult`**  
For `<input>` and `<textarea>`: uses the **native prototype setter** (`Object.getOwnPropertyDescriptor`) to bypass React's controlled-component interception (directly assigning `el.value` is silently ignored by React). Then dispatches `input` and `change` events with `bubbles: true`.

---

**`doSelect(index, value, args, elementMap, doc, win): Promise<ActionExecutionResult>`**  
Two paths:
- **Native `<select>`** — finds the matching `<option>` using flexible substring matching (both directions, case-insensitive, for both `option.text` and `option.value`). Sets `selectEl.value` and fires `input`/`change` events.
- **MUI combobox** — opens it via `mousedown → mouseup → click`, waits for the listbox portal, then finds and clicks the matching `[role="option"]` using flexible substring matching.

---

**`doScroll(direction, amount, win): ActionExecutionResult`**  
Calls `window.scrollBy` with smooth behaviour. Defaults to 70% of viewport height if no `amount` is provided.

---

**`doWait(timeoutMs, win): Promise<ActionExecutionResult>`**  
Pauses execution for `timeoutMs` milliseconds (default 1000 ms).

---

**`doNavigate(url, win): Promise<ActionExecutionResult>`**  
Sets `window.location.href` and waits 1800 ms for the SPA router to settle before returning.

---

**`runAction(action, elementMap, doc, win): Promise<ActionExecutionResult>`**  
The dispatcher. Routes `action.action` to the appropriate `do*` function. Wraps all execution in try/catch so any thrown error is returned as `{ success: false, message: "..." }` rather than crashing the loop.

| Action | Handler |
|---|---|
| `click` | `doClick` |
| `input` | `doInput` |
| `select` | `doSelect` |
| `scroll` | `doScroll` |
| `wait` | `doWait` |
| `navigate` | `doNavigate` |
| `done` | Returns `{ success: true, done: true, message: args.result }` |

---

## 10. UI Panel

### `src/ui/Panel.ts`

A self-contained floating panel injected into the page. Renders with vanilla DOM APIs — no framework dependency.

---

**`class Panel`**

| Member | Description |
|---|---|
| `MAX_LOG_ENTRIES` | Static constant: keeps at most 8 log lines visible. |
| `controller` | `PanelController` interface: `execute`, `onStatus`, `onStep`. |
| `root` | The outermost `<div>` mounted to the DOM. |
| `taskInput` | `<textarea>` where the user types the task. |
| `statusEl` | `<div>` showing the current status string. |
| `logEl` | `<ul>` showing recent step lines. |

**`constructor(controller)`**  
Creates the DOM elements, calls `render()` to style and assemble them, then calls `bindControllerEvents()` to wire up live updates.

**`mount(parent?)`**  
Appends `root` to `parent` (defaults to `document.body`).

**`bindControllerEvents()`**  
Subscribes to:
- `onStatus` → updates `statusEl.textContent`.
- `onStep` → prepends a new `<li>` to `logEl`, then trims `logEl` to `MAX_LOG_ENTRIES` by removing the last child.

**`render()`**  
Builds the panel UI imperatively:
- Positions `root` as `fixed` bottom-right at z-index `2147483647` (max).
- Creates and styles the title, textarea, "Run Agent" button, status div, and log list.
- The button's `click` handler: disables itself → calls `controller.execute(task)` → shows the `AgentRunResult` status → re-enables. Shows `"Status: enter a task first"` if the textarea is empty.

---

## 11. Data Flow Summary

```
User types task → Panel.run button
  → MyPageAgent.execute(task)
    → Agent.execute(task)
      ┌─ loop (step 1…maxSteps) ──────────────────────────────────┐
      │  PageController.observe()                                  │
      │    └─ scanInteractiveElements(doc, win) → elementMap       │
      │  buildPrompt(task, obs, history, pages)                    │
      │    └─ [system rules] + [task + elements + history]         │
      │  LLMClient.getNextAction(messages)                         │
      │    └─ POST /chat/completions (or ollama.chat)              │
      │    └─ extractJSON → normalizeAction → AgentAction          │
      │  confirmAction? gate                                       │
      │  PageController.executeAction(action)                      │
      │    └─ runAction → doClick / doInput / doSelect / …        │
      │  wait 600ms (if click/input/select)                        │
      │  observe() again → detect URL change                       │
      │  ├─ UUID in new URL? → return done (detail page)           │
      │  ├─ MENU ITEMs visible after click? → auto-click match     │
      │  │    └─ UUID after menu click? → return done              │
      │  ├─ action=done or result.done? → return done              │
      │  └─ continue loop                                          │
      └───────────────────────────────────────────────────────────┘
    → AgentRunResult { status, history, message }
  → Panel shows final status
```
