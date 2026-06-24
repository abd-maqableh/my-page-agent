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

// ─── Static system prompts (cacheable across steps) ─────────────────────────
// Imported from markdown files for readability and easy editing.
import NAVIGATION_PROMPT from './prompts/navigation_prompt.md?raw'
import INTERACTION_PROMPT from './prompts/interaction_prompt.md?raw'

// ─── Phase 1 — Navigation prompt ────────────────────────────────────────────

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
  conversationHistory?: ChatMessage[],
): ChatMessage[] {
  const pagePaths = formatPagePaths(pages);

  // ── Dynamic content ────────────────────────────────────────────────────
  const dynamicBlocks: string[] = [];

  if (currentUrl) {
    dynamicBlocks.push(
      `Current page already loaded: "${currentUrl}"`,
      `If the task can be done on this page, navigate to "${currentUrl}" (stay on it).`,
      `Only navigate to a DIFFERENT page if the task explicitly requires opening another page.`,
    );
  }

  if (conversationHistory && conversationHistory.length > 0) {
    dynamicBlocks.push(
      "=== RECENT CONVERSATION (use for context) ===",
      ...conversationHistory.slice(-8).map((m) => `  (${m.role}) ${m.content}`),
      "=== END OF RECENT CONVERSATION ===",
    );
  }

  dynamicBlocks.push(pagePaths);

  const userContent = [
    `Task: ${task}`,
    "",
    `Which page should be opened? Return the navigate action now.`,
    dynamicBlocks.join("\n"),
  ].join("\n");

  return [
    { role: "system", content: NAVIGATION_PROMPT },
    { role: "user", content: userContent },
  ];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
 *
 * Returns [system, user] messages — the system message is static and cacheable.
 */
export function buildInteractionPrompt(
  task: string,
  observation: PageObservation,
  pages?: PagesMap,
  completedSteps: AgentHistoryEntry[] = [],
  conversationHistory?: ChatMessage[],
  enableQAMode?: boolean,
  /** Reflection memory carried forward from the previous step. */
  carriedMemory?: string,
): ChatMessage[] {
  const pagePaths =
    pages && Object.keys(pages).length > 0 ? formatPagePaths(pages) : "";
  const domRaw = observation.elementsText || "(none)";

  // ── Dynamic user content ───────────────────────────────────────────────
  const dynamicBlocks: string[] = [];

  dynamicBlocks.push(
    `Current page title: ${observation.title}`,
    `Current page url: ${observation.url}`,
  );

  if (carriedMemory) {
    dynamicBlocks.push(
      "",
      "=== YOUR MEMORY FROM PREVIOUS STEP ===",
      carriedMemory,
      "=== END OF MEMORY ===",
      "",
    );
  }

  dynamicBlocks.push(
    "--- PAGE ELEMENTS ---",
    domRaw,
    "--- END OF PAGE ELEMENTS ---",
  );

  const filterMap = buildFilterMap(observation.elements);
  if (filterMap) {
    dynamicBlocks.push(filterMap);
  }

  if (pagePaths) {
    dynamicBlocks.push("Known page paths:", pagePaths);
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
    dynamicBlocks.push(
      "Steps already completed (do NOT repeat):",
      stepsText,
    );
  }

  if (conversationHistory && conversationHistory.length > 0) {
    const tail = conversationHistory.slice(-16);
    const lines = tail.map((m) => `  (${m.role}) ${m.content}`);
    dynamicBlocks.push(
      "=== CONVERSATION HISTORY ===",
      ...lines,
      "=== END ===",
    );
  }

  if (enableQAMode) {
    dynamicBlocks.push(
      "=== Q&A MODE ===",
      "You may answer freeform questions about page content by returning a single `done` with your answer in `result`.",
      "Do NOT invent click/select/scroll actions — just look at the elements and answer.",
    );
  }

  const maxIndex = observation.elements.length;
  const userContent = [
    `Task: ${task}`,
    `Page: ${observation.title} (${observation.url})`,
    `Interactive elements on this page: 1 – ${maxIndex}.`,
    "",
    ...dynamicBlocks,
    "",
    "Return the JSON action queue now.",
  ].join("\n");

  return [
    { role: "system", content: INTERACTION_PROMPT },
    { role: "user", content: userContent },
  ];
}

/** @deprecated use buildInteractionPrompt. Kept for backward compatibility. */
export const buildPrompt = buildInteractionPrompt;
