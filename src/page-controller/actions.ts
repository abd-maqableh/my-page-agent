import type {
  ActionExecutionResult,
  ActionQueueResult,
  AgentAction,
} from "../core/types";
import { containsAllWords, meaningfulWords, normalizeArabic, normalizeText } from "../core/text";

/** Poll until a DOM element matching selector appears, or timeoutMs elapses. */
function waitForElement(
  selector: string,
  timeoutMs: number,
  doc: Document,
): Promise<Element | null> {
  return new Promise((resolve) => {
    const existing = doc.querySelector(selector);
    if (existing) return resolve(existing);
    const start = Date.now();
    const check = () => {
      const el = doc.querySelector(selector);
      if (el) return resolve(el);
      if (Date.now() - start < timeoutMs) setTimeout(check, 50);
      else resolve(null);
    };
    setTimeout(check, 50);
  });
}

function findByText(
  query: string,
  elementMap: Map<number, Element>,
): Element | undefined {
  const normalized = normalizeText(query);
  if (!normalized) return undefined;
  for (const el of elementMap.values()) {
    const label = normalizeText(
      el.getAttribute("aria-label") ?? el.textContent ?? "",
    );
    if (label === normalized || label.includes(normalized)) return el;
  }
  return undefined;
}

function getElement(
  index: number | undefined,
  args: AgentAction["args"],
  elementMap: Map<number, Element>,
): Element {
  if (index !== undefined && index !== null) {
    const el = elementMap.get(index);
    if (el) return el;
    throw new Error(`Element not found for index ${index}`);
  }

  // Fallback: search by any string value in args (label, name, text, selector text, etc.)
  const candidates = Object.values(args ?? {}).filter(
    (v): v is string => typeof v === "string",
  );
  for (const candidate of candidates) {
    // Try to extract a numeric index from strings like "[5]" or "element5"
    const numMatch = candidate.match(/\[(\d+)\]/) ?? candidate.match(/^(\d+)$/);
    if (numMatch) {
      const el = elementMap.get(parseInt(numMatch[1], 10));
      if (el) return el;
    }
    // Try label-based text search
    const el = findByText(candidate, elementMap);
    if (el) return el;
  }

  throw new Error("Missing required arg: index");
}

function findMatchingOption(value: string, options: string[]): string | undefined {
  const normalizedQuery = normalizeText(value);

  // Pass 1 — exact normalized match or bidirectional containment
  let match = options.find((option) => {
    const normalizedOption = normalizeText(option);
    const hasText = normalizedOption.length > 0;
    return (
      normalizedOption === normalizedQuery ||
      (hasText && normalizedOption.includes(normalizedQuery)) ||
      (hasText && normalizedQuery.includes(normalizedOption))
    );
  });
  if (match) return match;

  // Pass 2 — all meaningful words of the query must be present in the option
  match = options.find((option) => containsAllWords(option, value));
  if (match) return match;

  // Pass 3 — prefix heuristic: first word of query matches first word of option
  const queryWords = meaningfulWords(value);
  if (queryWords.length > 0) {
    match = options.find((option) => {
      const optWords = meaningfulWords(option);
      return optWords.length > 0 && optWords[0] === queryWords[0];
    });
  }
  if (match) return match;

  // Pass 4 — direct normalizeArabic on both sides (handles diacritic-heavy Arabic)
  match = options.find((option) => normalizeArabic(option) === normalizeArabic(value));
  if (match) return match;

  return undefined;
}

/**
 * Dismiss any open MUI/portal listbox and WAIT until it is actually removed.
 * Escape + ClickAwayListener dismissal is asynchronous, so returning before the
 * portal is gone is exactly what let multiple probed dropdowns stack open. Polls
 * (re-firing the dismiss sequence) until no [role=listbox] remains, up to ~600ms.
 */
async function dismissOpenDropdown(
  doc: Document,
  win: Window & typeof globalThis,
  anchor: HTMLElement | null,
): Promise<void> {
  const fire = () => {
    const openListbox = doc.querySelector('[role="listbox"]') as HTMLElement | null;
    const escTarget: EventTarget = openListbox ?? doc.activeElement ?? doc.body;
    escTarget.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true }),
    );
    doc.body.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, cancelable: true, view: win }));
    doc.body.dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true, cancelable: true, view: win }));
    anchor?.blur?.();
  };
  fire();
  const start = Date.now();
  while (doc.querySelector('[role="listbox"]') && Date.now() - start < 600) {
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    fire();
  }
}

async function selectOnDropdown(
  el: Element,
  index: number | undefined,
  value: string,
  doc: Document,
  win: Window & typeof globalThis,
): Promise<{ success: true; message: string } | { success: false; availableOptions: string[]; message: string }> {
  if (el.tagName.toLowerCase() === "select") {
    const selectEl = el as HTMLSelectElement;
    const options = Array.from(selectEl.options)
      .map((option) => ({
        text: option.text.replace(/\s+/g, " ").trim(),
        value: option.value,
      }))
      .filter((option) => option.text.length > 0 || option.value.length > 0);
    const matchedText = findMatchingOption(value, options.map((option) => option.text));
    const match = matchedText
      ? options.find((option) => option.text === matchedText)
      : undefined;

    if (!match) {
      const availableOptions = options.map((option) => option.text).filter(Boolean);
      return {
        success: false,
        availableOptions,
        message: `No option matched "${value}" on element ${index}. Available options: [${availableOptions.join(", ")}]. Choose one of these EXACT values, or call done if none fits the request.`,
      };
    }

    selectEl.value = match.value;
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));

    return {
      success: true,
      message: `Selected "${match.text}" on element ${index}`,
    };
  }

  if (el.getAttribute("role") === "combobox") {
    (el as HTMLElement).focus();
    el.dispatchEvent(
      new win.MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        view: win,
      }),
    );
    el.dispatchEvent(
      new win.MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        view: win,
      }),
    );
    el.dispatchEvent(
      new win.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: win,
      }),
    );

    const listbox = await waitForElement('[role="listbox"]', 1500, doc);
    if (!listbox) {
      throw new Error(`Dropdown did not open for element ${index}`);
    }

    const normalizedValue = normalizeText(value);
    const findOption = (): HTMLElement | undefined =>
      (Array.from(doc.querySelectorAll('[role="option"]')) as HTMLElement[]).find((opt) => {
        const text = normalizeText(opt.textContent ?? "");
        return (
          text === normalizedValue ||
          text.includes(normalizedValue) ||
          normalizedValue.includes(text)
        );
      });

    let match = findOption();

    if (!match && el instanceof win.HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(
        win.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(el, value);
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      match = findOption();
    }

    const options = Array.from(doc.querySelectorAll('[role="option"]'))
      .map((opt) => (opt.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean);

    if (!match) {
      // Close the portal robustly and WAIT until it is actually gone. Escape +
      // ClickAwayListener dismissal is async; a failed probe that leaves the
      // listbox open is exactly what stacked multiple dropdowns open.
      await dismissOpenDropdown(doc, win, el as HTMLElement);
      return {
        success: false,
        availableOptions: options,
        message: `The filter dropdown has no option matching "${value}". Available options: [${options.join(", ")}]. None of these is "${value}". Either select one of these EXACT values if it is a clear synonym of the request, or call done explaining that "${value}" is not an available filter value and listing the options above.`,
      };
    }

    match.click();

    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    await dismissOpenDropdown(doc, win, el as HTMLElement);

    return {
      success: true,
      message: `Selected "${value}" from dropdown element ${index}`,
    };
  }

  return {
    success: false,
    availableOptions: [],
    message: `Element ${index} is not a dropdown/combobox. The select action only works on dropdown elements. Choose a dropdown element and retry, or call done if none exists.`,
  };
}

function doClick(
  index: number | undefined,
  args: AgentAction["args"],
  elementMap: Map<number, Element>,
  doc: Document,
  win: Window & typeof globalThis,
): Promise<ActionExecutionResult> {
  const el = getElement(index, args, elementMap);
  if (typeof (el as HTMLElement).focus !== "function") {
    throw new Error(`Element ${index} is not clickable.`);
  }

  (el as HTMLElement).focus();
  // Custom comboboxes (MUI Select, Headless UI, Radix, etc.) listen on mousedown
  // rather than click — dispatch the full pointer sequence to open the listbox.
  if (el.getAttribute("role") === "combobox") {
    el.dispatchEvent(
      new win.MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        view: win,
      }),
    );
    el.dispatchEvent(
      new win.MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        view: win,
      }),
    );
    el.dispatchEvent(
      new win.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: win,
      }),
    );
    return waitForElement('[role="listbox"]', 1500, doc).then(() => ({
      success: true,
      message: `Clicked element ${index}`,
    }));
  }

  // Switch / Radio / Checkbox wrapper pattern (common across MUI, Chakra, Radix,
  // Headless UI, etc.): a <button>/<span>/<label> wraps an <input type="checkbox|radio">.
  // Clicking the outer wrapper does NOT toggle the input (the library stops the event).
  // Forward the click to the inner input so the state actually changes.
  const innerToggle = el.querySelector(
    'input[type="checkbox"], input[type="radio"]',
  ) as HTMLInputElement | null;
  if (innerToggle && el !== innerToggle && !(el instanceof HTMLInputElement)) {
    innerToggle.click();
    return Promise.resolve({
      success: true,
      message: `Clicked element ${index} (toggled inner ${innerToggle.type})`,
    });
  }

  (el as HTMLElement).click();

  // If this looks like a form submit button, give async validators / re-render time
  // to surface error helper text BEFORE the next observation snapshot is captured.
  const isSubmit =
    (el as HTMLButtonElement).type === "submit" ||
    (el.closest("form") !== null &&
      /save|create|submit|confirm|apply|update/i.test(
        (el as HTMLElement).innerText || "",
      ));
  if (isSubmit) {
    return new Promise((resolve) => {
      win.setTimeout(
        () =>
          resolve({
            success: true,
            message: `Clicked element ${index} (submit)`,
          }),
        700,
      );
    });
  }

  return Promise.resolve({
    success: true,
    message: `Clicked element ${index}`,
  });
}

/** Validate a date string against a format like "MM/DD/YYYY" or "DD-MM-YYYY". */
function validateDateFormat(text: string, format: string): boolean {
  const regexStr = format
    .replace(/YYYY/g, '\\d{4}')
    .replace(/MM/g, '\\d{2}')
    .replace(/DD/g, '\\d{2}')
    .replace(/[-/.]/g, (sep) => `\\${sep}`);
  return new RegExp(`^${regexStr}$`).test(text);
}

/** Detect a date-format placeholder on an input element (e.g. "MM/DD/YYYY"). */
function detectFormatFromPlaceholder(el: Element): string | null {
  if (el.tagName.toLowerCase() !== 'input') return null;
  const ph = ((el as HTMLInputElement).placeholder || '').trim();
  if (!ph) return null;
  if (/^[YMDHmsAP]{1,4}([/\-. :])[YMDHmsAP]{1,4}(\1[YMDHmsAP]{1,4})*$/i.test(ph)) {
    return ph;
  }
  return null;
}

function doInput(
  index: number | undefined,
  text: string | undefined,
  args: AgentAction["args"],
  elementMap: Map<number, Element>,
  win: Window & typeof globalThis,
): ActionExecutionResult {
  const el = getElement(index, args, elementMap);
  if (!text) {
    throw new Error("Missing required arg: text");
  }

  // Date format validation: if the input has a date-format placeholder,
  // verify the text matches it before dispatching events.
  const fmt = detectFormatFromPlaceholder(el);
  if (fmt) {
    const originalText = text;
    // Try DD Month YYYY → DD/MM/YYYY, e.g. "15 June 2024" → "15/06/2024"
    // Only normalise when the format uses the same separator.
    const sepMatch = fmt.match(/[/.\- :]/);
    if (sepMatch && /^\d{1,2}\s+\w+\s+\d{4}$/i.test(text)) {
      const parts = text.split(/\s+/);
      const day = parts[0].padStart(2, '0');
      const monthNames: Record<string, string> = {
        january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
        july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
      };
      const month = monthNames[parts[1].toLowerCase()] ?? parts[1];
      const year = parts[2];
      text = fmt.includes('DD') ? `${day}${sepMatch[0]}${month}${sepMatch[0]}${year}` : text;
    }
    if (!validateDateFormat(text, fmt)) {
      return {
        success: false,
        message: `Date text "${originalText}" does not match required format "${fmt}". Use the exact format shown in the DATE INPUT placeholder.`,
      };
    }
  }

  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea") {
    const inputEl = el as HTMLInputElement | HTMLTextAreaElement;
    inputEl.focus();
    // Select existing content so the new value REPLACES (matters for masked date pickers
    // and other masked inputs where leftover mask chars like "__/__/____" would otherwise
    // be concatenated).
    try {
      inputEl.setSelectionRange?.(0, inputEl.value.length);
    } catch {
      /* some input types throw on setSelectionRange — ignore */
    }
    // Use the native prototype setter so React's synthetic event system sees the change.
    // Directly setting el.value on a controlled React input is silently ignored.
    const proto =
      tag === "input"
        ? win.HTMLInputElement.prototype
        : win.HTMLTextAreaElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (nativeSetter) {
      nativeSetter.call(inputEl, text);
    } else {
      inputEl.value = text;
    }
    // Use InputEvent (with inputType) instead of plain Event — masked-input libraries
    // (date pickers, react-imask, cleave.js, vanilla mask) inspect inputType to decide whether
    // to accept or reset the value. "insertFromPaste" mimics a paste of the full string.
    const InputEventCtor = (
      win as unknown as { InputEvent?: typeof InputEvent }
    ).InputEvent;
    if (InputEventCtor) {
      el.dispatchEvent(
        new InputEventCtor("input", {
          bubbles: true,
          data: text,
          inputType: "insertFromPaste",
        }),
      );
    } else {
      el.dispatchEvent(new win.Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
    // Many masked date pickers only COMMIT the parsed value on blur.
    // Without this blur, the input visually reverts to empty after re-render.
    el.dispatchEvent(new win.FocusEvent("blur", { bubbles: true }));
    if (typeof inputEl.blur === "function") inputEl.blur();
    return { success: true, message: `Entered text into element ${index}` };
  }

  throw new Error(`Element ${index} does not support text input`);
}

async function doSelect(
  index: number | undefined,
  value: string | undefined,
  args: AgentAction["args"],
  elementMap: Map<number, Element>,
  doc: Document,
  win: Window & typeof globalThis,
): Promise<ActionExecutionResult> {
  if (!value) {
    throw new Error("Missing required arg: value");
  }

  let el = getElement(index, args, elementMap);

  // ROBUST TARGET RESOLUTION (executes the model's choice faithfully, does not
  // decide for it): small models sometimes attach a correct `select` value to a
  // slightly-wrong index (a nearby button/label instead of the dropdown div). If
  // the targeted element is not itself a usable dropdown, redirect to the FILTER
  // DROPDOWN whose OWN options actually include the requested value — so we only
  // ever act on a control that genuinely offers what the model asked for.
  if (!isDropdownLike(el)) {
    const alt = findDropdownForValue(elementMap, value);
    if (alt) el = alt;
  }

  const result = await selectOnDropdown(el, index, value, doc, win);
  return { success: result.success, message: result.message };
}

/** A native <select> or any element exposing the combobox role. */
function isDropdownLike(el: Element): boolean {
  return (
    el.tagName.toLowerCase() === "select" ||
    el.getAttribute("role") === "combobox"
  );
}

/** The option labels a dropdown advertises, WITHOUT opening it. */
function dropdownOptionTexts(el: Element): string[] {
  if (el.tagName.toLowerCase() === "select") {
    return Array.from((el as HTMLSelectElement).options).map(
      (o) => o.textContent ?? "",
    );
  }
  return [];
}

/**
 * Find the dropdown in the current observation whose advertised options include
 * `value`. Used only as a rescue when the model targeted a non-dropdown element —
 * we never override a valid target, we only recover an invalid one by honoring
 * the model's requested VALUE.
 */
function findDropdownForValue(
  elementMap: Map<number, Element>,
  value: string,
): Element | null {
  const v = normalizeText(value);
  if (!v) return null;
  for (const el of elementMap.values()) {
    if (!isDropdownLike(el)) continue;
    const opts = dropdownOptionTexts(el).map(normalizeText);
    if (opts.some((o) => o && (o === v || o.includes(v) || v.includes(o)))) {
      return el;
    }
  }
  return null;
}

function doScroll(
  direction: "up" | "down" = "down",
  amount: number | undefined,
  index: number | undefined,
  args: AgentAction["args"],
  elementMap: Map<number, Element>,
  win: Window & typeof globalThis,
): ActionExecutionResult {
  // If an index is provided, scroll that element into view (used for SECTION targets
  // and any other case where the agent wants to focus a specific element).
  if (index !== undefined && index !== null) {
    const el = getElement(index, args, elementMap);
    (el as HTMLElement).scrollIntoView({ behavior: "smooth", block: "start" });
    // brief visual hint so the user sees which section the agent focused.
    // Uses a neutral blue outline that works on any site, with an opt-in override
    // via the `--agent-focus-color` CSS variable for projects that want to theme it.
    const html = el as HTMLElement;
    const prev = html.style.outline;
    html.style.outline = "2px solid var(--agent-focus-color, #1976d2)";
    win.setTimeout(() => {
      html.style.outline = prev;
    }, 1500);
    return { success: true, message: `Scrolled element ${index} into view` };
  }
  const distance = amount ?? Math.round(win.innerHeight * 0.7);
  const top = direction === "up" ? -Math.abs(distance) : Math.abs(distance);
  win.scrollBy({ top, behavior: "smooth" });

  return {
    success: true,
    message: `Scrolled ${direction} by ${Math.abs(top)}px`,
  };
}

async function doWait(
  timeoutMs = 1000,
  win: Window & typeof globalThis,
): Promise<ActionExecutionResult> {
  await new Promise((resolve) => win.setTimeout(resolve, timeoutMs));
  return { success: true, message: `Waited ${timeoutMs}ms` };
}

async function doNavigate(
  url: string,
  win: Window & typeof globalThis,
): Promise<ActionExecutionResult> {
  if (!url) throw new Error("Missing required arg: url");
  win.location.href = url;
  // Wait until the (possibly replaced) document reports ready, instead of a
  // long fixed sleep. Resolves early on fast SPAs, caps at 4s on slow loads.
  const deadline = Date.now() + 4000;
  // Give the navigation a moment to actually start (readyState flips to "loading").
  await new Promise((resolve) => setTimeout(resolve, 250));
  while (Date.now() < deadline) {
    try {
      if (win.document.readyState === "complete") break;
    } catch {
      /* document may be mid-swap in an iframe — keep polling */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Small grace period for the SPA router/first render to settle.
  await new Promise((resolve) => setTimeout(resolve, 350));
  return { success: true, message: `Navigated to ${url}` };
}

function doClear(
  index: number | undefined,
  args: AgentAction["args"],
  elementMap: Map<number, Element>,
  win: Window & typeof globalThis,
): ActionExecutionResult {
  const el = getElement(index, args, elementMap);
  const tag = el.tagName.toLowerCase();
  if (
    tag !== "input" &&
    tag !== "textarea" &&
    !(el as HTMLElement).isContentEditable
  ) {
    throw new Error(`Element ${index} cannot be cleared`);
  }
  (el as HTMLElement).focus();
  if (tag === "input" || tag === "textarea") {
    const proto =
      tag === "input"
        ? win.HTMLInputElement.prototype
        : win.HTMLTextAreaElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (nativeSetter) nativeSetter.call(el, "");
    else (el as HTMLInputElement).value = "";
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
  } else {
    (el as HTMLElement).textContent = "";
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
  }
  return { success: true, message: `Cleared element ${index}` };
}

function doPressKey(
  index: number | undefined,
  key: string | undefined,
  args: AgentAction["args"],
  elementMap: Map<number, Element>,
  doc: Document,
  win: Window & typeof globalThis,
): ActionExecutionResult {
  if (!key) throw new Error("Missing required arg: key");
  let target: Element | null = null;
  if (index !== undefined && index !== null) {
    target = getElement(index, args, elementMap);
    (target as HTMLElement).focus();
  } else {
    target = doc.activeElement ?? doc.body;
  }
  const keyMap: Record<string, { key: string; code: string; keyCode: number }> =
    {
      enter: { key: "Enter", code: "Enter", keyCode: 13 },
      escape: { key: "Escape", code: "Escape", keyCode: 27 },
      esc: { key: "Escape", code: "Escape", keyCode: 27 },
      tab: { key: "Tab", code: "Tab", keyCode: 9 },
      backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
      delete: { key: "Delete", code: "Delete", keyCode: 46 },
      arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
      arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
      arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
      arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
      space: { key: " ", code: "Space", keyCode: 32 },
    };
  const info = keyMap[key.toLowerCase()] ?? { key, code: key, keyCode: 0 };

  for (const type of ["keydown", "keypress", "keyup"] as const) {
    target?.dispatchEvent(
      new win.KeyboardEvent(type, {
        key: info.key,
        code: info.code,
        keyCode: info.keyCode,
        which: info.keyCode,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
  return {
    success: true,
    message: `Pressed "${key}"${index !== undefined ? ` on element ${index}` : ""}`,
  };
}

function doHover(
  index: number | undefined,
  args: AgentAction["args"],
  elementMap: Map<number, Element>,
  win: Window & typeof globalThis,
): ActionExecutionResult {
  const el = getElement(index, args, elementMap);
  const opts = { bubbles: true, cancelable: true, view: win };
  el.dispatchEvent(new win.MouseEvent("mouseover", opts));
  el.dispatchEvent(new win.MouseEvent("mouseenter", opts));
  el.dispatchEvent(new win.MouseEvent("mousemove", opts));
  return { success: true, message: `Hovered over element ${index}` };
}

export async function runAction(
  action: AgentAction,
  elementMap: Map<number, Element>,
  doc: Document = document,
  win: Window & typeof globalThis = window,
): Promise<ActionExecutionResult> {
  try {
    switch (action.action) {
      case "click":
        return doClick(action.args?.index, action.args, elementMap, doc, win);
      case "input":
        return doInput(
          action.args?.index,
          action.args?.text,
          action.args,
          elementMap,
          win,
        );
      case "select":
        return doSelect(
          action.args?.index,
          action.args?.value ?? action.args?.text,
          action.args,
          elementMap,
          doc,
          win,
        );
      case "scroll":
        return doScroll(
          action.args?.direction,
          action.args?.amount,
          action.args?.index,
          action.args,
          elementMap,
          win,
        );
      case "wait":
        return doWait(action.args?.timeoutMs, win);
      case "navigate":
        return doNavigate(action.args?.url ?? "", win);
      case "clear":
        return doClear(action.args?.index, action.args, elementMap, win);
      case "press_key":
        return doPressKey(
          action.args?.index,
          action.args?.key ?? action.args?.text,
          action.args,
          elementMap,
          doc,
          win,
        );
      case "hover":
        return doHover(action.args?.index, action.args, elementMap, win);
      case "done":
        return {
          success: true,
          message: action.args?.result ?? "Agent marked task as done.",
          done: true,
        };
      default:
        return {
          success: false,
          message: `Unknown action: ${(action as { action: string }).action}`,
        };
    }
  } catch (error) {
    return {
      success: false,
      message:
        error instanceof Error ? error.message : "Unknown execution error",
    };
  }
}

/**
 * Execute the model's planned actions IN ORDER as a queue. There is no re-ask
 * loop: whatever the model returned is what runs. The queue stops early ONLY on
 * a failed action or an explicit `done`. `click` / `navigate` are NOT treated as
 * boundaries here because navigation is resolved deterministically BEFORE the
 * single model call, so the plan targets the page that is already rendered.
 */
export async function runActionQueue(
  actions: AgentAction[],
  elementMap: Map<number, Element>,
  doc: Document = document,
  win: Window & typeof globalThis = window,
): Promise<ActionQueueResult> {
  const items: ActionQueueResult["items"] = [];

  if (actions.length === 0) {
    return {
      items,
      done: false,
      error: "Model returned no actions.",
    };
  }

  for (const action of actions) {
    const result = await runAction(action, elementMap, doc, win);
    items.push({ action, result });

    if (!result.success) {
      return {
        items,
        done: false,
        error: result.message,
      };
    }

    if (action.action === "done" || result.done) {
      return {
        items,
        done: true,
      };
    }
  }

  return {
    items,
    done: false,
  };
}
