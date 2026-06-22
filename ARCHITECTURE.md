# My Page Agent — Architecture & Flow

---

## 1. Component Overview

```mermaid
flowchart TD
    User(["User (browser)"])
    Panel["Panel UI<br/>(Panel.ts)"]
    MyPageAgent["MyPageAgent<br/>(index.ts)"]
    Agent["Agent<br/>core/Agent.ts"]
    LLMFactory["createLLMClient<br/>llm/createLLMClient.ts"]
    OpenAI["OpenAIClient<br/>llm/OpenAIClient.ts<br/>(universal — works with<br/>Ollama, Groq, Azure, etc.)"]
    Normalizer["normalizeActions<br/>core/tools.ts"]
    PageCtrl["PageController<br/>page-controller/PageController.ts"]
    Scanner["scanInteractiveElements<br/>page-controller/domScanner.ts"]
    Actions["runActionQueue / runAction<br/>page-controller/actions.ts"]
    PromptBuilder["buildNavigationPrompt<br/>buildInteractionPrompt<br/>core/prompt.ts"]
    TextUtils["text.ts<br/>normalizeText, meaningfulWords<br/>looseMatch, containsAllWords"]
    DOM[("Live Browser DOM")]

    %% Entry
    User -->|"types task + clicks Run"| Panel
    Panel -->|"execute(task)"| MyPageAgent
    MyPageAgent -->|"delegates"| Agent

    %% ── TWO-PHASE or SINGLE-PHASE LOOP ──────────────────
    subgraph LOOP ["Agent.execute() — two-phase or single-phase"]
        direction TB

        PHASE1["Phase 1: Navigation<br/>buildNavigationPrompt → LLM → navigate"]
        WAIT["waitForStability + onPageReady"]

        subgraph PHASE2 ["Phase 2: Interaction loop (max N batches)"]
            OBS["observe() → scan DOM"]
            PROMPT2["buildInteractionPrompt(task, obs, pages, history)"]
            LLM_REQ2["client.getNextActions(messages)"]
            CONFIRM2{"confirmAction<br/>gate?"}
            EXECQ["executeActionQueue(batch)"]
            WAITSTABLE["waitForStability after<br/>click/input/select"]

            CHK{"done in batch<br/>or auto-done?"}
            DONE2(["return done"])
            NEXT(["next batch"])
        end

        SINGLE["Single-phase: observe → buildInteractionPrompt → getNextActions → executeActionQueue"]

        PHASE1 --> WAIT --> OBS
        OBS --> PROMPT2 --> LLM_REQ2
        LLM_REQ2 -->|"AgentAction[]"| CONFIRM2
        CONFIRM2 -->|"allowed"| EXECQ
        CONFIRM2 -->|"rejected"| ERR(["return error"])
        LLM_REQ2 -->|"LLM error"| ERR
        EXECQ --> WAITSTABLE --> CHK
        CHK -->|"yes"| DONE2
        CHK -->|"no"| NEXT
        NEXT -->|"batch < maxSteps"| OBS
        NEXT -->|"batch = maxSteps"| MAX(["return max_steps"])

        SINGLE --> OBS
    end

    %% ── DOM scanning ──────────────────────────────────
    Agent --> OBS
    PageCtrl -->|"scanInteractiveElements(doc, win, declaredSections)"| Scanner
    Scanner -->|"reads"| DOM
    Scanner -->|"ScanResult {elements, elementMap, text}"| PageCtrl
    PageCtrl -->|"PageObservation"| Agent

    %% ── Text normalization ────────────────────────────
    Scanner -.->|"normalizeText, meaningfulWords"| TextUtils
    Actions -.->|"normalizeText, looseMatch"| TextUtils

    %% ── Prompt building ───────────────────────────────
    PROMPT2 --> PromptBuilder
    PromptBuilder -->|"ChatMessage[]"| LLM_REQ2

    %% ── LLM clients ───────────────────────────────────
    LLM_REQ2 --> LLMFactory
    LLMFactory --> OpenAI
    OpenAI -->|"raw JSON"| Normalizer
    Normalizer -->|"AgentAction[]"| CONFIRM2

    %% ── DOM execution ─────────────────────────────────
    EXECQ --> PageCtrl
    PageCtrl -->|"runActionQueue()"| Actions
    Actions -->|"click / input / select / scroll / wait / navigate / done / clear / press_key / hover"| DOM
    Actions -->|"ActionQueueResult"| PageCtrl

    %% ── Callbacks ─────────────────────────────────────
    Agent -->|"onStatus callback"| MyPageAgent
    Agent -->|"onStep callback"| MyPageAgent
    Agent -->|"onPageReady callback"| MyPageAgent
    MyPageAgent -->|"status string"| Panel
    MyPageAgent -->|"formatted step line"| Panel

    %% ── Final result ──────────────────────────────────
    DONE2 --> MyPageAgent
    MAX --> MyPageAgent
    ERR --> MyPageAgent
    MyPageAgent -->|"AgentRunResult"| Panel
    Panel -->|"shows status & log"| User
```

---

## 2. Class Diagram

```mermaid
classDiagram
    class MyPageAgent {
        -config: AgentConfig
        -statusListeners: Set
        -stepListeners: Set
        -agent: Agent
        +execute(task) AgentRunResult
        +onStatus(handler) void
        +onStep(handler) void
    }

    class Agent {
        -client: LLMClient
        -pageController: PageController
        -callbacks: AgentCallbacks
        -confirmAction: Function
        -pages: Record
        -twoPhase: boolean
        +execute(task) AgentRunResult
        -executeTwoPhase(task) AgentRunResult
        -executeSinglePhase(task) AgentRunResult
    }

    class PageController {
        -elementMap: Map~number, Element~
        -targetFrame: HTMLIFrameElement
        -declaredSections: string[]
        -fallbackUrl: string
        -getDocWin() DocWin
        +observe() PageObservation
        +executeAction(action) ActionExecutionResult
        +executeActionQueue(actions) ActionQueueResult
        +getEffectiveUrl() string
        +setFallbackUrl(url) void
        +waitForStability(idleMs, maxMs) Promise~void~
    }

    class OpenAIClient {
        -config: LLMConfig
        +getNextActions(messages) AgentAction[]
    }

    class Panel {
        -controller: PanelController
        -root: HTMLDivElement
        -taskInput: HTMLTextAreaElement
        -statusEl: HTMLDivElement
        -logEl: HTMLUListElement
        +mount(parent) void
        -render() void
        -bindControllerEvents() void
    }

    class LLMClient {
        <<interface>>
        +getNextActions(messages) AgentAction[]
    }

    MyPageAgent --> Agent : creates & wraps
    MyPageAgent --> Panel : wired via mountAgentPanel()
    Agent --> PageController : observe + execute
    Agent --> LLMClient : getNextActions
    LLMClient <|.. OpenAIClient : implements
    Panel --> MyPageAgent : calls execute / listens to events
```

---

## 3. Sequence Diagram — Two-Phase Execution

```mermaid
sequenceDiagram
    actor User
    participant Panel
    participant MyPageAgent
    participant Agent
    participant PageCtrl as PageController
    participant DOM as Browser DOM
    participant Scanner as domScanner
    participant Prompt as prompt.ts
    participant LLM as LLMClient
    participant Actions as actions.ts

    User->>Panel: clicks "Run Agent" (task text)
    Panel->>MyPageAgent: execute(task)
    MyPageAgent->>Agent: execute(task)

    alt twoPhase enabled
        Note over Agent: Phase 1 — Navigation
        Agent->>PageCtrl: getEffectiveUrl()
        PageCtrl-->>Agent: currentUrl
        Agent->>Agent: findMatchingPage(currentUrl, pages)

        alt already on correct page
            Agent-->>Agent: skip navigation
        else need to navigate
            Agent->>Prompt: buildNavigationPrompt(task, pages, currentUrl)
            Prompt-->>Agent: ChatMessage[]
            Agent->>LLM: getNextActions(messages)
            LLM-->>Agent: AgentAction[] [navigate, done]
            Agent->>PageCtrl: executeActionQueue([navigate])
            PageCtrl->>Actions: runActionQueue
            Actions->>DOM: doNavigate → location.href = url
            Actions-->>PageCtrl: ActionQueueResult
            PageCtrl-->>Agent: ActionQueueResult
        end

        Note over Agent: Wait for iframe to load
        Agent->>MyPageAgent: onPageReady()
        MyPageAgent-->>Agent: resolved
        Agent->>PageCtrl: waitForStability(300, 3000)
        PageCtrl-->>Agent: DOM settled
    end

    Note over Agent: Phase 2 — Interaction loop

    loop Batch 1…maxSteps
        Agent->>PageCtrl: observe()
        PageCtrl->>Scanner: scanInteractiveElements(doc, win, declaredSections)
        Scanner->>DOM: querySelectorAll(INTERACTIVE_SELECTOR)
        DOM-->>Scanner: Element[]
        Scanner-->>PageCtrl: ScanResult {elements, elementMap, text}
        PageCtrl-->>Agent: PageObservation {url, title, elements, elementsText}

        Agent->>Prompt: buildInteractionPrompt(task, obs, pages, history)
        Prompt-->>Agent: ChatMessage[] [system + user]

        Agent->>LLM: getNextActions(messages)
        LLM-->>Agent: AgentAction[] [{select}, {select}, {done}]

        alt confirmAction gate configured
            loop each action
                Agent->>Agent: confirmAction(action)
            end
        end

        Agent->>PageCtrl: executeActionQueue(batch)
        PageCtrl->>Actions: runActionQueue(actions, elementMap, doc, win)
        loop each action in batch
            Actions->>DOM: doClick / doInput / doSelect / …
            DOM-->>Actions: DOM updated
            Actions-->>PageCtrl: ActionQueueItemResult
        end
        PageCtrl->>PageCtrl: waitForStability after click/input/select
        PageCtrl-->>Agent: ActionQueueResult

        alt done in batch
            Agent-->>MyPageAgent: return done
        else auto-done: URL changed or second+ iter with interaction
            Agent-->>MyPageAgent: return done
        else continue
            Agent->>PageCtrl: waitForStability(300, 2000)
            Note over Agent: next batch
        end

        Agent->>MyPageAgent: onStatus(status)
        Agent->>MyPageAgent: onStep(entry)
        MyPageAgent->>Panel: status string
        MyPageAgent->>Panel: formatted step line
    end

    Agent-->>MyPageAgent: AgentRunResult {status, history, message}
    MyPageAgent-->>Panel: AgentRunResult
    Panel-->>User: shows final status & log
```

---

## 4. Agent State Machine

```mermaid
stateDiagram-v2
    [*] --> Idle : agent created

    Idle --> Phase1 : execute(task) — twoPhase=true
    Idle --> Observing : execute(task) — twoPhase=false

    state "Two-Phase Flow" as TwoPhase {
        Phase1 --> NavCheck : getEffectiveUrl
        NavCheck --> NavLLM : page not matched / task asks for other page
        NavCheck --> WaitPage : already on correct page
        NavLLM --> Navigate : LLM returns navigate
        Navigate --> WaitPage : navigation done
        WaitPage --> Observing : onPageReady + stability
    }

    state "Batch Loop" as Loop {
        Observing --> Building : PageObservation captured
        Building --> Thinking : ChatMessage[] ready
        Thinking --> Confirming : AgentAction[] received
        Confirming --> Executing : all confirmed
        Confirming --> [*] : rejected → error
        Thinking --> [*] : LLM error → error
        Executing --> Settling : batch executed
        Settling --> PostObserve : stability waited

        PostObserve --> DoneCheck
        DoneCheck --> NormalDone : done in batch
        DoneCheck --> AutoDone : URL changed or second+ iter
        DoneCheck --> NextStep : continue
        DoneCheck --> [*] : action failed → error

        NextStep --> Observing : batch < maxSteps
    }

    NextStep --> [*] : batch = maxSteps → max_steps
    NormalDone --> [*] : status = done
    AutoDone --> [*] : status = done
```

---

## 5. LLM Response Processing Pipeline

```mermaid
flowchart LR
    RAW["Raw LLM text<br/>(may have markdown fences,<br/>extra prose)"]
    FENCE["Strip markdown<br/>code fences"]
    EXTRACT["extractJSON()<br/>balanced-bracket<br/>cursor walk<br/>(supports { } and [ ])"]
    PARSE["JSON.parse()"]
    NORMALIZE["normalizeActions()<br/>• single action → [action]<br/>• {actions:[...]} → AgentAction[]<br/>• [...] → AgentAction[]<br/>• validates each action<br/>• hoists flat args<br/>• extracts index from thought"]
    ACTIONS["AgentAction[]<br/>[{thought, action, args}, …]"]

    ERR1(["throw: no JSON found"])
    ERR2(["throw: invalid JSON"])
    ERR3(["throw: no valid actions"])

    RAW --> FENCE --> EXTRACT
    EXTRACT -->|"no { or [ found"| ERR1
    EXTRACT -->|"balanced JSON"| PARSE
    PARSE -->|"SyntaxError"| ERR2
    PARSE -->|"object or array"| NORMALIZE
    NORMALIZE -->|"0 actions"| ERR3
    NORMALIZE -->|"valid"| ACTIONS
```

---

## 6. DOM Scanning & Label Resolution

```mermaid
flowchart TD
    ROOT["document / iframe.contentDocument"]
    QSA["querySelectorAll<br/>(button, a, input, textarea,<br/>select, role=button/link/<br/>textbox/combobox/menuitem/option,<br/> onclick , tabindex )"]
    DEDUP["deduplicate<br/>& filter visible"]
    PANEL["exclude<br/> data-agent-panel <br/>elements"]
    MODAL["modal filter:<br/>only elements inside<br/>open dialog when modal present"]
    INDEX["assign 1-based indexes<br/>build elementMap"]
    DESCRIBE["describeElement(el)<br/>rich label + description"]

    subgraph DESCRIBE_CHAIN ["descriptor resolution"]
        L1["agent meta attrs<br/>(data-agent-name/value/options)"]
        L2["aria-label / aria-labelledby"]
        L3["fieldNameFor: label[for], wrapping label"]
        L4["combobox: options + selection"]
        L5["select: options + selection"]
        L6["input: type-specific prefix"]
        L7["textContent fallback"]
        L8["tagName element"]
        L1 --> L2 --> L3 --> L4 --> L5 --> L6 --> L7 --> L8
    end

    SECTION["Section pass:<br/>match declaredSections<br/>via meaningfulWords"]
    TEXT["serialise to JSON<br/>[{index, tag, role, type, label, description, kind}, …]"]
    RESULT["ScanResult<br/>{elements, elementMap, text}"]

    ROOT --> QSA --> DEDUP --> PANEL --> MODAL --> INDEX --> DESCRIBE
    DESCRIBE --> DESCRIBE_CHAIN
    INDEX --> SECTION
    DESCRIBE_CHAIN --> TEXT
    SECTION --> TEXT
    TEXT --> RESULT
```

---

## 7. Text Normalization Layer (text.ts)

```mermaid
flowchart LR
    INPUT["Raw string<br/>(Arabic, English, mixed)"]
    NORM_AR["normalizeArabic<br/>strip diacritics/tatweel<br/>unify alef variants"]
    NORM["normalizeText<br/>lowercase + collapse whitespace"]
    WORDS["meaningfulWords<br/>split, filter fillers,<br/>canonicalize (strip ال, -s/-es)"]
    CONTAINS["containsAllWords<br/>set intersection check"]
    LOOSE["looseMatch<br/>bidirectional containment"]

    INPUT --> NORM_AR --> NORM
    NORM --> WORDS
    WORDS --> CONTAINS
    NORM --> LOOSE

    style NORM_AR fill:#e2e8f0,stroke:#64748b
    style NORM fill:#e2e8f0,stroke:#64748b
    style WORDS fill:#dbeafe,stroke:#3b82f6
    style CONTAINS fill:#dcfce7,stroke:#22c55e
    style LOOSE fill:#dcfce7,stroke:#22c55e
```

`text.ts` provides Unicode-aware (Arabic + Latin) text normalization shared by the DOM scanner (section matching), actions (option/value matching), and the intent router. It strips Arabic diacritics, unifies letter variants, filters navigation filler words, and canonicalizes plurals/articles for robust fuzzy comparison.

---

## 8. Prompt Architecture (Split)

```mermaid
flowchart TD
    TASK["User Task"]
    PAGES["Pages Config<br/>(paths + sections + subPages)"]
    OBS["PageObservation<br/>(url, title, elements, elementsText)"]
    HISTORY["Completed Steps<br/>(AgentHistoryEntry[])"]

    NAV["buildNavigationPrompt<br/>PHASE 1 — Navigation only<br/>• No DOM elements<br/>• Only pages config<br/>• Returns: navigate + done"]
    INTERACT["buildInteractionPrompt<br/>PHASE 2 — Interaction<br/>• Full DOM scan<br/>• Filter map<br/>• Completed steps<br/>• Returns: action batch + done"]

    FILTER["buildFilterMap<br/>value → dropdown index<br/>lookup table"]

    TASK --> NAV
    TASK --> INTERACT
    PAGES --> NAV
    PAGES --> INTERACT
    OBS --> INTERACT
    OBS --> FILTER
    HISTORY --> INTERACT
    FILTER --> INTERACT

    NAV -->|"ChatMessage[]"| LLM1["LLM (Phase 1)"]
    INTERACT -->|"ChatMessage[]"| LLM2["LLM (Phase 2)"]
```

The prompt system is now **split into two functions**:
- **`buildNavigationPrompt`** — Phase 1 only. Minimal prompt with no DOM elements; the LLM only decides which page to `navigate` to.
- **`buildInteractionPrompt`** — Phase 2 (and single-phase). Full DOM scan with filter map, completed steps, and all interaction rules.
- **`buildFilterMap`** — Helper that builds a "value → dropdown index" lookup table so the LLM doesn't need to parse JSON to find which dropdown has which option.
- `buildPrompt` is kept as a **deprecated alias** for `buildInteractionPrompt` for backward compatibility.
