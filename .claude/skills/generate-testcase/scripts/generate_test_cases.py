#!/usr/bin/env python3
"""Generate a QA test-case .xlsx that matches the company Test Case template.

Usage:
    python3 generate_test_cases.py cases.json "output.xlsx" [--sheet "Sheet Name"]

Input JSON shape:
{
  "sheet": "Land Management",            # optional, overridden by --sheet
  "cases": [
    {
      "module": "Land Management",
      "test_case_id": "ML-1384-01",
      "scenario": "System auto-generate Land ID Number for PA",
      "case": "System auto-assigns a Land ID when ...",
      "steps": ["1. Login ...", "2. Create a PA ...", "..."],   # list OR a "\n"-joined string
      "expected": ["1. ...", "2. ..."],                          # list OR a "\n"-joined string
      "test_type": "Positive",        # Positive | Negative
      "status": "To-do",              # default To-do
      "automation": false,             # boolean, default False
      "platform": "FE",               # FE | BE | Both
      "bug_link": ""                  # default blank
    }
  ]
}

Only "scenario"/"case"/"steps"/"expected" are really required per row; the rest
have template defaults.
"""
import argparse
import json
import sys

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

# --- Template constants (extracted from "Test Case - Template.xlsx") ---
HEADERS = [
    "Module", "Test Case ID", "Scenario ", "Case", "Step", "Expected Result",
    "Locator", "Actual Result", "Test Type", "Status ", "Automation", "Platform", "Bug link",
]
COL_WIDTHS = [12.0, 12.14, 20.57, 28.29, 36.43, 41.14, 20.0, 16.0, 14.43, 10.0, 14.43, 10.0, 14.0]
HEADER_FILL = "FF002060"          # navy
HEADER_FONT = Font(name="Arial", size=9, bold=True, color="FFFFFFFF")
DATA_FONT = Font(name="Arial", size=10)
WRAP_TOP = Alignment(wrap_text=True, vertical="top")
WRAP_CENTER = Alignment(wrap_text=True, vertical="center")
# Columns (1-based) that are centre-aligned: Test Type(9), Status(10), Automation(11), Platform(12)
CENTER_COLS = {9, 10, 11, 12}


def as_multiline(value):
    """Accept a list of lines or an already-joined string; return a string."""
    if isinstance(value, list):
        return "\n".join(str(v) for v in value)
    return "" if value is None else str(value)


def build(cases, sheet_name):
    wb = Workbook()
    ws = wb.active
    ws.title = sheet_name

    # Column widths
    for idx, width in enumerate(COL_WIDTHS, start=1):
        ws.column_dimensions[get_column_letter(idx)].width = width

    # Header row
    header_fill = PatternFill(fill_type="solid", fgColor=HEADER_FILL)
    for col, title in enumerate(HEADERS, start=1):
        c = ws.cell(row=1, column=col, value=title)
        c.font = HEADER_FONT
        c.fill = header_fill
        c.alignment = WRAP_TOP

    # Data rows
    for r, case in enumerate(cases, start=2):
        automation = case.get("automation", False)
        if isinstance(automation, str):
            automation = automation.strip().lower() in ("true", "1", "yes")
        values = [
            case.get("module", ""),
            case.get("test_case_id", ""),
            case.get("scenario", ""),
            case.get("case", ""),
            as_multiline(case.get("steps", "")),
            as_multiline(case.get("expected", "")),
            case.get("locator", ""),
            case.get("actual_result", ""),
            case.get("test_type", ""),
            case.get("status", "To-do"),
            bool(automation),
            case.get("platform", ""),
            case.get("bug_link", ""),
        ]
        for col, val in enumerate(values, start=1):
            c = ws.cell(row=r, column=col, value=val)
            c.font = DATA_FONT
            c.alignment = WRAP_CENTER if col in CENTER_COLS else WRAP_TOP

    return wb


def main():
    ap = argparse.ArgumentParser(description="Generate test-case xlsx from template.")
    ap.add_argument("input_json", help="Path to cases JSON file")
    ap.add_argument("output_xlsx", help="Path to output .xlsx")
    ap.add_argument("--sheet", default=None, help="Worksheet name (overrides JSON 'sheet')")
    args = ap.parse_args()

    with open(args.input_json, "r", encoding="utf-8") as f:
        data = json.load(f)

    cases = data.get("cases", data if isinstance(data, list) else [])
    if not cases:
        sys.exit("No 'cases' found in input JSON.")

    sheet_name = args.sheet or data.get("sheet") or "Test Cases"
    sheet_name = sheet_name[:31]  # Excel sheet-name limit

    wb = build(cases, sheet_name)
    wb.save(args.output_xlsx)
    print(f"Wrote {len(cases)} test case(s) to {args.output_xlsx} (sheet: {sheet_name})")


if __name__ == "__main__":
    main()
