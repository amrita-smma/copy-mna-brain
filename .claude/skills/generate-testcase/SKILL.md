---
name: generate-testcase
description: >-
  Generate a structured QA test case spreadsheet (.xlsx) from a product
  requirement source — a PRD Word document (.docx), a Confluence page, a Figma
  design/file, an HTML page, or a live/existing web application the user lets
  you log into and explore. Use this skill whenever the user wants to
  "create test cases", "write test cases", "generate a test case sheet", "make a
  QA test sheet", "turn this PRD/spec/design into test cases", or asks for test
  scenarios for a feature, even if they don't mention a spreadsheet explicitly.
  Trigger it for any request that turns a requirement, ticket, spec, or design
  into test cases — including Mining Legal / FMS-style test sheets. The output
  matches the bundled Test Case template exactly (columns, navy header, fonts,
  wrapping, numbered steps).
---

# Test Case Generator

This skill turns a requirement source into a QA test case spreadsheet that
matches a specific company template. The point is consistency: testers should
not be able to tell whether a sheet was written by hand or generated, so every
column, fill colour, font, and step-numbering convention must match the
bundled template.

Work in two phases that must not be mixed: **(1) gather and understand the
requirement, then (2) write test cases and build the .xlsx.** Don't open the
generator script or think about Excel mechanics until you actually understand
the feature — anchoring on the spreadsheet too early produces shallow,
generic test cases that don't reflect the real requirement.

## Phase 1 — Get the requirement content

Identify the source type from what the user gives you and pull the full text /
design intent before writing anything.

**PRD Word document (.docx)** — Read it. If it's attached, read it directly; the
`docx` skill can help for complex extraction. Capture: feature name, scope,
business rules, ID/number formats, triggers ("when does X happen"), edge cases,
explicit acceptance criteria, and any linked ticket numbers (e.g. ML-1012).

**HTML file or page** — Read the file, or fetch the URL with web_fetch. If the
fetch returns an empty shell / "enable JavaScript", the page is client-rendered;
switch to the Claude in Chrome tools (`navigate` then `get_page_text`).

**Confluence page** — Use the connected Atlassian connector when available
(search tools for `atlassian` / `confluence`). Fetch the page by URL or by
space + title and read its body. If the connector isn't connected, ask the user
to connect it or paste the page content / export it as Word or HTML, then
proceed file-based. Don't guess at content you can't see.

**Figma design or file** — Use the connected Figma connector when available
(search tools for `figma`). Pull the file/node and read frame names, text
layers, flows, and component states — these tell you the screens, fields,
buttons, and states to cover. If the connector isn't connected, ask the user to
connect it or share screenshots / a written flow description. Treat each screen,
field, validation, and interactive state as a candidate for one or more cases.

**Existing / live web application** — When the user gives you access to a
running site (and credentials), explore it with the Claude in Chrome tools to
derive test cases from real behaviour. Workflow:

1. `navigate` to the login page, use `form_input` / `computer` to enter the
   credentials **the user supplies at runtime**, and log in.
2. Walk the relevant feature: open each screen, read it with `get_page_text` /
   `read_page`, list the fields, buttons, filters, and states, and exercise the
   main flow end-to-end (create, edit, submit, cancel) where it's safe to do so.
3. For each screen/field/action, capture the observed behaviour, validation
   messages, formats (e.g. an ID shown as `GRB-0001`), and any error states.
4. Turn those into test cases with concrete steps matching what you actually
   did in the UI.

Two cautions that matter for quality:

- **Credentials are runtime-only.** Never write them into the skill, the JSON
  spec, the steps, or any saved file. Use them to log in, then discard.
- **Observed behaviour ≠ intended behaviour.** A live site reflects what the
  app *currently does*, which can include bugs. When you only have the live
  site, write the expected results from observed behaviour but tell the user
  these describe current behaviour and should be validated against the real
  requirement. When you also have a PRD/Figma/Confluence source, cross-check:
  where the live app diverges from the spec, write the case's expected result
  to the **spec** and note the divergence (it's a likely bug, not a passing
  case). Be non-destructive — avoid actions that delete or corrupt real data
  unless the user confirms it's a test environment.

If the source is thin or ambiguous on a business rule that materially changes
the expected results (e.g. "is the running number 3 or 4 digits?"), ask one
focused question rather than inventing a rule. Inventing rules produces
confidently-wrong expected results, which is worse than asking.

## Phase 2 — Write the test cases

Aim for **balanced coverage**: for each distinct requirement or rule, generate
positive (happy-path), negative (invalid input, permission denied, read-only),
and edge/boundary cases (limits, empty states, max values, reuse/cancellation,
cross-entity independence). The bundled sample shows the target depth — e.g. a
single "Land ID" feature yields ~10 cases including a 9999 boundary case and a
read-only-for-all-roles negative case.

Each test case is one row with these fields:

- **Module** — the feature/area name. Repeated on every row (it's not blank on
  subsequent rows in this template).
- **Test Case ID** — `{TICKET}-{NN}`, two-digit running number per ticket,
  e.g. `ML-1384-01`, `ML-1384-02`. If there's no ticket, use a short feature
  code the user gives you (ask if unknown).
- **Scenario** — a short one-line title of what's being verified.
- **Case** — a one-to-three sentence description of the precise behaviour under
  test, including the rule and any concrete example (e.g. format `{Site ID}-{Land ID}`,
  `GRB-0001`).
- **Step** — numbered steps, one per line (`1.`, `2.`, ...). Start from login /
  entry point and end with explicit `Verify:` steps. Put any setup requirement
  on a `Pre-requisite:` line before step 1 (not numbered). Steps and expected
  results map one-to-one where practical.
- **Expected Result** — numbered outcomes, one per line, corresponding to the
  `Verify:` steps. Concrete and observable — not "it works" but "the Land ID
  field shows `GRB-0001`".
- **Locator** — leave blank for all generated cases. Filled in later by the
  automation team.
- **Test Type** — `Positive` for happy-path and valid-boundary cases;
  `Negative` for invalid input, permission-denied, read-only, and error-state
  cases.
- **Status** — always `To-do` for newly written cases.
- **Automation** — `False` for all new cases unless the user says otherwise.
- **Platform** — `FE` (UI-only), `BE` (API/backend-only), or `Both`.
- **Bug link** — leave blank; filled by testers at execution time.

## Phase 2 — Build the .xlsx

Once all test cases are drafted, convert them to the generator's JSON format
and run the script. Read `references/template_spec.md` for the exact JSON
shape and column-formatting rules before writing the JSON.

```bash
pip install openpyxl --break-system-packages --quiet
python3 scripts/generate_test_cases.py cases.json "output.xlsx" --sheet "Sheet Name"
```

Save `cases.json` to `/tmp/` and write the output `.xlsx` to
`/mnt/user-data/outputs/`. Then call `present_files` with the output path so
the user can download it.

### Quick checklist before running the script

- Every `test_case_id` follows `{TICKET}-{NN}` with a two-digit counter,
  restarting at `01` per ticket.
- `steps` and `expected` are lists of strings (the script also accepts a
  pre-joined string, but a list is cleaner).
- `test_type` is exactly `"Positive"` or `"Negative"` (case-sensitive).
- `platform` is exactly `"FE"`, `"BE"`, or `"Both"`.
- `status` is `"To-do"` for all new rows.
- `automation` is boolean `false`, not the string `"False"`.
- `locator` is omitted or `""` — always blank for generated cases.
- The sheet name matches the feature/module (≤31 chars, Excel limit).