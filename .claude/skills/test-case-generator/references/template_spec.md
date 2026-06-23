# Test Case Template Spec

Exact structure and formatting of the company Test Case template. The bundled
sample `assets/Test Case - Template.xlsx` is the source of truth; this file
documents it so generated sheets are indistinguishable from hand-written ones.

## Columns (A–M, in order)

| Col | Header (exact)   | Content | Default | Alignment |
|-----|------------------|---------|---------|-----------|
| A   | `Module`         | Feature/area name, repeated on every row | — | wrap, top |
| B   | `Test Case ID`   | `{TICKET}-{NN}` e.g. `ML-1384-01` | — | wrap, top |
| C   | `Scenario ` (trailing space) | One-line title of what's verified | — | wrap, top |
| D   | `Case`           | 1–3 sentence behaviour description, with concrete example | — | wrap, top |
| E   | `Step`           | Numbered steps, one per line (`\n`) | — | wrap, top |
| F   | `Expected Result`| Numbered expected outcomes, one per line | — | wrap, top |
| G   | `Locator`        | Filled by automation team; always blank when generated | blank | wrap, top |
| H   | `Actual Result`  | Filled by tester at execution | blank | wrap, top |
| I   | `Test Type`      | `Positive` or `Negative` | — | wrap, center |
| J   | `Status ` (trailing space) | `To-do` (new) or `Pass` (verified) | `To-do` | wrap, center |
| K   | `Automation`     | boolean | `False` | wrap, center |
| L   | `Platform`       | `FE`, `BE`, or `Both` | — | wrap, center |
| M   | `Bug link`       | Bug URL if any | blank | wrap, top |

Note the trailing spaces in the `Scenario ` and `Status ` headers — they are
part of the template; the generator reproduces them.

## Formatting

- **Header row (row 1):** fill `002060` (navy, solid), font Arial 9 bold white,
  wrap text, vertical top.
- **Data rows:** font Arial 10, wrap text. Text columns (A–H, M) are vertical
  **top**; I/J/K/L (Test Type, Status, Automation, Platform) are vertical
  **center**.
- **Column widths:** A 12.0, B 12.14, C 20.57, D 28.29, E 36.43, F 41.14,
  G 20.0, H 16.0, I 14.43, J 10.0, K 14.43, L 10.0, M 14.0.
- Row heights auto-fit to wrapped content (left to Excel; not set explicitly).

## Conventions

- **Test Case ID:** two-digit running number per ticket, restarting at `01` for
  each ticket. Example: `ML-1384-01`, `ML-1384-02`, ...
- **Steps:** begin at the entry point (login / open screen) and end with
  explicit `Verify:` steps. Setup goes in a `Pre-requisite:` line before step 1.
- **Expected Result** items map one-to-one to the `Verify:` steps where
  practical.
- **Automation** is `False` for all newly written cases unless the user says a
  case is automated.

## Generator JSON input

```json
{
  "sheet": "Land Management",
  "cases": [
    {
      "module": "Land Management",
      "test_case_id": "ML-1384-01",
      "scenario": "System auto-generate Land ID Number for PA",
      "case": "System auto-assigns a Land ID when the user generates the PA draft, using the format {Site ID}-{Land ID} (e.g., GRB-0001)",
      "steps": [
        "1. Login to the Mining Legal website",
        "2. Create a PA flow with a valid site (e.g., Site ID = GRB)",
        "3. Click 'Generate PA Draft'",
        "4. Verify: a Land ID is automatically assigned",
        "5. Verify: format is {Site ID}-{Land ID} (e.g., GRB-0001)"
      ],
      "expected": [
        "1. System assigns a Land ID on PA draft generation",
        "2. Land ID format is {Site ID}-{Land ID} (e.g., GRB-0001)"
      ],
      "test_type": "Positive",
      "status": "To-do",
      "automation": false,
      "platform": "FE",
      "locator": "",
      "bug_link": ""
    }
  ]
}
```

`steps` and `expected` accept either a list of lines (joined with newlines) or a
single pre-joined string. Per-row fields other than `scenario`, `case`,
`steps`, and `expected` fall back to the defaults above.
