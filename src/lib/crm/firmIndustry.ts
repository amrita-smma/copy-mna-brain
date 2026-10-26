/**
 * The closed set of labels the firm-industry classifier may write to
 * `employers.industry`.
 *
 * Closed because the CRM's Industry column sorts and filters on the lower-cased
 * value: free text would split one industry across "Private Equity", "PE" and
 * "Private equity firm". Most firms in a banker CRM are financial or advisory
 * firms, so those are split finely; operating companies get one broad sector.
 * A human can still type anything in the edit dialog — that goes to the
 * workspace's curation overlay and wins over this label.
 */
export const FIRM_INDUSTRIES = [
  // Banks and capital providers
  'Investment Banking',
  'Commercial Banking',
  'Private Banking & Wealth Management',
  'Private Equity',
  'Private Credit',
  'Venture Capital',
  'Asset Management',
  'Hedge Fund',
  'Family Office',
  'Sovereign Wealth & Pension Fund',
  'Insurance',
  'Real Estate Investment',
  // Advisers
  'Audit & Accounting',
  'Management Consulting',
  'Legal',
  'Technical & Engineering Consulting',
  'Financial Data & Research',
  // Operating companies
  'Technology',
  'Telecom & Media',
  'Healthcare',
  'Consumer & Retail',
  'Industrials & Manufacturing',
  'Energy & Resources',
  'Infrastructure & Utilities',
  'Transport & Logistics',
  'Real Estate & Property',
  'Government & Public Sector',
] as const;

export type FirmIndustry = (typeof FIRM_INDUSTRIES)[number];

const BY_LOWER = new Map(FIRM_INDUSTRIES.map((label) => [label.toLowerCase(), label]));

/** The canonical label for `raw` (case-insensitive), or null when it is not one. */
export function toFirmIndustry(raw: string | null | undefined): FirmIndustry | null {
  if (!raw) return null;
  return BY_LOWER.get(raw.trim().toLowerCase()) ?? null;
}
