---
name: get-locator-from-e2e-to-sheet
description: >-
  Extract locators (data-testid, role, label, placeholder, etc.) from Playwright
  e2e test scripts and write them into the "Locator" column of a test case
  spreadsheet (.xlsx). Use this skill when the user wants to "fill in locators",
  "sync locators to the test sheet", "populate the Locator column from e2e
  tests", "get data-testid from automation scripts", or "update the test case
  sheet with locators". Also trigger when the user shares a spec file and a test
  sheet and asks to connect them, or says the Locator column is empty and should
  be filled.
---

# Get Locator from E2E to Sheet

Extract locators from Playwright automation scripts and write them into the
`Locator` column of a test case spreadsheet. The goal is a traceable link
between each test case row and the selector the automation test uses — so
testers and engineers can see at a glance what is covered and where.

Work in three phases: **(1) read and index the e2e scripts, (2) match locators
to test case rows, (3) write the updated sheet.**

---

## Phase 1 — Index locators from the e2e scripts

Read every Playwright spec file the user points to (default: `e2e/**/*.spec.ts`).
For each file, extract every locator call and the test case context it belongs to.

**Locator types to extract (in priority order):**

| Playwright call | Locator string to record |
|---|---|
| `getByTestId('foo')` | `data-testid=foo` |
| `getByRole('button', { name: 'Save' })` | `role=button[name="Save"]` |
| `getByLabel('Email')` | `label=Email` |
| `getByPlaceholder('Search...')` | `placeholder=Search...` |
| `getByText('Submit')` | `text=Submit` |
| `locator('#id')` or `.locator('.cls')` | the raw selector as-is |
| `locator('[data-testid="foo"]')` | `data-testid=foo` |

When a single test uses multiple locators, record all of them joined by `\n`
(one per line in the cell).

**Matching locators to test case IDs:**

Look for the test case ID in the spec file. Common patterns:

- A `test.describe` block named after the module or ticket (e.g. `ML-1384`)
- A comment directly above or inside a `test(...)` block (e.g. `// ML-1384-01`)
- A `test('ML-1384-01 ...', ...)` where the ID is part of the test name string
- An annotation: `test.info().annotations` or `test('...', { annotation: { type: 'testId', value: 'ML-1384-01' } }, ...)`

Build an index: `{ testCaseId → locator[] }`.

If a spec has no explicit test case ID references, do a best-effort match by
**scenario name similarity** — compare the `test(...)` name string against
the `Scenario` column of the sheet using fuzzy text matching. Warn the user
about any matches made this way (they need human verification).

---

## Phase 2 — Read the test case sheet

The sheet is a `.xlsx` file. Read it using Python + openpyxl:

```bash
pip install openpyxl --break-system-packages --quiet
python3 - <<'EOF'
import openpyxl, json, sys

path = sys.argv[1]
wb = openpyxl.load_workbook(path)
result = {}
for sheet_name in wb.sheetnames:
    ws = wb[sheet_name]
    headers = [cell.value for cell in ws[1]]
    result[sheet_name] = {"headers": headers, "rows": []}
    for row in ws.iter_rows(min_row=2, values_only=True):
        result[sheet_name]["rows"].append(list(row))
print(json.dumps(result))
EOF
```

Run the script with the sheet path as `sys.argv[1]` and capture the JSON.

**Locate the `Locator` column:**

- Search the header row (row 1) for a cell whose value equals `"Locator"` (case-insensitive).
- If found, note its 1-based column index.
- If NOT found, insert a new column immediately after the `Expected Result`
  column (or after the last data column if `Expected Result` is also absent).
  When inserting, shift all columns to the right by one. Add the header
  `"Locator"` with the same navy header formatting as the rest of row 1
  (fill `002060`, font Arial 9 bold white, wrap, vertical top) — see the
  formatting rules in `generate-testcase`'s `template_spec.md`.

**Locate the `Test Case ID` column** (column B in the standard template, but
verify against actual headers).

---

## Phase 3 — Write locators into the sheet

For each row in the sheet:

1. Read the `Test Case ID` cell value.
2. Look up that ID in the locator index from Phase 1.
3. If found and the existing `Locator` cell is blank — write the locator string(s).
4. If found and the `Locator` cell already has a value — compare against the
   locator(s) from the script. If the script has a different (new) locator,
   **overwrite** the cell with the script's value. If they are identical,
   leave it unchanged.
5. If not found — leave the cell unchanged. Report it in the summary.

After updating, save the workbook back to the same path (or a new path if
the user specified one).

```bash
pip install openpyxl --break-system-packages --quiet
python3 scripts/update_locators.py input.xlsx locator_map.json output.xlsx
```

Write `locator_map.json` to `/tmp/` and the updated sheet to
`/mnt/user-data/outputs/`. Then call `present_files` with the output path.

---

## Inserting the Locator column (when absent)

When the column does not exist, insert it with the correct formatting so the
sheet looks identical to a hand-edited one:

```python
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment

NAVY = "002060"
header_font = Font(name="Arial", size=9, bold=True, color="FFFFFF")
header_fill = PatternFill("solid", fgColor=NAVY)
header_align = Alignment(wrap_text=True, vertical="top")
data_align = Alignment(wrap_text=True, vertical="top")

# Insert column at position `col_idx` (1-based)
ws.insert_cols(col_idx)
header_cell = ws.cell(row=1, column=col_idx, value="Locator")
header_cell.font = header_font
header_cell.fill = header_fill
header_cell.alignment = header_align

# Set column width to 20.0 (matches template spec)
from openpyxl.utils import get_column_letter
ws.column_dimensions[get_column_letter(col_idx)].width = 20.0
```

Apply `data_align` to every data cell in the new column as rows are populated.

---

## Summary to deliver

After writing the sheet, print:

```
Locator column: column G (existing) / inserted at column G (new)
Rows updated:   23
Rows skipped (no match in e2e scripts): 4
  — ML-1384-07  (no test referencing this ID found)
  — ML-1384-11  (no test referencing this ID found)
  — ML-1385-03  (no test referencing this ID found)
  — ML-1386-01  (no test referencing this ID found)
Rows overwritten (Locator updated to new value): 2

Fuzzy-matched (needs human review):
  — ML-1384-09 matched test "verify save button disables on submit" (score 0.72)
```

---

## Edge cases

**Multiple sheets in the workbook** — process every sheet unless the user
specifies one. Report sheet-by-sheet in the summary.

**Multiple test case IDs per row** — the template uses one ID per row; if a
cell contains multiple IDs (comma-separated), look up each and union the
locator sets.

**Dynamic locators** (e.g. `` `data-testid="row-${id}"` ``) — record the
template form as-is: `data-testid=row-{id}`. Note it in the summary as
dynamic so the automation engineer can verify.

**Locators inside helper functions or page objects** — if a spec imports from
`e2e/helpers/` or `e2e/pages/`, read those files too and resolve the locator
calls transitively. Don't silently miss locators just because they're one
import away.

**Missing e2e file** — if the user didn't point to a spec and none exist in
`e2e/`, stop and ask:
> Which Playwright spec file(s) should I read to extract locators?
> If there are none yet, run `/write-e2e-tests` first.
