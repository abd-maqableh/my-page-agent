---
name: agent-friendly-markup
description: How to write JSX/HTML markup so the page-agent DOM scanner detects, labels, and controls every element perfectly. Use when building or reviewing UI components (pages, filters, tables, forms, modals, menus) for any app that embeds @abd-maqableh/page-agent.
---

# Agent-Friendly Markup

The page-agent scans the live DOM and converts it into a numbered list of labeled elements (e.g. `[7] input[role=combobox] "FILTER DROPDOWN: Region (current: All)"`). The LLM only sees those labels — **if the scanner can't name an element, the agent can't use it.** Follow these rules when writing JSX/HTML.

## 1. What the scanner picks up (interactivity)

Only these are detected as interactive:

- Native: `button`, `a[href]`, `input`, `textarea`, `select`, `summary`
- ARIA roles: `button`, `link`, `textbox`, `searchbox`, `combobox`, `menuitem(checkbox/radio)`, `option`, `tab`, `switch`, `checkbox`, `radio`, `slider`, `spinbutton`, `treeitem`
- `[contenteditable]`, `[onclick]`, `[tabindex]` (not `-1`)

**Rules**

- Never make a clickable `<div>`/`<span>` without `role="button"` (or use a real `<button>`). A bare `onClick` div with no role/tabindex is invisible to the agent.
- Hidden elements are skipped: `display:none`, `visibility:hidden`, zero size, `pointer-events:none`, or any ancestor with `aria-hidden="true"` / `inert`. Don't fake-hide interactive controls with opacity tricks while expecting the agent to use them.
- Links must have a real `href`. `<a>` without `href` is not detected.

## 2. How elements get their names (labeling priority)

For every element, the scanner resolves a label in this order:

1. `aria-label`
2. `aria-labelledby` (text of referenced elements)
3. `title`
4. Associated `<label>` (`label[for=id]`, `el.labels`, or a wrapping `<label>`)
5. `placeholder`, then `name` (inputs only)
6. Visible `textContent`
7. **Field-name fallback for dropdowns**: a `<label>`/form-label found in up to 4 ancestor levels (the MUI `FormControl` pattern)

**Rules**

- Every form control MUST have a resolvable name. Best: a real `<label htmlFor={id}>` or `aria-label`.
- Icon-only buttons MUST carry `aria-label` (e.g. `<IconButton aria-label="Delete row">`). Otherwise they degrade to `"Per-item actions menu (…)"` or `"button element"`.
- Labels can be in ANY language — the matcher is Unicode/Arabic-aware. Keep them human-readable; the agent matches user words against them.

## 3. Dropdowns / filters → `FILTER DROPDOWN: <field> (current: <value>)`

Detected as a filter dropdown:

- Native `<select>` — also lists `[options: ...]` automatically. **Preferred when possible.**
- `role="combobox"` on any element
- An `<input>` with `role="combobox"`, `aria-haspopup="listbox"`, or `aria-autocomplete` (MUI Autocomplete, react-select, downshift)

**Rules**

- The **field name** (Region / Status / الفئة...) must be discoverable: use `label[for]`, a wrapping `<label>`, `aria-label`, or a `<label>`/`*FormLabel*` element within 4 ancestor levels. Without it the agent only sees the current value ("All") and can't tell which filter is which.

```jsx
// ✅ Field name resolvable — scanner emits: FILTER DROPDOWN: Region (current: All) [options: All, Northern, ...]
<FormControl>
  <FormLabel htmlFor="region">Region</FormLabel>
  <Select id="region" value={region}>…</Select>
</FormControl>

// ❌ No label anywhere — scanner emits: FILTER DROPDOWN: All  (which filter is this?)
<Select value={region} renderValue={(v) => v} />
```

- Custom dropdown options must use `role="option"` inside a `role="listbox"` container (MUI/Radix/Headless UI do this). The agent's `select` action opens the combobox, waits for `[role="listbox"]`, and clicks the matching `[role="option"]`. If your popup uses plain divs, the select action fails.
- For autocomplete-style comboboxes that filter options by typed text: keep the input a real `<input>` — the agent retypes the value to reveal hidden options.
- Search inputs: use `type="search"`, `role="searchbox"`, or include "search/filter/find" in the placeholder/label → labeled `SEARCH BOX:`, which the agent uses for free-text queries.

## 4. Sections / widgets → `SECTION: <name>`

Sections are scrollable landmarks ("show me the monthly trend chart").

**Best (explicit, always works):**

```jsx
<Card data-agent-section="Approval Trends by Entity">…</Card>
```

**Also declare sections in the agent config** (`pages: { Dashboard: { path: '/dashboard', sections: ['Approval Trends by Entity'] } }`) — declared names get relaxed matching: the scanner finds the title text (`span`/`p`/`Typography`, not just headings) and surfaces the nearest card container.

**Heuristic fallback** (when neither is provided) — a widget is auto-detected only if ALL hold:

- It contains an `<h1>`–`<h6>` heading near its top (first 3 children)
- The heading text is ≥4 chars, has ≥2 letters, and is not generic ("Total", "Status", "All"...)
- The container holds a chart/table/list (`svg`, `canvas`, `table`, `ul/ol`, or `role="table|list|grid|feed"`)
- It's reasonably sized (≥280×160 px) and not a page-wide wrapper

**Rules**

- Wrap each dashboard widget in its own container with a real heading element (`<h3>{title}</h3>`, or MUI `<Typography variant="h6" component="h3">`). A `<span className="title">` alone is only found for *declared* sections.
- Put page content inside `<main>` (or `role="main"`); the section pass scopes to it.

## 5. Tabs, toggles, menus, items

| Pattern | Required markup | Scanner label |
|---|---|---|
| Tab | `role="tab"` (+ `aria-selected`) | `TAB: <name> (active)` |
| Switch | `role="switch"` + `aria-checked`, or a `<label>`/`<button>` wrapping a single checkbox | `TOGGLE: <name> (checked/unchecked)` |
| Checkbox/Radio | native input or `role="checkbox"/"radio"` + `aria-checked` | `CHECKBOX:`/`RADIO:` + state |
| Context menu items | `role="menuitem"` | `MENU ITEM: <name>` — the agent auto-clicks these after opening a row menu |
| Row/card action button (⋯) | put the button inside `li`/`tr`/`article` or a container with role `listitem`/`row` or a class containing `card/item/row/tile/cell`, with an `h1–h6`/`strong` title inside | `Per-item actions menu (<item title>)` |

**Rules**

- Row "⋯" buttons: ensure the row/card has a title element (`<strong>`, `<h4>`...) so the agent can target "the menu of REQ-2026-001" specifically.
- Dropdown menus opened from those buttons must render items with `role="menuitem"` (MUI `<Menu>`/`<MenuItem>` is fine).

## 6. Forms, validation, dates

- Submit: use `<button type="submit">` → labeled `SUBMIT BUTTON:`.
- Required: `required` or `aria-required="true"` → shows `(required)`.
- Errors: `aria-invalid="true"` + `aria-errormessage="<id>"` (or `aria-describedby`) pointing at the error text → shows `(invalid: <message>)`, letting the agent self-correct.
- Disabled/readonly: `disabled` / `aria-disabled="true"` / `readOnly` → shows `(disabled)`/`(readonly)`; the agent will not touch them.
- Date pickers: native `type="date"` is ideal. Masked text inputs MUST keep a format placeholder like `MM/DD/YYYY` → labeled `DATE PICKER: <name> (format: MM/DD/YYYY)` and the agent formats values correctly.

## 7. Modals & drawers

Detected via (in priority): `<dialog open>`, `role="dialog"`/`"alertdialog"`, `aria-modal="true"`, or a class containing `modal|dialog|drawer|overlay|sheet`.

**Rules**

- Always set `role="dialog"` + `aria-modal="true"` on custom modals, and give them a heading (`<h2>`) or `aria-label` — it becomes `MODAL OPEN: "<title>"`.
- While a modal is open the agent ONLY sees elements inside it — don't render the modal's action buttons outside the dialog element (portals are fine; detached footers are not).
- Non-blocking popups (toasts, tooltips, popovers, menus) must NOT carry modal-ish class names, or the agent will get trapped focusing them. Keywords `popover|menu|tooltip|snackbar|toast|notification` are excluded automatically.

## 8. State attributes the agent reads

Add these whenever applicable — they're appended to labels and drive agent decisions:

`aria-expanded` → `(expanded/collapsed)` · `aria-pressed` → `(pressed)` · `aria-current` → `(current)` · `aria-checked` → `(checked/unchecked)` · `aria-selected` (tabs) → `(active)` · `disabled`/`aria-disabled` → `(disabled)`

## 9. Navigation integration (agent config, not markup)

Pass every route the agent should reach in the `pages` config — paths not listed are treated as 404s by the agent:

```ts
new MyPageAgent({
  pages: {
    Dashboard:   { path: '/dashboard', sections: ['Approval Trends by Entity'] },
    Applications:'/applications',
    'الطلبات':   '/applications',   // add labels in every UI language
  },
})
```

Declare labels in **all languages users will type** — the matcher normalizes Arabic (diacritics, أ/إ/آ→ا, ة→ه, ى→ي, "ال" prefix) and English plurals automatically.

## 10. Quick checklist

- [ ] Every clickable thing is a `button`/`a[href]` or has a proper `role`
- [ ] Every input/select/combobox has a resolvable field name (label/aria-label)
- [ ] Icon-only buttons have `aria-label`
- [ ] Custom dropdowns use `role="combobox"` + `role="listbox"` + `role="option"`
- [ ] Widgets have `data-agent-section` or a top heading + chart/table/list inside
- [ ] Modals use `role="dialog"` + `aria-modal="true"` + a title
- [ ] Tabs/switches/menus use proper ARIA roles and state attributes
- [ ] Validation states exposed via `aria-invalid` + `aria-errormessage`
- [ ] All routes and section names declared in the agent `pages` config, in every UI language
