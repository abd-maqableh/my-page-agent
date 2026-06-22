# My Page Agent — Full Codebase Explanation

A browser-based AI agent that reads a live web page, asks a language model what actions to take next, executes those actions on the DOM, and repeats — until the task is done, an error occurs, or the batch limit is reached.

---

## Table of Contents

1. [Entry Points](#1-entry-points)
2. [Core — Agent](#2-core--agent)
3. [Core — Prompt Builder](#3-core--prompt-builder)
4. [Core — Action Normalizer](#4-core--action-normalizer)
5. [Core — Text Normalization](#5-core--text-normalization)
6. [Core — Types](#6-core--types)
7. [LLM Clients](#7-llm-clients)
8. [Page Controller](#8-page-controller)
9. [DOM Scanner](#9-dom-scanner)
10. [DOM Actions](#10-dom-actions)
11. [UI Panel](#11-ui-panel)
12. [Data Flow Summary](#12-data-flow-summary)

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
Creates the internal `Agent` with a custom `callbacks` object. The `onStatus` callback fans out to all registered `statusListeners` and also forwards to any user-supplied `config.callbacks.onStatus`. The `onStep` callback formats the history entry as a human-readable string (`"Step 2: click → Clicked element 4"`) before fanning out. `onPageReady` is forwarded directly to support the two-phase flow.

**`execute(task): Promise<AgentRunResult>`**  
Delegates directly to `Agent.execute(task)`.

**`onStatus(handler)`**  
Adds `handler` to `statusListeners`. Called every time the agent changes state.

**`onStep(handler)`**  
Adds `handler` to `stepListeners`. Called after every batch with a formatted one-line summary per action.

---

#### `mountAgentPanel(config, parent?): MyPageAgent`

Factory function. Creates a `MyPageAgent`, creates a `Panel` UI, wires them together using the agent's `execute`, `onStatus`, and `onStep` methods, and mounts the panel to `parent` (defaults to `document.body`). Returns the agent so callers can call `execute()` programmatically too.

---

## 2. Core — Agent

### `src/core/Agent.ts`

The brain of the system. Runs the observe → think → act cycle. Supports **two-phase** (Phase 1: navigation, Phase 2: interaction) and **single-phase** (direct interaction) modes.

---

#### `class Agent`

| Member | Description |
|---|---|
| `client` | `LLMClient` instance, created by `createLLMClient` or injected via `config.llmClient`. |
| `pageController` | `PageController` instance for reading and acting on the DOM. |
| `callbacks` | Optional `onStatus` / `onStep` / `onPageReady` hooks. |
| `confirmAction` | Optional gate function called before every action. |
| `pages` | Optional map of page names → URL paths (or `PageDescriptor` objects with `sections` / `subPages`). |
| `twoPhase` | Whether to use the two-phase navigation+interaction flow. |

---

**`constructor(config)`**  
Creates the LLM client (or uses injected one), creates a `PageController` (optionally scoped to an iframe with a fallback URL), and gathers declared section names from the `pages` config via `collectDeclaredSections`.

---

**`execute(task): Promise<AgentRunResult>`**  
Dispatches to `executeTwoPhase` (when `twoPhase=true`, `pages` is set, and `onPageReady` callback exists) or `executeSinglePhase`.

---

**`executeTwoPhase(task): Promise<AgentRunResult>`**  
Two-phase execution:

**Phase 1 — Navigation:**
1. Reads current URL via `pageController.getEffectiveUrl()`.
2. Calls `findMatchingPage(currentUrl, pages)` to check if already on the correct page.
3. Checks if task explicitly asks for a different page, or if task mentions a section of the current page.
4. **Skips navigation** if already on the correct page and task mentions a section there.
5. Otherwise calls `buildNavigationPrompt(task, pages, currentUrl)` → `client.getNextActions(navMessages)` → extracts `navigate` action → `executeActionQueue([navigate])`.
6. Updates fallback URL after navigation.
7. Calls `callbacks.onPageReady()` to wait for the iframe to load.
8. Calls `pageController.waitForStability(300, 3000)` for React/SPA re-renders.

**Phase 2 — Interaction loop (max 8 batches):**
1. **Observe** — `pageController.observe()` scans the live DOM.
2. **Build prompt** — `buildInteractionPrompt(task, observation, pages, history)`.
3. **Ask LLM** — `client.getNextActions(messages)` returns `AgentAction[]`.
4. **Confirm** — runs `confirmAction` gate on each action if configured.
5. **Execute batch** — `pageController.executeActionQueue(safeActions)` — strips `navigate` actions, stops at first `done`.
6. **Record history** — pushes entries and fires `onStep`.
7. **Error check** — if batch had an error, returns `{ status: 'error' }`.
8. **Done check** — if batch included `done`, returns `{ status: 'done' }`.
9. **Auto-done** — if URL changed or second+ iteration with interaction, returns `{ status: 'done' }` with the LLM's own message.
10. **Wait for stability** — `waitForStability(300, 2000)` before next batch.

---

**`executeSinglePhase(task): Promise<AgentRunResult>`**  
Single-phase flow (no navigation phase). Observes once, asks LLM for actions, executes the batch, and returns the result. Supports the same auto-done and error handling.

---

**`pushHistory(history, step, observationText, action, result)`**  
Helper that appends an `AgentHistoryEntry` to the history array and fires `callbacks.onStep`.

---

## 3. Core — Prompt Builder

### `src/core/prompt.ts`

Assembles the structured `ChatMessage[]` payload sent to the LLM. Now split into two functions for the two-phase flow.

---

**`buildNavigationPrompt(task, pages, currentUrl?): ChatMessage[]`**  
Phase 1 prompt. Minimal — no DOM elements. The LLM only decides which page to navigate to:
- Includes current URL context (so the LLM can decide to stay).
- Lists all known pages with their paths and declared sections.
- Returns `[system, user]` messages. The system message instructs: return exactly one `navigate` action followed by `done`.

---

**`buildInteractionPrompt(task, observation, pages?, completedSteps?): ChatMessage[]`**  
Phase 2 (and single-phase) prompt. Full DOM scan with:
- Current page URL, title, and element JSON.
- **Filter map** — `buildFilterMap(elements)` creates a "value → dropdown index" lookup table.
- Known page paths (if `pages` provided).
- **Completed steps** — what the agent already did, so the LLM doesn't repeat.
- Full system rules: FILTER-FIRST RULE, SECTION SCROLLING rules, available actions with required args, HOW TO PICK THE RIGHT ELEMENT heuristics, BATCH DONE RULE, iterative execution notes.

---

**`buildFilterMap(elements): string`**  
Builds a plain-text lookup table from combobox elements: `"Value" → index N (label)`. Lets the LLM pick the right dropdown without parsing JSON descriptions.

---

**`formatPagePaths(pages, indent?): string`**  
Recursively flattens the `pages` map into aligned `label → url` lines. When a page declares `sections`, appends `sections: "A", "B", "C"`. Sub-pages are rendered indented with a `↳` marker.

---

**`buildPrompt`** — deprecated alias for `buildInteractionPrompt`, kept for backward compatibility.

---

## 4. Core — Action Normalizer

### `src/core/tools.ts`

Sanitises raw LLM output into a typed, predictable `AgentAction[]`.

---

**`isValidActionName(action): action is AgentActionName`**  
Type-guard: returns `true` if `action` is one of the 10 valid action names (`click`, `input`, `select`, `scroll`, `wait`, `navigate`, `clear`, `press_key`, `hover`, `done`).

---

**`normalizeAction(input): AgentAction`**  
Accepts an `unknown` value (the parsed JSON from the LLM) and returns a clean `AgentAction`. Handles:
- **Nested args** — standard `{"action":"click","args":{"index":3}}`.
- **Flat args** — some small models return `{"action":"click","index":3}` without wrapping in `args`.
- **Index from thought** — last resort: parses the `thought` string for patterns like `[5]` or `element 5`.

---

**`normalizeActions(input): AgentAction[]`**  
Normalizes a model response into a LIST of actions. Supports three shapes:
1. A single action object: `{"action":"select","args":{...}}` → `[action]`
2. An object with an `actions` array: `{"thought":"...","actions":[{...},{...}]}` → `[action, action]`
3. A bare array: `[{...},{...}]` → `[action, action]`

A top-level `thought` is propagated to any batched action that lacks its own.

---

## 5. Core — Text Normalization

### `src/core/text.ts`

Unicode-aware (Arabic + Latin) text normalization helpers shared across the DOM scanner, action executors, and intent router.

---

**`normalizeArabic(s): string`**  
Strips Arabic diacritics/harakat (`\u064B`–`\u065F`), tatweel (`\u0640`), and unifies common letter variants (alef, teh marbuta, alef maqsura).

---

**`normalizeText(s): string`**  
Lowercases, normalizes Arabic, and collapses whitespace. Primary normalization entry point used by `looseMatch` and `meaningfulWords`.

---

**`meaningfulWords(s): string[]`**  
Splits text into normalized, meaningful words: Unicode letters/digits only, filler/navigation verbs removed (both English and Arabic), canonicalized for plural/article tolerance (strips Arabic `ال` prefix, English `-s`/`-es` suffix). Used by the DOM scanner's section matching.

---

**`containsAllWords(text, label): boolean`**  
Returns `true` when every meaningful word of `label` appears in `text`'s word set. Used for section name matching against headings.

---

**`looseMatch(a, b): boolean`**  
Bidirectional containment match on normalized strings. Used by action executors for fuzzy option/value comparison.

---

## 6. Core — Types

### `src/core/types.ts`

All shared TypeScript interfaces and type aliases.

| Type / Interface | Description |
|---|---|
| `AgentActionName` | Union of 10 valid action strings: `click`, `input`, `select`, `scroll`, `wait`, `navigate`, `clear`, `press_key`, `hover`, `done`. |
| `AgentActionArgs` | Optional arguments bag: `index`, `text`, `value`, `direction`, `amount`, `timeoutMs`, `result`, `url`, `key`. |
| `AgentAction` | `{ thought?, action, args? }` — the JSON object the LLM emits per action. |
| `PageElementSummary` | Snapshot of one DOM element: `index`, `tag`, `role`, `type`, `label`, `description`, `kind` (`'interactive'` or `'section'`). |
| `PageObservation` | Current page state: `url`, `title`, `elements[]`, `elementsText` (JSON-serialized element array). |
| `ActionExecutionResult` | `{ success, message, done? }` — result of executing one action. |
| `ActionQueueItemResult` | `{ action: AgentAction, result: ActionExecutionResult }` — one item in a batch result. |
| `ActionQueueResult` | `{ items: ActionQueueItemResult[], done: boolean, error?: string }` — result of executing a batch. |
| `AgentHistoryEntry` | One completed step: `step`, `observation`, `action`, `result`. |
| `AgentCallbacks` | `{ onStatus?, onStep?, onPageReady? }` — lifecycle hooks. `onPageReady` is for two-phase flow. |
| `AgentRunResult` | Final outcome: `{ status: 'done' \| 'error' \| 'max_steps', history, message }`. |
| `LLMClient` | Interface: `getNextActions(messages): Promise<AgentAction[]>` — returns a batch of actions. |
| `LLMConfig` | `baseURL`, `apiKey`, `model`, `temperature?`, `maxTokens?`, `jsonMode?`, `requestTimeoutMs?`, `allowDirectProvider?` — universal config for any OpenAI-compatible endpoint. |
| `AgentConfigBase` | `llmClient?`, `maxSteps?`, `callbacks?`, `twoPhase?`, `currentUrl?`, `confirmAction?`, `targetFrame?`, `pages?`. |
| `PageDescriptor` | `{ path, sections?: string[], subPages?: Record<string, string \| PageDescriptor> }` — rich page description. |
| `AgentConfig` | `LLMConfig & AgentConfigBase` — the single config object consumers pass. |
| `ChatMessage` | `{ role: 'system' \| 'user' \| 'assistant', content: string }`. |

---

## 7. LLM Clients

### `src/llm/createLLMClient.ts`

**`createLLMClient(config): LLMClient`**  
Factory. Always returns `new OpenAIClient(config)`. Any OpenAI-compatible endpoint is supported by pointing `baseURL` at it.

---

### `src/llm/OpenAIClient.ts`

Universal client for any OpenAI-compatible HTTP API.

**`assertSafeBaseURL(baseURL, allowDirectProvider)`**  
Security guard. Parses the hostname and refuses if it matches a known public provider domain (e.g. `api.openai.com`) unless `allowDirectProvider: true` is explicitly set.

**`extractJSON(text): string`**  
Strips markdown code fences. Then walks the string character-by-character maintaining a brace/bracket-depth counter and string/escape state to extract the first complete, balanced `{...}` or `[...]` JSON value.

**`parseAgentActions(raw): AgentAction[]`**  
Calls `extractJSON` → `JSON.parse` → `normalizeActions`. Returns one or more actions (supports batched arrays).

**`parseAgentActionResponse(raw): AgentAction`**  
Backward-compat: returns only the first action from `parseAgentActions`.

**`class OpenAIClient`**  
`getNextActions(messages)` — POSTs to `{baseURL}/chat/completions` with:
- `model`, `temperature`, `messages`
- `max_tokens` (if configured — caps generation length)
- `response_format: { type: 'json_object' }` (if `jsonMode: true` — ensures valid JSON output on compatible servers)
- `AbortController` timeout (if `requestTimeoutMs` configured)
- Logs request/response timing to console with color-coded groups.

---

## 8. Page Controller

### `src/page-controller/PageController.ts`

Abstracts the target document/window so the agent works identically on the host page or inside an iframe.

---

**`class PageController`**

| Member | Description |
|---|---|
| `elementMap` | `Map<number, Element>` — index → DOM element, rebuilt every `observe()` call. |
| `targetFrame` | Optional `<iframe>` reference. |
| `declaredSections` | `string[]` of section names from the `pages` config. |
| `fallbackUrl` | Stored URL for when the iframe is cross-origin and `contentWindow.location` is inaccessible. |

**`getDocWin(): { doc, win }`**  
Returns the correct `Document` and `Window` pair — either from the iframe or the host page.

**`readUrl(): string`**  
Safely reads the current URL, returning `""` on cross-origin errors.

**`observe(): PageObservation`**  
Calls `scanInteractiveElements(doc, win, declaredSections)`, updates `elementMap`, keeps `fallbackUrl` in sync, and returns `{ url, title, elements, elementsText }`.

**`getUrl(): string`**  
Cheap URL read without re-scanning the DOM.

**`getEffectiveUrl(): string`**  
Always returns a URL: real iframe URL when readable, otherwise the fallback.

**`setFallbackUrl(url): void`**  
Stores a fallback URL for cross-origin iframe scenarios.

**`waitForStability(idleMs, maxMs): Promise<void>`**  
Uses `MutationObserver` to wait until the DOM is quiet (no mutations for `idleMs`), capped at `maxMs`. Much faster than fixed sleeps on quick pages, more reliable on slow ones.

**`executeAction(action): Promise<ActionExecutionResult>`**  
Calls `runAction(action, elementMap, doc, win)`.

**`executeActionQueue(actions): Promise<ActionQueueResult>`**  
Calls `runActionQueue(actions, elementMap, doc, win)`, then waits for stability after each `click`/`input`/`select` action.

---

## 9. DOM Scanner

### `src/page-controller/domScanner.ts`

Scans the page and produces a numbered list of visible, interactive elements with rich descriptions.

---

**`isVisible(el, win): boolean`**  
Returns `true` only if: element has `focus` function, not in `aria-hidden`/`inert` ancestor, has non-zero bounding rect, not `display:none`/`visibility:hidden`, and `pointer-events` is not `none`.

---

**`describeElement(el): { label, description }`**  
Produces a rich label + description for each element. Resolution priority:
1. **Agent meta attributes** — `data-agent-name`, `data-agent-value`, `data-agent-options`, `data-agent-values`, `data-agent-multiselect`
2. **aria-label / aria-labelledby**
3. **fieldNameFor** — resolves the field name from `<label for="id">`, wrapping `<label>`, or nearby form-control labels
4. **Combobox** — includes selection mode (single/multi), current selection, available options, expanded/collapsed state
5. **Native select** — includes selection mode, current selection, available options
6. **Input** — type-specific: date inputs get format detection, search boxes flagged, checkboxes/radios show checked state
7. **Button/link** — described as "Button action" or "Link action"
8. **Utility buttons** — Refresh/Reload buttons flagged as "Utility action" to prevent misidentification
9. **Ellipsis-only buttons** — resolved to "Per-item actions menu (Card Title)"
10. **State details** — disabled, readonly, required, invalid (with error message), expanded/collapsed, pressed, current, checked/unchecked

---

**`findOpenModal(doc): Element | null`**  
Framework-agnostic modal detection:
1. Native `<dialog open>` and ARIA roles (`dialog`, `alertdialog`)
2. `aria-modal="true"`
3. CSS class heuristic — visible elements with modal-ish class keywords, excluding non-blocking popovers (menus, tooltips, toasts)

---

**`scanInteractiveElements(root, win, declaredSections?): ScanResult`**  
1. Queries all interactive elements via `INTERACTIVE_SELECTOR`.
2. Deduplicates, filters to visible, excludes `[data-agent-panel]`.
3. When a modal is open, only includes elements inside it.
4. Assigns 1-based indexes and builds `elementMap`.
5. **Section pass** (when no modal): matches headings against `declaredSections` using `meaningfulWords` from `text.ts`, surfaces matching card containers as `SECTION:` landmarks with `kind: 'section'`.
6. Serializes to JSON.

---

## 10. DOM Actions

### `src/page-controller/actions.ts`

Implements every action the LLM can request, dispatching real DOM events. Uses `normalizeText` and `looseMatch` from `text.ts` for fuzzy matching.

---

**`waitForElement(selector, timeoutMs, doc): Promise<Element | null>`**  
Polls every 50ms until a matching element appears or timeout elapses.

**`findByText(query, elementMap): Element | undefined`**  
Fuzzy fallback: iterates `elementMap` comparing normalized labels.

**`getElement(index, args, elementMap): Element`**  
Resolves a DOM element. Priority: numeric index → string extraction → `findByText`.

**`findMatchingOption(value, options): string | undefined`**  
Bidirectional fuzzy match using `normalizeText`.

**`dismissOpenDropdown(doc, win, anchor): Promise<void>`**  
Fires Escape + ClickAwayListener dismissal and polls until `[role="listbox"]` is removed.

**`selectOnDropdown(el, index, value, doc, win)`**  
Handles both native `<select>` and ARIA combobox dropdowns. Returns `{ success, message }` or `{ success: false, availableOptions, message }` with exact available options on mismatch.

---

**Action dispatchers:**

| Action | Handler | Description |
|---|---|---|
| `click` | `doClick` | Focuses → dispatches mousedown/mouseup/click for comboboxes. Forwards to inner `<input>` for checkbox/radio wrappers. 700ms delay for submit buttons. |
| `input` | `doInput` | Uses native prototype setter to bypass React controlled components. Dispatches `InputEvent` with `inputType: 'insertFromPaste'`. Fires `blur` for masked date pickers. |
| `select` | `doSelect` | Robust target resolution — redirects to the dropdown whose options contain the requested value if model targeted wrong element. Delegates to `selectOnDropdown`. |
| `scroll` | `doScroll` | Scrolls by direction/amount or `scrollIntoView` for section targets. Adds blue outline highlight for 1.5s. |
| `wait` | `doWait` | Pauses for `timeoutMs` (default 1000ms). |
| `navigate` | `doNavigate` | Sets `location.href`, polls `document.readyState` until complete, then 350ms grace period. |
| `clear` | `doClear` | Clears input/textarea/contentEditable using native setter. |
| `press_key` | `doPressKey` | Dispatches keydown/keypress/keyup sequence with key code mapping. |
| `hover` | `doHover` | Dispatches mouseover/mouseenter/mousemove events. |
| `done` | — | Returns `{ success: true, done: true, message }`. |

---

**`runAction(action, elementMap, doc, win): Promise<ActionExecutionResult>`**  
The single-action dispatcher. Routes `action.action` to the appropriate `do*` function. All execution wrapped in try/catch.

**`runActionQueue(actions, elementMap, doc, win): Promise<ActionQueueResult>`**  
Executes actions in order. Stops early on failure or explicit `done`. Returns `{ items, done, error? }`.

---

## 11. UI Panel

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
Creates DOM elements, calls `render()` to style and assemble, then calls `bindControllerEvents()`.

**`mount(parent?)`**  
Appends `root` to `parent` (defaults to `document.body`).

**`bindControllerEvents()`**  
Subscribes to `onStatus` (updates statusEl) and `onStep` (prepends log entries, caps at 8).

**`render()`**  
Builds the panel UI: fixed bottom-right at z-index `2147483647`, dark theme, textarea, "Run Agent" button with disable-during-run logic, status display, scrollable log.

---

## 12. Data Flow Summary

```
User types task → Panel.run button
  → MyPageAgent.execute(task)
    → Agent.execute(task)
      │
      ├─ twoPhase? ──────────────────────────────────────────
      │  Phase 1: buildNavigationPrompt → LLM → navigate
      │  Wait: onPageReady + waitForStability
      │
      └─ Phase 2 / Single-phase ─────────────────────────────
         ┌─ loop (batch 1…maxSteps) ────────────────────────┐
         │  PageController.observe()                          │
         │    └─ scanInteractiveElements(doc, win, sections)  │
         │       └─ describeElement (text.ts for matching)   │
         │  buildInteractionPrompt(task, obs, pages, history) │
         │    └─ buildFilterMap → value→index lookup         │
         │  LLMClient.getNextActions(messages)                │
         │    └─ POST /chat/completions                       │
         │    └─ extractJSON → normalizeActions → AgentAction[]│
         │  confirmAction? gate (each action)                 │
         │  PageController.executeActionQueue(batch)          │
         │    └─ runActionQueue → doClick/doInput/doSelect…  │
         │    └─ waitForStability after mutations             │
         │  ├─ done in batch? → return done                   │
         │  ├─ URL changed or second+ iter? → return done     │
         │  └─ continue → waitForStability → next batch       │
         └───────────────────────────────────────────────────┘
    → AgentRunResult { status, history, message }
  → Panel shows final status
```
