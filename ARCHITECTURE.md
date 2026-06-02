# My Page Agent — Architecture & Flow

---

## 1. Component Overview

```mermaid
flowchart TD
    User(["User (browser)"])
    Panel["Panel UI\n(Panel.ts)"]
    MyPageAgent["MyPageAgent\n(index.ts)"]
    Agent["Agent\ncore/Agent.ts"]
    LLMFactory["createLLMClient\nllm/createLLMClient.ts"]
    OpenAI["OpenAIClient\nllm/OpenAIClient.ts\n(universal — works with\nOllama, Groq, Azure, etc.)"]
    Normalizer["normalizeAction\ncore/tools.ts"]
    PageCtrl["PageController\npage-controller/PageController.ts"]
    Scanner["scanInteractiveElements\npage-controller/domScanner.ts"]
    Actions["runAction\npage-controller/actions.ts"]
    PromptBuilder["buildPrompt\ncore/prompt.ts"]
    DOM[("Live Browser DOM")]

    %% Entry
    User -->|"types task + clicks Run"| Panel
    Panel -->|"execute(task)"| MyPageAgent
    MyPageAgent -->|"delegates"| Agent

    %% ── STEP LOOP ──────────────────────────────────────
    subgraph LOOP ["Agent.execute() — step loop (max N steps)"]
        direction TB

        OBS1["observe() → capture prevUrl"]
        PROMPT["buildPrompt(task, obs, history, pages?)"]
        LLM_REQ["client.getNextAction(messages)"]
        CONFIRM{"confirmAction\ngate?"}
        EXEC["executeAction(action)"]
        SETTLE["wait 600 ms\nif click/input/select"]
        OBS2["observe() again → capture nextUrl"]

        NAV_CHK{"URL changed?\n(nextUrl ≠ prevUrl)"}
        UUID_CHK{"New URL contains\nUUID? (list→detail)"}
        DONE_DETAIL1(["return done\n(navigatedToDetail)"])

        MENU_CHK{"action=click\n&& !navigated\n&& MENU ITEMs visible?"}
        MENU_AUTO["Auto-click matching\nmenu item\n(view/edit intent)"]
        WAIT_MENU["wait 800 ms"]
        MENU_UUID{"afterMenuUrl\ncontains UUID?"}
        DONE_MENU(["return done\n(menu→detail nav)"])

        ACTION_CHK{"action=done\nor result.done?"}
        DONE_NORMAL(["return done"])
        NEXT_STEP["next step →"]
        MAX(["return max_steps"])
        ERR(["return error"])

        OBS1 --> PROMPT --> LLM_REQ
        LLM_REQ -->|"AgentAction"| CONFIRM
        CONFIRM -->|"allowed"| EXEC
        CONFIRM -->|"rejected"| ERR
        LLM_REQ -->|"LLM error"| ERR
        EXEC --> SETTLE --> OBS2
        OBS2 --> NAV_CHK
        NAV_CHK -->|"yes"| UUID_CHK
        NAV_CHK -->|"no"| MENU_CHK
        UUID_CHK -->|"yes"| DONE_DETAIL1
        UUID_CHK -->|"no → annotate result"| MENU_CHK
        MENU_CHK -->|"yes"| MENU_AUTO --> WAIT_MENU --> MENU_UUID
        MENU_UUID -->|"yes"| DONE_MENU
        MENU_UUID -->|"no"| NEXT_STEP
        MENU_CHK -->|"no"| ACTION_CHK
        ACTION_CHK -->|"yes"| DONE_NORMAL
        ACTION_CHK -->|"no"| NEXT_STEP
        NEXT_STEP -->|"step < maxSteps"| OBS1
        NEXT_STEP -->|"step = maxSteps"| MAX
        EXEC -->|"result.success=false"| ERR
    end

    %% ── DOM scanning ──────────────────────────────────
    Agent --> OBS1
    PageCtrl -->|"scanInteractiveElements(doc, win)"| Scanner
    Scanner -->|"reads"| DOM
    Scanner -->|"ScanResult {elements, elementMap, text}"| PageCtrl
    PageCtrl -->|"PageObservation"| Agent

    %% ── Prompt building ───────────────────────────────
    PROMPT --> PromptBuilder
    PromptBuilder -->|"ChatMessage[]"| LLM_REQ

    %% ── LLM clients ───────────────────────────────────
    LLM_REQ --> LLMFactory
    LLMFactory --> OpenAI
    OpenAI -->|"raw JSON"| Normalizer
    Normalizer -->|"AgentAction"| CONFIRM

    %% ── DOM execution ─────────────────────────────────
    EXEC --> PageCtrl
    PageCtrl -->|"runAction()"| Actions
    Actions -->|"click / input / select\nscroll / wait / navigate / done"| DOM
    Actions -->|"ActionExecutionResult"| PageCtrl

    %% ── Callbacks ─────────────────────────────────────
    Agent -->|"onStatus callback"| MyPageAgent
    Agent -->|"onStep callback"| MyPageAgent
    MyPageAgent -->|"status string"| Panel
    MyPageAgent -->|"formatted step line"| Panel

    %% ── Final result ──────────────────────────────────
    DONE_NORMAL --> MyPageAgent
    DONE_DETAIL1 --> MyPageAgent
    DONE_MENU --> MyPageAgent
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
        -maxSteps: number
        -client: LLMClient
        -pageController: PageController
        -callbacks: AgentCallbacks
        -confirmAction: Function
        -pages: Record
        +execute(task) AgentRunResult
    }

    class PageController {
        -elementMap: Map~number, Element~
        -targetFrame: HTMLIFrameElement
        -getDocWin() DocWin
        +observe() PageObservation
        +executeAction(action) ActionExecutionResult
    }

    class OpenAIClient {
        -config: LLMConfig
        +getNextAction(messages) AgentAction
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
        +getNextAction(messages) AgentAction
    }

    MyPageAgent --> Agent : creates & wraps
    MyPageAgent --> Panel : wired via mountAgentPanel()
    Agent --> PageController : observe + execute
    Agent --> LLMClient : getNextAction
    LLMClient <|.. OpenAIClient : implements
    Panel --> MyPageAgent : calls execute / listens to events
```

---

## 3. Sequence Diagram — One Agent Step

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

    loop Step 1…maxSteps
        Agent->>PageCtrl: observe()
        PageCtrl->>Scanner: scanInteractiveElements(doc, win)
        Scanner->>DOM: querySelectorAll(INTERACTIVE_SELECTOR)
        DOM-->>Scanner: Element[]
        Scanner-->>PageCtrl: ScanResult {elements, elementMap, text}
        PageCtrl-->>Agent: PageObservation {url, title, elements, elementsText}

        Note over Agent: capture prevUrl

        Agent->>Prompt: buildPrompt(task, obs, history, pages?)
        Prompt-->>Agent: ChatMessage[] [system + user]

        Agent->>LLM: getNextAction(messages)
        LLM-->>Agent: AgentAction {thought, action, args}

        alt confirmAction gate configured
            Agent->>Agent: confirmAction(action)
            Agent-->>Agent: allowed / rejected
        end

        Agent->>PageCtrl: executeAction(action)
        PageCtrl->>Actions: runAction(action, elementMap, doc, win)
        Actions->>DOM: doClick / doInput / doSelect / doScroll / doWait / doNavigate
        DOM-->>Actions: DOM updated
        Actions-->>PageCtrl: ActionExecutionResult
        PageCtrl-->>Agent: ActionExecutionResult

        Note over Agent: wait 600ms if click/input/select

        Agent->>PageCtrl: observe() — capture nextUrl
        PageCtrl-->>Agent: PageObservation (post-action)

        alt URL changed && UUID in new URL
            Agent-->>MyPageAgent: return done (navigatedToDetail)
        else URL changed (no UUID)
            Note over Agent: annotate result with → navigated to URL
        else click && no navigation && MENU ITEMs visible
            Agent->>PageCtrl: executeAction(click menuItem)
            PageCtrl->>Actions: runAction(click, menuIndex)
            Actions->>DOM: click MENU ITEM
            DOM-->>Actions: DOM updated
            Actions-->>PageCtrl: ActionExecutionResult
            PageCtrl-->>Agent: result
            Note over Agent: wait 800ms
            alt afterMenuUrl contains UUID
                Agent-->>MyPageAgent: return done (menu→detail)
            else
                Note over Agent: continue loop
            end
        else action=done or result.done
            Agent-->>MyPageAgent: return done
        else result.success=false
            Agent-->>MyPageAgent: return error
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

    Idle --> Observing : execute(task) called

    state "Step Loop" as Loop {
        Observing --> Building : PageObservation captured
        Building --> Thinking : ChatMessage[] ready
        Thinking --> Confirming : AgentAction received
        Confirming --> Executing : confirmAction = true
        Confirming --> [*] : confirmAction = false → error
        Thinking --> [*] : LLM error → error
        Executing --> Settling : action dispatched to DOM
        Settling --> PostObserve : 600ms elapsed
        PostObserve --> CheckNav : nextUrl captured

        state CheckNav {
            [*] --> NavDetect
            NavDetect --> DetailDone : URL changed + UUID found
            NavDetect --> MenuCheck : URL unchanged
            NavDetect --> AnnotateNav : URL changed, no UUID
            AnnotateNav --> MenuCheck
            MenuCheck --> AutoMenu : MENU ITEMs visible after click
            MenuCheck --> ActionCheck : no menu
            AutoMenu --> MenuDetailDone : afterMenuUrl has UUID
            AutoMenu --> ActionCheck : no UUID after menu
            ActionCheck --> NormalDone : action=done or result.done
            ActionCheck --> NextStep : task continues
            ActionCheck --> [*] : result.success=false → error
        }

        NextStep --> Observing : step < maxSteps
    }

    NextStep --> [*] : step = maxSteps → max_steps
    NormalDone --> [*] : status = done
    DetailDone --> [*] : status = done
    MenuDetailDone --> [*] : status = done
```

---

## 5. LLM Response Processing Pipeline

```mermaid
flowchart LR
    RAW["Raw LLM text\n(may have markdown fences,\nextra prose)"]
    FENCE["Strip markdown\ncode fences"]
    EXTRACT["extractJSON()\nbalanced-bracket\ncursor walk"]
    PARSE["JSON.parse()"]
    NORMALIZE["normalizeAction()\n• validate action name\n• hoist flat args\n• extract index from thought"]
    ACTION["AgentAction\n{thought, action, args}"]

    ERR1(["throw: no JSON object"])
    ERR2(["throw: invalid JSON"])
    ERR3(["throw: invalid action name"])

    RAW --> FENCE --> EXTRACT
    EXTRACT -->|"no { found"| ERR1
    EXTRACT -->|"balanced JSON string"| PARSE
    PARSE -->|"SyntaxError"| ERR2
    PARSE -->|"object"| NORMALIZE
    NORMALIZE -->|"unknown action"| ERR3
    NORMALIZE -->|"valid"| ACTION
```

---

## 6. DOM Scanning & Label Resolution

```mermaid
flowchart TD
    ROOT["document / iframe.contentDocument"]
    QSA["querySelectorAll\n(button, a, input, textarea,\nselect, role=button/link/\ntextbox/combobox/menuitem/option,\n onclick , tabindex )"]
    DEDUP["deduplicate\n& filter visible"]
    PANEL["exclude\n data-agent-panel \nelements"]
    INDEX["assign 1-based indexes\nbuild elementMap"]
    LABEL["getLabel(el)\npriority chain"]

    subgraph LABEL_CHAIN ["Label priority"]
        L1["aria-label"]
        L2["title attr"]
        L3["input: label tag / placeholder"]
        L4["select: FILTER DROPDOWN: {selected}"]
        L5["combobox: FILTER DROPDOWN: {text}"]
        L6["menuitem: MENU ITEM: {text}"]
        L7["option: DROPDOWN OPTION: {text}"]
        L8["ellipsis btn: Per-item actions menu (title)"]
        L9["textContent fallback"]
        L10["tagName element"]
        L1 --> L2 --> L3 --> L4 --> L5 --> L6 --> L7 --> L8 --> L9 --> L10
    end

    TEXT["serialise to text block\n[1] button "Submit"\n[2] input:text "Search"\n…"]
    RESULT["ScanResult\n{elements, elementMap, text}"]

    ROOT --> QSA --> DEDUP --> PANEL --> INDEX --> LABEL
    LABEL --> LABEL_CHAIN
    INDEX --> TEXT
    LABEL_CHAIN --> TEXT
    TEXT --> RESULT
```
