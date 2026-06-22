import type { PageElementSummary } from "../core/types";
import { meaningfulWords } from "../core/text";

export interface ScanResult {
  elements: PageElementSummary[];
  elementMap: Map<number, Element>;
  text: string;
}

const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "summary",
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
  "[onclick]",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function isVisible(el: Element, win: Window & typeof globalThis): boolean {
  if (typeof (el as HTMLElement).focus !== "function") {
    return false;
  }

  // aria-hidden and inert ancestors are treated as not interactable
  if (el.closest('[aria-hidden="true"], [inert]')) {
    return false;
  }

  const rect = (el as HTMLElement).getBoundingClientRect();
  const style = win.getComputedStyle(el as HTMLElement);
  if (style.pointerEvents === "none") return false;
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.visibility !== "hidden" &&
    style.display !== "none"
  );
}

function stateDetails(el: Element): string[] {
  const parts: string[] = [];
  const ariaDisabled = el.getAttribute("aria-disabled") === "true";
  const disabled = (el as HTMLInputElement).disabled === true || ariaDisabled;
  const readOnly =
    (el as HTMLInputElement).readOnly === true ||
    el.getAttribute("aria-readonly") === "true";
  const required =
    (el as HTMLInputElement).required === true ||
    el.getAttribute("aria-required") === "true";
  const invalid = el.getAttribute("aria-invalid") === "true";
  const expanded = el.getAttribute("aria-expanded");
  const pressed = el.getAttribute("aria-pressed");
  const current = el.getAttribute("aria-current");
  const checked = el.getAttribute("aria-checked");

  if (disabled) parts.push("disabled");
  if (readOnly) parts.push("readonly");
  if (required) parts.push("required");
  if (invalid) {
    const errId =
      el.getAttribute("aria-errormessage") ||
      el.getAttribute("aria-describedby");
    const msg = errId
      ? (el.ownerDocument?.getElementById(errId)?.textContent ?? "").trim()
      : "";
    parts.push(msg ? `invalid: ${msg.substring(0, 60)}` : "invalid");
  }
  if (expanded === "true") parts.push("expanded");
  else if (expanded === "false") parts.push("collapsed");
  if (pressed === "true") parts.push("pressed");
  if (current && current !== "false") parts.push("current");
  if (checked === "true") parts.push("checked");
  else if (checked === "false") parts.push("unchecked");

  // Native checkbox / radio
  if (
    el instanceof HTMLInputElement &&
    (el.type === "checkbox" || el.type === "radio")
  ) {
    parts.push(el.checked ? "checked" : "unchecked");
  }

  return parts;
}

function looksLikeSearch(text: string): boolean {
  return /search|filter|find|query|lookup/i.test(text);
}

/**
 * Detect masked / custom date inputs (e.g. MUI X DatePicker, react-datepicker, flatpickr,
 * vanilla mask libraries) that use type="text" with a date-shaped placeholder. Returns the
 * placeholder/format string so we can surface it to the LLM ("format: MM/DD/YYYY") — without
 * this hint the LLM may type dates in the wrong locale and the picker will silently reject
 * them.
 */
function detectDateFormat(el: HTMLInputElement): string | null {
  const ph = (el.placeholder || "").trim();
  if (!ph) return null;
  // Match patterns like MM/DD/YYYY, DD-MM-YYYY, YYYY/MM/DD, MM.DD.YY, M/D/YYYY, etc.
  if (
    /^[YMDHmsAP]{1,4}([/\-. :])[YMDHmsAP]{1,4}(\1[YMDHmsAP]{1,4})*$/i.test(ph)
  ) {
    return ph;
  }
  return null;
}

function ariaLabelledByText(el: Element): string {
  const ids = el.getAttribute("aria-labelledby");
  if (!ids) return "";
  return ids
    .split(/\s+/)
    .map(
      (id) => el.ownerDocument?.getElementById(id)?.textContent?.trim() ?? "",
    )
    .filter(Boolean)
    .join(" ");
}

/**
 * Resolve the FIELD NAME (e.g. "Region", "Request Status") for a form control.
 * Without this, custom dropdowns (MUI Select/Autocomplete, antd, react-select)
 * surface only their CURRENT VALUE ("All") and the LLM cannot tell which filter
 * the control represents. Checks label[for=id], a wrapping <label>, then nearby
 * <label> elements inside ancestor form-control wrappers (the MUI pattern where
 * the label is a sibling of the input wrapper).
 */
function fieldNameFor(el: Element): string {
  const doc = el.ownerDocument;
  const id = el.getAttribute("id");
  if (id && doc) {
    try {
      const lbl = doc.querySelector(`label[for="${CSS.escape(id)}"]`);
      const t = lbl?.textContent?.replace(/\s+/g, " ").trim();
      if (t) return t;
    } catch {
      /* invalid selector chars in id */
    }
  }
  const wrapping = el.closest("label");
  if (wrapping) {
    const clone = wrapping.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll("select, input, textarea")
      .forEach((child) => child.remove());
    const t = clone.textContent?.replace(/\s+/g, " ").trim();
    if (t) return t;
  }
  let node: Element | null = el.parentElement;
  for (
    let depth = 0;
    node && depth < 4;
    depth += 1, node = node.parentElement
  ) {
    const lbl = node.querySelector(
      'label, [class*="FormLabel"], [class*="form-label"]',
    );
    const t = lbl?.textContent?.replace(/\s+/g, " ").trim();
    if (t) return t;
    if (node.tagName === "FORM") break;
  }
  return "";
}

function agentMetaCandidates(el: Element): Element[] {
  const matches = new Set<Element>();
  const HAS_AGENT_META =
    "[data-agent-name], [data-agent-value], [data-agent-values], [data-agent-options], [data-agent-multiselect]";

  matches.add(el);
  let node: Element | null = el.parentElement;
  for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
    if (node.matches(HAS_AGENT_META)) matches.add(node);
  }

  el.querySelectorAll(HAS_AGENT_META).forEach((node) => matches.add(node));
  return Array.from(matches);
}

function agentMetaText(el: Element, attr: string): string {
  for (const node of agentMetaCandidates(el)) {
    const val = cleanText(node.getAttribute(attr) || "");
    if (val) return val;
  }
  return "";
}

function agentMetaList(el: Element, attr: string): string[] {
  const values: string[] = [];
  for (const node of agentMetaCandidates(el)) {
    const raw = node.getAttribute(attr) || "";
    if (!raw) continue;
    raw
      .split(",")
      .map((s) => cleanText(s))
      .filter(Boolean)
      .forEach((s) => values.push(s));
  }
  return unique(values);
}

function agentMetaBool(el: Element, attr: string): boolean {
  return agentMetaCandidates(el).some(
    (node) => (node.getAttribute(attr) || "").toLowerCase() === "true",
  );
}

function comboboxOptions(el: Element): string[] {
  const declared = agentMetaList(el, "data-agent-options");

  const doc = el.ownerDocument ?? document;
  const opts: string[] = [];
  const owns =
    el.getAttribute("aria-controls") || el.getAttribute("aria-owns") || "";
  for (const id of owns.split(/\s+/).filter(Boolean)) {
    doc
      .getElementById(id)
      ?.querySelectorAll('[role="option"]')
      .forEach((o) => {
        const t = (o.textContent ?? "").replace(/\s+/g, " ").trim();
        if (t) opts.push(t);
      });
  }
  return unique([...declared, ...opts]);
}

function controlledListboxes(el: Element): Element[] {
  const doc = el.ownerDocument ?? document;
  const ids = `${el.getAttribute("aria-controls") || ""} ${el.getAttribute("aria-owns") || ""}`
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const nodes: Element[] = [];
  for (const id of ids) {
    const node = doc.getElementById(id);
    if (node) nodes.push(node);
  }
  return nodes;
}

function selectedListboxValues(el: Element): string[] {
  const declaredValues = agentMetaList(el, "data-agent-values");

  const values: string[] = [];
  for (const listbox of controlledListboxes(el)) {
    listbox.querySelectorAll('[role="option"][aria-selected="true"]').forEach((opt) => {
      const t = cleanText(opt.textContent ?? "");
      if (t) values.push(t);
    });
  }
  return unique([...declaredValues, ...values]);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function describeOptions(options: string[]): string {
  if (options.length === 0) return "";
  return ` Available options: ${options.join(", ")}.`;
}

function describeSelection(values: string[], emptyFallback = "none"): string {
  if (values.length === 0) return ` Current selection: ${emptyFallback}.`;
  return ` Current selection: ${values.join(", ")}.`;
}

function isMultiSelectElement(el: Element): boolean {
  if (agentMetaBool(el, "data-agent-multiselect")) return true;
  if (el instanceof HTMLSelectElement) return el.multiple;
  if (el.getAttribute("aria-multiselectable") === "true") return true;
  if (el.getAttribute("multiple") !== null) return true;
  return controlledListboxes(el).some(
    (listbox) => listbox.getAttribute("aria-multiselectable") === "true",
  );
}

function cleanText(text: string): string {
  return text.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
}

function labelFromText(el: Element): string {
  const aria = cleanText(el.getAttribute("aria-label") || "");
  const labelledBy = ariaLabelledByText(el);
  const title = cleanText(el.getAttribute("title") || "");
  const text = cleanText(el.textContent ?? "");
  return aria || labelledBy || title || text;
}

function describeElement(
  el: Element,
): { label: string; description: string } {
  const states = stateDetails(el);
  const stateText = states.length ? ` State: ${states.join(", ")}.` : "";

  const baseLabel = (): string => {
    const txt = labelFromText(el);
    if (txt) return txt;
    if (el instanceof HTMLInputElement && el.placeholder?.trim()) {
      return el.placeholder.trim();
    }
    if (el instanceof HTMLInputElement && el.name) return el.name;
    if (el instanceof HTMLTextAreaElement && el.placeholder?.trim()) {
      return el.placeholder.trim();
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const field = fieldNameFor(el);
      if (field) return field;
    }
    return `${el.tagName.toLowerCase()} element`;
  };

  if (el instanceof HTMLInputElement) {
    const declaredName = agentMetaText(el, "data-agent-name");
    const declaredCurrent = agentMetaText(el, "data-agent-value");
    const labelTxt =
      declaredName ||
      fieldNameFor(el) ||
      Array.from(el.labels ?? [])
        .map((l) => l.textContent?.trim())
        .filter(Boolean)
        .join(" ") ||
      "";
    const label = labelTxt || el.placeholder?.trim() || el.name || baseLabel();
    const type = (el.type || "text").toLowerCase();

    const isComboInput =
      el.getAttribute("role") === "combobox" ||
      el.getAttribute("aria-haspopup") === "listbox" ||
      !!el.getAttribute("aria-autocomplete");
    if (isComboInput) {
      const mode = isMultiSelectElement(el) ? "multi-select" : "single-select";
      const current = declaredCurrent || el.value?.trim() || "";
      const selectedFromListbox = selectedListboxValues(el);
      const selection = unique([
        ...(current ? [current] : []),
        ...selectedFromListbox,
      ]);
      const options = comboboxOptions(el);
      const optionsText =
        options.length > 0
          ? describeOptions(options)
          : " Options are not currently exposed in DOM (often hidden until opened).";
      const selectionText = describeSelection(selection);
      const expandedText =
        el.getAttribute("aria-expanded") === "true"
          ? " Dropdown is currently expanded."
          : " Dropdown is currently collapsed.";
      return {
        label,
        description: `Filter dropdown (combobox). Selection mode: ${mode}.${selectionText}${optionsText}${expandedText}${stateText}`,
      };
    }

    const dateFormat = detectDateFormat(el);
    if (
      dateFormat ||
      ["date", "datetime-local", "time", "month", "week"].includes(type)
    ) {
      const formatText = dateFormat ? ` Format: ${dateFormat}.` : "";
      return {
        label,
        description: `Date input.${formatText}${stateText}`,
      };
    }

    if (looksLikeSearch(`${label} ${el.placeholder ?? ""} ${el.name ?? ""}`)) {
      return {
        label,
        description: `Search box for keyword filtering.${stateText}`,
      };
    }

    if (type === "checkbox" || type === "radio") {
      return {
        label,
        description: `${type === "checkbox" ? "Checkbox" : "Radio option"}.${stateText}`,
      };
    }

    if (type === "submit") {
      return {
        label,
        description: `Submit button.${stateText}`,
      };
    }

    if (type === "file") {
      return {
        label,
        description: `File upload input.${stateText}`,
      };
    }

    return {
      label,
      description: `Text input field.${stateText}`,
    };
  }

  if (el instanceof HTMLTextAreaElement) {
    const label =
      fieldNameFor(el) || el.placeholder?.trim() || labelFromText(el) || "notes";
    return {
      label,
      description: `Multi-line text input.${stateText}`,
    };
  }

  if (el instanceof HTMLSelectElement) {
    const declaredName = agentMetaText(el, "data-agent-name");
    const declaredCurrent = agentMetaText(el, "data-agent-value");
    const declaredValues = agentMetaList(el, "data-agent-values");
    const label = declaredName || fieldNameFor(el) || labelFromText(el) || "select option";
    const mode = el.multiple ? "multi-select" : "single-select";
    const currentValues = Array.from(el.selectedOptions)
      .map((o) => cleanText(o.textContent ?? ""))
      .filter(Boolean);
    if (declaredCurrent) currentValues.push(declaredCurrent);
    currentValues.push(...declaredValues);
    const opts = Array.from(el.options)
      .map((o) => o.textContent?.replace(/\s+/g, " ").trim())
      .filter((t): t is string => !!t);
    const declaredOptions = agentMetaList(el, "data-agent-options");
    const optionsText = describeOptions(unique([...declaredOptions, ...opts]));
    const selectionText = describeSelection(unique(currentValues));
    return {
      label,
      description: `Filter dropdown (native select). Selection mode: ${mode}.${selectionText}${optionsText}${stateText}`,
    };
  }

  if (el instanceof HTMLButtonElement && el.type === "submit") {
    return {
      label: labelFromText(el) || "Submit",
      description: `Submit button.${stateText}`,
    };
  }

  const role = el.getAttribute("role");
  const textLabel = labelFromText(el) || baseLabel();

  if (role === "tab") {
    return {
      label: textLabel,
      description: `Tab that switches page content.${stateText}`,
    };
  }

  if (role === "combobox") {
    const declaredName = agentMetaText(el, "data-agent-name");
    const declaredCurrent = agentMetaText(el, "data-agent-value");
    const field = declaredName || fieldNameFor(el) || textLabel || "select option";
    const mode = isMultiSelectElement(el) ? "multi-select" : "single-select";
    const current = declaredCurrent || cleanText(el.textContent ?? "");
    const selectedFromListbox = selectedListboxValues(el);
    const selection = unique([
      ...(current ? [current] : []),
      ...selectedFromListbox,
    ]);
    const options = comboboxOptions(el);
    const optionsText =
      options.length > 0
        ? describeOptions(options)
        : " Options are not currently exposed in DOM (often hidden until opened).";
    const selectionText = describeSelection(selection);
    const expandedText =
      el.getAttribute("aria-expanded") === "true"
        ? " Dropdown is currently expanded."
        : " Dropdown is currently collapsed.";
    return {
      label: field,
      description: `Filter dropdown (combobox). Selection mode: ${mode}.${selectionText}${optionsText}${expandedText}${stateText}`,
    };
  }

  if (role === "searchbox") {
    return {
      label: textLabel || "Search",
      description: `Search box for keyword filtering.${stateText}`,
    };
  }

  if (
    role === "menuitem" ||
    role === "menuitemcheckbox" ||
    role === "menuitemradio"
  ) {
    return {
      label: textLabel || "menu option",
      description: `Menu action item.${stateText}`,
    };
  }

  if (role === "option") {
    const selected = el.getAttribute("aria-selected") === "true";
    return {
      label: textLabel || "option",
      description: `Selectable dropdown option.${selected ? " Currently selected." : ""}${stateText}`,
    };
  }

  if (role === "switch") {
    return {
      label: textLabel || "switch",
      description: `Toggle control.${stateText}`,
    };
  }

  if (role === "checkbox") {
    return {
      label: textLabel || "checkbox",
      description: `Checkbox control.${stateText}`,
    };
  }

  if (role === "radio") {
    return {
      label: textLabel || "radio",
      description: `Radio control.${stateText}`,
    };
  }

  if (role === "slider" || role === "spinbutton") {
    const value = el.getAttribute("aria-valuenow") ?? "";
    return {
      label: textLabel || role,
      description: `${role === "slider" ? "Slider" : "Number spinner"}.${
        value ? ` Current value: ${value}.` : ""
      }${stateText}`,
    };
  }

  if ((el as HTMLElement).isContentEditable) {
    return {
      label: textLabel || "rich text",
      description: `Rich text editable area.${stateText}`,
    };
  }

  const text = textLabel;

  // Wrapper buttons / labels that contain a single checkbox/radio (common Switch pattern
  // across MUI, Chakra, Radix, Headless UI, etc.): surface the input's state so the LLM
  // knows whether it's currently on/off.
  if (el.tagName === "BUTTON" || el.tagName === "LABEL") {
    const innerToggle = el.querySelector(
      'input[type="checkbox"], input[type="radio"]',
    ) as HTMLInputElement | null;
    if (innerToggle && text) {
      const stateWord = innerToggle.checked ? "checked" : "unchecked";
      return {
        label: text,
        description: `${innerToggle.type === "radio" ? "Radio" : "Toggle"} control. Current value: ${stateWord}.${stateText}`,
      };
    }
  }

  // Icon-only / ellipsis buttons
  if (
    !text ||
    text === "..." ||
    text === "\u22EF" ||
    text === "\u2022\u2022\u2022" ||
    /^[.\u22EF\u2026\u22EE\u22F0\u22F1]+$/.test(text)
  ) {
    // Find the nearest enclosing "item-like" container by walking up ancestors and
    // checking for any class/role/aria hint suggesting a card / list-item / row.
    let ancestor: Element | null = el.parentElement;
    let cardTitle: string | undefined;
    while (ancestor && ancestor !== el.ownerDocument?.body) {
      const role = ancestor.getAttribute("role") || "";
      const className = (ancestor.getAttribute("class") || "").toLowerCase();
      const tag = ancestor.tagName.toLowerCase();
      const isItemLike =
        tag === "li" ||
        tag === "tr" ||
        tag === "article" ||
        role === "listitem" ||
        role === "row" ||
        role === "article" ||
        /\b(card|item|row|tile|cell)\b/.test(className);
      if (isItemLike) {
        cardTitle = ancestor
          .querySelector("h1,h2,h3,h4,h5,h6,strong")
          ?.textContent?.trim();
        if (cardTitle) break;
      }
      ancestor = ancestor.parentElement;
    }
    const scope = cardTitle ? ` (${cardTitle.substring(0, 30)})` : "";
    return {
      label: "Per-item actions menu",
      description: `Opens a menu with actions for a single item${scope}.${stateText}`,
    };
  }

  if (text) {
    // Utility/toolbar buttons (Refresh, Reload, devtools) frequently share words
    // with the data the user names (e.g. "Refresh Applications List" vs "sent
    // applications"), which tempts a small model to click them instead of using
    // the filter. Flag them so they stop competing with real filter controls.
    const isButtonish =
      el.tagName === "BUTTON" ||
      el.getAttribute("role") === "button" ||
      el.tagName === "A";
    if (
      isButtonish &&
      /\b(refresh|reload|re-?fetch|devtools)\b|تحديث|إعادة تحميل/i.test(text)
    ) {
      return {
        label: text,
        description: `Utility action.${stateText}`,
      };
    }
    const linkLike = el.tagName.toLowerCase() === "a" || role === "link";
    const buttonLike =
      el.tagName.toLowerCase() === "button" || role === "button";
    return {
      label: text,
      description: `${buttonLike ? "Button action" : linkLike ? "Link action" : "Interactive element"}.${stateText}`,
    };
  }

  return {
    label: `${el.tagName.toLowerCase()} element`,
    description: `Interactive element.${stateText}`,
  };
}

function getType(el: Element): string | null {
  if (el instanceof HTMLInputElement) {
    return el.type || "text";
  }
  return null;
}

/**
 * Detects the topmost open modal/dialog so the agent can focus on it.
 * Returns the dialog Element or null.
 *
 * Framework-agnostic. Detection sources, in priority order:
 *  1. Native <dialog open> and ARIA roles ("dialog", "alertdialog")
 *  2. Any element with aria-modal="true"
 *  3. Generic class-name heuristic: visible elements whose class contains a modal/drawer
 *     keyword ("modal", "dialog", "drawer", "overlay", "sheet") and that are NOT non-blocking
 *     popovers ("popover", "menu", "tooltip", "snackbar", "toast", "notification").
 */
function findOpenModal(doc: Document): Element | null {
  const win = doc.defaultView;
  if (!win) return null;

  const candidates = new Set<Element>();
  doc
    .querySelectorAll(
      '[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]',
    )
    .forEach((el) => candidates.add(el));

  // Class-name heuristic — match any visible element with a modal-ish class fragment.
  const MODAL_HINT = /\b(modal|dialog|drawer|overlay|sheet)\b/i;
  const NON_BLOCKING =
    /\b(popover|menu|tooltip|snackbar|toast|notification|backdrop)\b/i;
  doc.querySelectorAll("[class]").forEach((el) => {
    const cls = el.getAttribute("class") || "";
    if (!MODAL_HINT.test(cls) || NON_BLOCKING.test(cls)) return;
    candidates.add(el);
  });

  // Z-index heuristic — detect modal overlays by computed z-index > 100.
  // Some UI frameworks render modals as plain <div>s without ARIA roles or
  // modal-ish class names, relying solely on a high z-index to overlay.
  doc.querySelectorAll(
    '[class*="overlay"], [class*="backdrop"], [class*="modal"]',
  ).forEach((el) => {
    if (candidates.has(el)) return;
    if (el.closest("[data-agent-panel]")) return;
    const z = parseInt(win.getComputedStyle(el as HTMLElement).zIndex ?? "0", 10);
    if (z > 100 && isVisible(el, win)) {
      candidates.add(el);
    }
  });

  // Pick the highest z-index candidate (modals with higher z-index are "on top").
  const ordered = Array.from(candidates).sort((a, b) => {
    const za = parseInt(win.getComputedStyle(a as HTMLElement).zIndex, 10) || 0;
    const zb = parseInt(win.getComputedStyle(b as HTMLElement).zIndex, 10) || 0;
    return zb - za;
  });
  for (const c of ordered) {
    const style = win.getComputedStyle(c as HTMLElement);
    if (!style || style.display === "none" || style.visibility === "hidden")
      continue;
    const rect = (c as HTMLElement).getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    // If the candidate is a thin backdrop/wrapper, descend to the inner content surface.
    // Heuristic: prefer a descendant that has its own dialog role or is the largest focusable child.
    const innerDialog = c.querySelector(
      '[role="dialog"], [role="alertdialog"]',
    );
    if (innerDialog && innerDialog !== c) return innerDialog;
    return c;
  }
  return null;
}

export function scanInteractiveElements(
  root: ParentNode = document,
  win: Window & typeof globalThis = window,
  declaredSections: string[] = [],
): ScanResult {
  const doc: Document = (root as Document).defaultView
    ? (root as Document)
    : ((root as Element).ownerDocument ?? document);
  const openModal = findOpenModal(doc);

  const all = Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR));
  const seen = new Set<Element>();

  const uniqueVisible = all.filter((el) => {
    if (seen.has(el) || !isVisible(el, win)) return false;
    // Exclude the agent panel's own UI from the interactive elements list
    if (el.closest("[data-agent-panel]")) return false;
    // When a modal is open, only include elements inside it
    if (openModal && !openModal.contains(el)) return false;
    // Dedupe Switch / Radio / Checkbox wrappers (common pattern across MUI, Chakra,
    // Radix, Headless UI, etc.): if a button/label wraps a single checkbox/radio input,
    // hide the inner input (the wrapper has the human-readable label and our click handler
    // forwards clicks to the inner input automatically).
    if (
      el instanceof HTMLInputElement &&
      (el.type === "checkbox" || el.type === "radio") &&
      el.closest("button, label")
    ) {
      const wrapper = el.closest("button, label")!;
      // Only suppress if the wrapper is itself enumerated as interactive and contains ONLY this input
      const innerInputs = wrapper.querySelectorAll(
        'input[type="checkbox"], input[type="radio"]',
      );
      if (innerInputs.length === 1 && innerInputs[0] === el) {
        // Will be represented by the wrapper button/label instead
        return false;
      }
    }
    seen.add(el);
    return true;
  });

  const elementMap = new Map<number, Element>();
  const elements: PageElementSummary[] = uniqueVisible.map((el, i) => {
    const index = i + 1;
    elementMap.set(index, el);

    const { label, description } = describeElement(el);

    // Store the label on the element so action executors can read it back
    // at runtime (e.g. to enforce SECTION-only restrictions).
    try {
      (el as HTMLElement).setAttribute?.("data-agent-label", label);
    } catch {
      // Non-HTMLElement (e.g. SVG) — skip.
    }

    return {
      index,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      type: getType(el),
      label,
      description,
      kind: "interactive" as const,
    };
  });

  // SECTION PASS — non-interactive page landmarks (chart cards, widget panels, etc.)
  // so the LLM can target them via `scroll {index}`. Skipped while a modal is open
  // (user is focused on the dialog) and never includes anything inside the agent panel.
  if (!openModal) {
    const sectionSet = new Set<Element>();
    const sections: Array<{ el: Element; name: string }> = [];

    // 0) data-agent-section attributes — app developers can opt-in specific
    //     sections by adding data-agent-section="Section Name" to any element.
    //     These take priority over heuristic detection.
    root.querySelectorAll("[data-agent-section]").forEach((el) => {
      if (sectionSet.has(el)) return;
      if (el.closest("[data-agent-panel]")) return;
      if (!isVisible(el, win)) return;
      const name = el.getAttribute("data-agent-section")?.trim();
      if (!name || name.length < 3) return;
      sectionSet.add(el);
      sections.push({ el, name });
    });

    // Meaningful-word matching is Unicode/Arabic-aware (shared core/text helper).
    const declaredWordSets = declaredSections.map((d) => ({
      name: d,
      words: meaningfulWords(d),
    }));
    // Returns the declared section name a heading matches (all declared words present), else null.
    const matchDeclared = (headingText: string): string | null => {
      const hWords = new Set(meaningfulWords(headingText));
      for (const d of declaredWordSets) {
        if (d.words.length > 0 && d.words.every((w) => hWords.has(w)))
          return d.name;
      }
      return null;
    };

    const mainRootEarly =
      (root as Element).querySelector?.('main, [role="main"]') ??
      root.querySelector('main, [role="main"]') ??
      root;

    // 1) Declared sections by TITLE TEXT: section titles are often plain text
    //     (span / p / Typography), not <h*> headings, so the heading heuristic below
    //     would miss them. Because the developer explicitly declared these names in the
    //     agent config, trust them: find the title element whose OWN text matches a
    //     declared name, then surface its nearest card-like container as a SECTION.
    if (declaredWordSets.length > 0) {
      const ownText = (el: Element): string =>
        Array.from(el.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent ?? "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      const matchedDeclared = new Set<string>();
      const titleCandidates = (mainRootEarly as ParentNode).querySelectorAll(
        'h1, h2, h3, h4, h5, h6, span, strong, b, p, legend, figcaption, [class*="title" i]',
      );
      titleCandidates.forEach((el) => {
        if (el.closest("[data-agent-panel]")) return;
        const text = ownText(el);
        if (!text || text.length < 4 || text.length > 60) return;
        const declaredName = matchDeclared(text);
        if (!declaredName || matchedDeclared.has(declaredName)) return;
        if (!isVisible(el, win)) return;
        // Resolve the nearest card-like container (reasonably tall, not the whole page).
        let card: Element = el;
        let node: Element | null = el.parentElement;
        let hops = 0;
        const mainRect = (
          mainRootEarly as HTMLElement
        ).getBoundingClientRect?.();
        while (
          node &&
          node !== mainRootEarly &&
          node !== el.ownerDocument?.body &&
          hops < 5
        ) {
          const rect = (node as HTMLElement).getBoundingClientRect();
          const tooWide = mainRect ? rect.width > mainRect.width * 0.97 : false;
          if (rect.height >= 120 && !tooWide) {
            card = node;
            break;
          }
          node = node.parentElement;
          hops += 1;
        }
        if (sectionSet.has(card)) {
          matchedDeclared.add(declaredName);
          return;
        }
        if (card.closest("[data-agent-panel]")) return;
        sectionSet.add(card);
        sections.push({ el: card, name: declaredName });
        matchedDeclared.add(declaredName);
      });
    }

    // 2) Heuristic: any element under the main content area that carries a heading
    //    AND clearly represents a content widget (chart / table / list / region). The
    //    heuristic is framework-agnostic — it does not depend on any CSS-class naming.
    //
    //    A candidate is the OWN heading's immediate container that satisfies all of:
    //      - contains an h1..h6 (the section name)
    //      - is reasonably sized (rules out tiny KPI tiles)
    //      - contains a chart / table / list (rules out pure text or stat cards)
    //      - is NOT nested inside another already-selected section
    //      - the heading text is meaningful (not a pure number or a single generic word)
    const mainRoot = mainRootEarly;
    const headings = (mainRoot as ParentNode).querySelectorAll(
      "h1, h2, h3, h4, h5, h6",
    );
    const GENERIC_NAME =
      /^(total|amount|count|value|status|date|new|all|other|none|n\/a)$/i;
    headings.forEach((heading) => {
      if (heading.closest("[data-agent-panel]")) return;
      const name = heading.textContent?.replace(/\s+/g, " ").trim();
      if (!name || name.length < 4) return;
      if (!/\p{L}{2,}/u.test(name)) return;
      if (GENERIC_NAME.test(name)) return;
      // Declared sections were already surfaced (with relaxed criteria) in pass 1b.
      if (declaredWordSets.length > 0 && matchDeclared(name)) return;

      // Walk up to find the smallest container that "owns" this heading: it must
      // include the heading at shallow depth AND contain a chart/table/list also at
      // shallow depth. This avoids picking the whole page just because the page title
      // happens to be the first ancestor with any chart/table somewhere inside it.
      const SIBLING_CONTENT =
        ':scope > svg, :scope > canvas, :scope > table, :scope > ul, :scope > ol, :scope > [role="table"], :scope > [role="list"], :scope > [role="grid"], :scope > [role="feed"], :scope > * svg, :scope > * canvas, :scope > * table, :scope > * ul, :scope > * ol, :scope > * [role="table"], :scope > * [role="list"], :scope > * [role="grid"], :scope > * [role="feed"]';
      let container: Element | null = heading.parentElement;
      let chosen: Element | null = null;
      let hops = 0;
      while (
        container &&
        container !== mainRoot &&
        container !== heading.ownerDocument?.body &&
        hops < 4
      ) {
        // Heading must be near the top of this container (within first 3 children at any depth-1 position)
        const headingNearTop = Array.from(container.children)
          .slice(0, 3)
          .some((c) => c === heading || c.contains(heading));
        const hasSiblingContent = !!container.querySelector(SIBLING_CONTENT);
        if (headingNearTop && hasSiblingContent) {
          chosen = container;
          break;
        }
        container = container.parentElement;
        hops += 1;
      }
      if (!chosen) return;
      if (sectionSet.has(chosen)) return;
      if (chosen.closest("[data-agent-panel]")) return;
      // Avoid nesting: skip if an ancestor is already a chosen section.
      let parent: Element | null = chosen.parentElement;
      let nested = false;
      while (parent) {
        if (sectionSet.has(parent)) {
          nested = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (nested) return;
      if (!isVisible(chosen, win)) return;
      const rect = (chosen as HTMLElement).getBoundingClientRect();
      if (rect.width < 280 || rect.height < 160) return;
      // Reject page-level wrappers: anything wider than 95% of the main area OR taller
      // than 2x the viewport is almost certainly the page container, not a widget.
      const mainRect = (mainRoot as HTMLElement).getBoundingClientRect?.();
      if (
        mainRect &&
        rect.width > mainRect.width * 0.95 &&
        rect.height > win.innerHeight * 1.2
      )
        return;
      sectionSet.add(chosen);
      sections.push({ el: chosen, name });
    });

    sections.forEach(({ el, name }) => {
      const index = elements.length + 1;
      elementMap.set(index, el);
      elements.push({
        index,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        type: null,
        label: name,
        description: "Page section landmark. Use scroll with this index to focus it.",
        kind: "section" as const,
      });
    });
  }
  const text = JSON.stringify(elements, null, 2);

  console.debug("Scanned interactive elements:", {
    elements,
    elementMap,
    text,
  });
  return { elements, elementMap, text };
}
