// Canonical company-name normalizer, shared by the CRM service (manual related
// companies) and the data-pipeline auto-extraction matcher. Lives in the app
// (`@/lib`) because data-pipeline can import from the app, but not vice-versa
// (the app's test runner can't resolve data-pipeline package subpaths). Keep
// this the single source of truth so manual and auto rows normalize identically
// — divergence would silently produce duplicate related-company rows.

const LEGAL_SUFFIX_RE =
  /\s+(inc\.?|corp\.?|ltd\.?|llc\.?|co\.?|plc\.?|pte\.?|tbk\.?|pt\.?)$/i;

export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(LEGAL_SUFFIX_RE, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
