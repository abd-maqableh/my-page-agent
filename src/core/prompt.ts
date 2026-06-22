import type {
  AgentHistoryEntry,
  ChatMessage,
  PageDescriptor,
  PageElementSummary,
  PageObservation,
} from "./types";

type PagesMap = Record<string, string | PageDescriptor>;

function formatPagePaths(pages: PagesMap, indent = "  "): string {
  const lines: string[] = [];
  const walk = (map: PagesMap, pad: string) => {
    for (const [label, value] of Object.entries(map)) {
      if (typeof value === "string") {
        lines.push(`${pad}${label}  (url: "${value}")`);
        continue;
      }
      lines.push(`${pad}${label}  (url: "${value.path}")`);
      if (value.sections && value.sections.length > 0) {
        lines.push(
          `${pad}  sections: ${value.sections.map((s) => `"${s}"`).join(", ")}`,
        );
      }
      if (value.subPages && Object.keys(value.subPages).length > 0) {
        walk(value.subPages, `${pad}  `);
      }
    }
  };
  walk(pages, indent);
  return lines.join("\n");
}
/**
 * Phase 1 — Navigation prompt.
 * No DOM is provided. The LLM only sees the task + available pages and must
 * return a SINGLE `navigate` action (plus `done`). This is deliberately
 * minimal so the model cannot be confused by stale page elements.
 */
export function buildNavigationPrompt(
  task: string,
  pages: PagesMap,
  currentUrl = "",
): ChatMessage[] {
  const pagePaths = formatPagePaths(pages);

  const system = [
    ...(currentUrl
      ? [
          `Current page already loaded: "${currentUrl}"`,
          `If the task can be done on this page, navigate to "${currentUrl}" (stay on it).`,
          `Only navigate to a DIFFERENT page if the task explicitly requires opening another page.`,
          "",
        ]
      : []),
    "You are a browser navigation agent.",
    "This is PHASE 1 of a two-phase task execution.",
    "",
    "IFRAME CONTEXT — you operate inside an iframe:",
    "  - All DOM interaction happens within the iframe's document.",
    "  - Never attempt to access or control the parent window.",
    "  - The current URL shown above is the iframe URL, not the parent.",
    "",
    "Your ONLY job in this phase is to decide WHICH page to open for the given task.",
    "Always respond in the same language as the user's task.",
    "Return exactly one `navigate` action followed by `done`.",
    "",
    "IMPORTANT — DO NOT guess or invent any element interactions.",
    "After you return the navigate action, the system will:",
    "  1. Load the correct page in the browser.",
    "  2. Call you again (PHASE 2) with the full live DOM of that page.",
    "  3. At that point you will have real element indexes, labels, and descriptions.",
    "Your ONLY output now is: navigate to the right page, then done.",
    "",
    "Available actions:",
    '- navigate: {"url": string}',
    '- done: {"result": string}',
    "",
    "Return ONLY this JSON shape:",
    '{"thought":"short reason","actions":[{"action":"navigate","args":{"url":"..."}},{"action":"done","args":{"result":"Navigating to <page>"}}]}',
    "",
    "Known pages — copy the url value EXACTLY as written, do not modify it.",
    "Each page may list its named sections. If the task mentions a section by name, navigate to the page that declares it.",
    pagePaths,
  ].join("\n");

  const user = `Task: ${task}\n\nWhich page should be opened? Return the navigate action now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Build a "value → dropdown index" lookup table from the scanned elements
 *  so the LLM doesn't need to parse JSON to find which dropdown has which
 *  option. This makes dropdown selection reliable even for small models. */
function buildFilterMap(elements: PageElementSummary[]): string {
  const lines: string[] = [];
  for (const el of elements) {
    if (el.role !== "combobox" || el.kind !== "interactive") continue;
    const desc = el.description || "";
    const optsMatch = desc.match(/Available options:\s*([^.]+)/i);
    if (!optsMatch) continue;
    const options = optsMatch[1]
      .split(/,\s*/)
      .map((o) => o.trim())
      .filter(Boolean);
    for (const opt of options) {
      lines.push(`  "${opt}" → index ${el.index} (${el.label})`);
    }
  }
  if (lines.length === 0) return "";
  return [
    "FILTER VALUE → DROPDOWN LOOKUP (use this table — do NOT guess):",
    ...lines,
  ].join("\n");
}

/**
 * Phase 2 — Interaction prompt.
 * The target page is already loaded. DOM elements are provided so the LLM can
 * pick filters, click buttons, scroll to sections, etc.
 * `completedSteps` carries what the agent already did so the LLM does not
 * repeat finished work and can pick up exactly where it left off.
 */
export function buildInteractionPrompt(
  task: string,
  observation: PageObservation,
  pages?: PagesMap,
  completedSteps: AgentHistoryEntry[] = [],
): ChatMessage[] {
  const pagePaths =
    pages && Object.keys(pages).length > 0 ? formatPagePaths(pages) : "";
  // const domElementsJson = JSON.stringify(observation.elements, null, 2);
  const domRaw = observation.elementsText || "(none)";

  const dynamicSystemBlocks: string[] = [
    `Current page title: ${observation.title}`,
    `Current page url: ${observation.url}`,
    "--- PAGE ELEMENTS (these describe the page — do NOT echo them back) ---",
    domRaw,
    "--- END OF PAGE ELEMENTS ---",
    "",
    "You must now generate an ACTION JSON object, not page data.",
    'The format is: {"thought":"...","actions":[{"action":"...","args":{...}},{"action":"done",...}]}',
  ];

  const filterMap = buildFilterMap(observation.elements);
  if (filterMap) {
    dynamicSystemBlocks.push(filterMap);
  }

  if (pagePaths) {
    dynamicSystemBlocks.push("Known page paths (for navigate):", pagePaths);
  }

  if (completedSteps.length > 0) {
    const stepsText = completedSteps
      .map(
        (s) =>
          `  Step ${s.step}: [${s.action.action}] ${JSON.stringify(s.action.args ?? {})} → ${
            s.result.success ? "OK" : "FAILED"
          }: ${s.result.message}`,
      )
      .join("\n");
    dynamicSystemBlocks.push(
      "Steps already completed in this task (do NOT repeat them):",
      stepsText,
    );
  }

  const system = [
    "You are a browser page agent.",
    "This is PHASE 2 of a two-phase task execution.",
    "The correct page has already been navigated to and is now fully loaded.",
    "You are receiving a fresh DOM scan of the live page — use only the element indexes listed below.",
    "Your job is to interact with the page elements to fulfil the task.",
    "Always respond in the same language as the user's task.",
    "",
    "IFRAME CONTEXT — you operate inside an iframe:",
    "  - All element indexes refer to elements within the iframe document ONLY.",
    "  - Never attempt to interact with or control the parent window.",
    "  - The page URL shown below is the iframe URL, not the parent.",
    "",
    "You are given DOM elements as structured JSON with: index, tag, role, type, label, kind, and description.",
    "The `kind` field is either `interactive` (buttons, inputs, dropdowns…) or `section` (chart cards, widget panels, named page regions).",
    "Inspect labels and descriptions to decide the best actions.",
    "",
    "FILTER-FIRST RULE — ALWAYS check this BEFORE section scrolling:",
    "  If the page has combobox/dropdown elements AND the task mentions specific values",
    "  (e.g. 'Mining License', 'rejected', 'approved', status names, type names):",
    "    1. The task is asking you to APPLY FILTERS, not to scroll to a section.",
    "    2. Use `select` on the matching comboboxes to pick the requested values.",
    "    3. Follow with `done` describing which filters were applied.",
    "    4. Do NOT use `scroll` — filters change what data is shown; scrolling does not.",
    "  Words like 'show me', 'display', 'view' in a task that also names filter values",
    "  (status, type, category) are filter requests — NOT section-scroll requests.",
    "",
    "SECTION SCROLLING — only when NO filter values are mentioned:",
    "  Sections are page landmarks (chart cards, widgets, panels) declared in the page config.",
    "  If the task asks to scroll to a declared section AND no filter values appear in the task:",
    "    1. Find the element with kind='section' whose label best matches the requested section name.",
    '    2. Use `scroll: {"index": <that index>}` to bring it into view.',
    "    3. Follow with `done`.",
    "  If the page has filter dropdowns and the task mentions specific values → use `select`, NOT scroll.",
    "",
    "SECTION RULE: Elements labelled \"SECTION: ...\" are scroll landmarks ONLY.",
    "  You CANNOT click, input, select, clear, or hover them.",
    '  Use scroll {"index": <section_index>, "direction": "down"} to bring them into view.',
    "Available actions and REQUIRED args (every listed arg is mandatory unless marked ?):",
    '- click: {"index": number}  // buttons, links, tabs, checkboxes only — do NOT use before input or select',
    '- input: {"index": number, "text": string}',
    "  ↳ Types text into a text field or search box.",
    "  ↳ WARNING: Do NOT use click before input. input focuses the field itself.",
    '  ↳ CORRECT:   [{"action":"input","args":{"index":2,"text":"WHAT USER WANT"}},{"action":"done",...}]',
    '  ↳ WRONG:     [{"action":"click","args":{"index":3}},{"action":"input","args":{"index":2,...}}]',
    '- select: {"index": number, "value": string}  ' +
      "// Use for ALL dropdowns and comboboxes. Handles open → pick → close automatically. " +
      "Do NOT use click to open a dropdown first — select does the entire sequence in one step.",
    '- clear: {"index": number}',
    '- press_key: {"key": string, "index"?: number}',
    '- hover: {"index": number}',
    '- scroll: {"direction": "up"|"down", "amount": number} OR {"index": number}',
    '- wait: {"timeoutMs": number}',
    '- navigate: {"url": string}',
    '- done: {"result": string}',
    "HOW TO PICK THE RIGHT ELEMENT (apply this reasoning for every action):",
    "  For dropdowns/comboboxes:",
    "    1. Split the task into INDIVIDUAL filter values. ",
    "    2. For EACH value, scan ALL comboboxes and find the ONE whose options list",
    "       contains that exact value (case-insensitive). Match values independently —",
    "       a single dropdown CANNOT satisfy two different values unless both appear in its options.",
    "    3. If a value is NOT found in any dropdown's options, skip it — do not force it.",
    "    4. Use `select` action. NEVER use `input` or `click` on a combobox.",
    "    5. Include all select actions AND `done` in a SINGLE batch.",
    "  For text inputs:",
    "    1. Find the element with tag=input or a description mentioning 'text field' / 'search'.",
    "    2. Use `input` action directly. NEVER use `click` before `input`.",
    "  For buttons/links/tabs/checkboxes:",
    "    1. Match the element label to the task intent.",
    "    2. Use `click` action.",
    "",
    "BATCHING: When you are confident about multiple sequential actions (e.g. select a filter,",
    "then select another filter, then call done), return them ALL in a single JSON array:",
    '[{"action":"select","args":{"index":3,"value":"Active"}},',
    ' {"action":"select","args":{"index":5,"value":"Mining"}},',
    ' {"action":"done","args":{"result":"Filters applied"}}]',
    "Only batch actions you are certain about. If uncertain, return a single action.",
    "",
    "ITERATIVE EXECUTION: The system will re-scan the page DOM after executing your actions and call you again if the task is not yet done.",
    "Return the NEXT batch of actions needed. You may batch multiple actions that are safe to run sequentially (e.g. applying several filter dropdowns).",
    "",
    "BATCH DONE RULE — CRITICAL:",
    "  If your batch of select/input actions will COMPLETE the task, you MUST include `done`",
    "  as the LAST action in this SAME batch. Do NOT expect another call.",
    "  Example: applying both 'filter value A' and 'filter value B':",
    '  [select filter value A, select filter value B, done: "Applied both filters"]',
    "  The system may NOT call you again after this batch executes — if you omit `done`",
    "  the task may stay incomplete.",
    "",
    "RETRY RULE: If your previous action FAILED (marked ✗ FAILED in history),",
    "  you MUST try a completely different action or index.",
    "  Repeating the same failed action is forbidden.",
    "",
    "DONE RULE A: Only call `done` when the GOAL stated in the task has been fully achieved,",
    "  not just when a single action was taken.",
    "DONE RULE B: If the task says \"fill and submit\", you MUST perform BOTH the fill AND the submit",
    "  before calling `done`.",
    "DONE RULE C: If you just clicked a submit button, wait for a success message or page change",
    "  to appear in the next observation before calling `done`.",
    "DONE RULE D: If the page still shows an unfilled required field (marked `required` in the elements),",
    "  do NOT call `done`.",
    "",
    "DATE FORMAT RULE: For any element labelled \"DATE INPUT (format: X)\", the \"text\" arg",
    "  MUST match format X exactly. Examples:",
    "  format MM/DD/YYYY → \"06/15/2024\", format DD-MM-YYYY → \"15-06-2024\",",
    "  format YYYY-MM-DD → \"2024-06-15\". Never use a different separator or order.",
    "",
    "MODAL CLOSE RULE: If [MODAL] elements are visible but none help complete the task,",
    "  look for a [MODAL] close button (labelled \"Close\", \"✕\", \"Cancel\", \"Dismiss\") and click it",
    "  before interacting with the background page.",
    "MODAL INTERACTION RULE: When a modal is open, ONLY interact with elements prefixed with [MODAL].",
    "  Elements without [MODAL] prefix are behind the overlay and cannot be interacted with.",
    "",
    "Return `done` when the ENTIRE task is complete — not before.",
    "OUTPUT: Respond with ONLY the JSON object. Start your response with { and end with }.",
    "No preamble. No explanation. No markdown. No code fences. No comments.",
    "Return ONLY one JSON object in this exact shape:",
    '{"thought":"What has already been done (from completed steps), what remains, and which DOM elements handle the next actions.","actions":[',
    '  {"action":"input","args":{"index":1,"text":"<search text>"}},',
    '  {"action":"select","args":{"index":2,"value":"<option value>"}},',
    '  {"action":"done","args":{"result":"<summary of what was done>"}}',
    "]}",
    "Rules:",
    "- Use only indexes that exist in the provided DOM list.",
    "- Return actions in queue order.",
    "- For dropdowns: the 'Available options' field is the ground truth. Pick the element whose options contain the requested value — NOT the one whose label sounds most similar.",
    "- NEVER use `input` on a combobox (role=combobox) — use `select` only.",
    "- If the task only required navigation (no further interaction needed), return only done.",
    "- If the request is impossible on this page, return only done with an explanation.",
    "- NEVER use `navigate` to apply filters, search, or sorting — the page is already open.",
    "NAVIGATE STRICT RULE: The \"url\" arg for `navigate` MUST be copied EXACTLY from",
    "  the KNOWN PAGE PATHS listed above. Do not invent, shorten, or modify paths.",
    "  If no path matches the user's intent, use scroll or click instead.",
    "- For any filter dropdown, combobox, or select element: ALWAYS use `select` (never `click`).",
    "  `select` opens the dropdown, picks the matching option, and closes it automatically.",
    "  Only use `click` for buttons, links, tabs, checkboxes, and radio controls.",
    "  Always use the filter controls visible in the DOM (combobox, select, input).",
    "  `navigate` is forbidden in this phase unless the task explicitly asks to open a completely different page.",
    "- The `input` action ALWAYS requires both `index` AND `text`. Never omit `index`.",
    "  Do NOT precede `input` with a `click` — `input` focuses the field automatically.",
    "- To type into any text/search input: use `input` ONLY. Never use `click` to focus it first.",
    "  input handles focus internally. click + input = wrong.",
    "- The `done` action MUST be the last item inside the `actions` array, never a top-level key.",
    "Before picking actions, check the completed steps above — do NOT redo anything already done successfully.",
    "Identify what REMAINS to do. Return the next batch of actions for those remaining sub-goals.",
    "Return ONLY one JSON object:",
    '{"thought":"what was done, what remains, next actions","actions":[...next actions...,{"action":"done","args":{"result":"..."}}]}',
    "Only include `done` when the full task is finished.",
    "",
    "Runtime context (changes every request):",
    ...dynamicSystemBlocks,
  ].join("\n");

  const maxIndex = observation.elements.length;
  const user = [
    `Task: ${task}`,
    `Page: ${observation.title} (${observation.url})`,
    `There are ${maxIndex} interactive element(s) on this page. Valid indexes: 1 – ${maxIndex}.`,
    `Return the JSON action queue now.`,
  ].join("\n\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** @deprecated use buildInteractionPrompt. Kept for backward compatibility. */
export const buildPrompt = buildInteractionPrompt;
