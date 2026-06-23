---
name: add-data-testid
description: Add data-testid attributes to React/HTML/TSX/JSX component files for test automation. Use this skill whenever the user wants to add test IDs, generate locators, improve test selectors, make elements testable, or prepare a component for automation. Trigger when the user says things like "add data-testid", "generate test ids", "add test locators", "make this testable", "add testids to this file", "I need selectors for this component", or when they share a component file and ask about testing or automation. Also trigger when the user mentions that their tests are brittle because they use getByText or need unique locators for duplicate elements.
---

# Add data-testid Attributes

Add `data-testid` attributes to React/HTML components to give test automation stable, meaningful locators — without touching anything that already has one.

---

## When to add a data-testid

The goal is to give automated tests reliable locators that don't break when text changes. Focus on elements where a test would struggle to find a unique, stable selector.

**Always add** `data-testid` to:
- Buttons and links (especially when multiple similar ones appear on the same page — "Save", "Cancel", "Delete" buttons are perfect candidates)
- Form inputs, selects, textareas, checkboxes, radio buttons that lack a field-identifying placeholder or aria-label (see skip rules below)
- Any element that would force a test to use `getByText()` — if the only way to find it is by its visible text, add a testid so future text changes don't break the test
- List items / cards / rows when multiple identical-looking elements exist in the same container
- Key structural sections that a test might need to scope into (modals, sidebars, toolbars, data tables)

**Skip** (leave untouched):
- Elements that already have `data-testid` — never modify or remove existing values
- Inputs that already have a placeholder that names the specific field — this is already a good locator for `getByPlaceholderText()`. The test is: does the placeholder tell you *which field this is*? Examples that qualify as field-identifying: `"Enter vendor name"`, `"you@company.com"`, `"Search invoices..."`, `"Enter your password"`. Examples that do NOT qualify (too generic): `"Enter text here"`, `"Type something..."`, `"..."`, empty string
- Inputs that already have a unique, descriptive `aria-label` — same reason
- Purely decorative or layout elements (wrappers, spacers) that a test would never target directly
- Static display-only spans/paragraphs carrying no interactivity and never targeted by tests
- Table data cells (`<td>`) and non-interactive row content — tests scope to the row via testid, then read cell content with text queries

The key judgment call: ask yourself "would a test author need to locate this element?" If yes and there's no stable unique attribute, add a testid.

---

## Naming convention

Use kebab-case. Build the name from context → element type → distinguishing detail:

```
{component-or-section}-{element-type}-{distinguishing-label}
```

Examples:
- `login-form-submit-button`
- `user-table-row-actions-dropdown`
- `invoice-filter-status-select`
- `confirm-dialog-cancel-button`
- `product-card-add-to-cart-button`

Rules:
- All lowercase, hyphens only (no underscores, no spaces)
- Use the element's visible label or purpose as the distinguishing part — `save-button` is weak; `create-invoice-save-button` is strong
- For list items, include an index only if there's genuinely no other distinguishing text (e.g., `step-list-item-0`). If each item has unique text or an ID, use that instead.
- Avoid generic names like `button-1`, `input-2` — they're fragile and unhelpful

---

## Workflow

### Step 1 — Read the file

Read the target file(s) the user specified. If none specified, ask which file to process.

Parse the component to understand:
- The component name (from the filename or the function/class declaration)
- All interactive and structural elements
- Which elements already have `data-testid`, `placeholder`, or `aria-label`

### Step 2 — Audit: what needs a testid?

Go through every element and classify it:

| Element | Action |
|---|---|
| Has `data-testid` | Skip — leave it alone |
| Input with field-identifying placeholder (e.g. `"Enter vendor name"`) | Skip — already locatable via `getByPlaceholderText` |
| Input with generic/empty placeholder (e.g. `"Enter text..."`) | Add testid |
| Input with no placeholder | Add testid |
| Has unique, descriptive `aria-label` | Skip — already locatable |
| Button / link / interactive control | Add testid |
| Select/textarea without identifying placeholder/aria-label | Add testid |
| Duplicate element type in same container | Add testid (critical — `getByText` will fail here) |
| Modal / dialog / drawer root | Add testid |
| Table, list, or grid container | Add testid |
| `<td>` data cells | Skip — tests scope to row via testid, read content with text |
| Decorative wrapper div | Skip |

Pay special attention to **duplicates** — if you see two `<button>` elements or two `<a>` tags inside the same component or container, both need testids even if individually they seem obvious. These are the elements most likely to cause flaky `getByText` failures.

### Step 3 — Apply the changes

Edit the file in place. Add `data-testid` as the first attribute after the element name (or after any existing `key` prop in mapped lists), before other props. This keeps testids easy to spot during code review.

```jsx
// Before
<button onClick={handleSave} className="btn-primary">
  Save Invoice
</button>

// After
<button data-testid="invoice-form-save-button" onClick={handleSave} className="btn-primary">
  Save Invoice
</button>
```

For mapped lists, use the item's unique identifier in the testid rather than the array index when possible:

```jsx
// Prefer this (stable):
<tr data-testid={`invoice-table-row-${invoice.id}`}>

// Over this (fragile):
<tr data-testid={`invoice-table-row-${index}`}>
```

### Step 4 — Print a summary

After making all edits, print a concise summary:

```
Added data-testid to N elements:
  ✓ invoice-form-save-button       <button> "Save Invoice"
  ✓ invoice-form-cancel-button     <button> "Cancel"
  ✓ invoice-status-select          <select> (no placeholder)
  ✓ invoice-table                  <table>
  ✓ invoice-table-row-{id}         <tr> (mapped, 1 per row)

Skipped N elements (already have locators):
  — <input> placeholder="Enter vendor name"   (field-identifying placeholder)
  — <input> placeholder="Search invoices..."  (field-identifying placeholder)
  — <button> data-testid="delete-invoice-button" (existing testid)
  — 3 wrapper <div> elements (decorative)
```

This helps the user verify the changes and understand what was touched.

---

## Edge cases

**Conditional rendering**: If the same element appears in both branches of a ternary or `&&`, give each branch its own testid reflecting its state:
```jsx
{isLoading
  ? <button data-testid="submit-button-loading" disabled>Saving...</button>
  : <button data-testid="submit-button" onClick={handleSubmit}>Save</button>
}
```

**Compound components**: If a component renders children that are themselves interactive components (not raw HTML), add testids to the host element — don't try to pierce into child component internals.

**Reusable components**: If the file is a generic reusable component (e.g., `<Modal>`, `<Button>`, `<DataTable>`), the testid should come from a `data-testid` prop passed in from the parent, not hardcoded. In this case, thread through the prop:
```jsx
// Generic Button component — accept and forward testid
const Button = ({ children, onClick, 'data-testid': testId, ...props }) => (
  <button data-testid={testId} onClick={onClick} {...props}>
    {children}
  </button>
)
```
And note this in your summary instead of hardcoding a value.
