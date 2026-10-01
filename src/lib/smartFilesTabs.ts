/**
 * Canonical Smart Files category tabs. Path segments under
 * `/smart-files/<tab>` use these exact values (e.g. `/smart-files/mom`,
 * `/smart-files/shopping_list`).
 *
 * Every value except `other` is also a `files.file_type` value — `other` is
 * the catch-all bucket for NULL and for any classifier output without its own
 * tab, so it must stay last.
 */
export const SMART_FILES_TABS = [
  'mom',
  'prospectus',
  'shopping_list',
  'banker_communications',
  'fund_updates',
  'market_study',
  'financial_statement',
  'bond_issuance',
  'other',
] as const;

export type SmartFilesTab = (typeof SMART_FILES_TABS)[number];

/** Tab labels shown in the Smart Files tab bar. */
export const SMART_FILES_TAB_LABELS: Record<SmartFilesTab, string> = {
  mom: 'MoM',
  prospectus: 'Prospectus',
  shopping_list: 'Shopping Lists',
  banker_communications: 'Banker Communications',
  fund_updates: 'Fund Updates',
  market_study: 'Market Study',
  financial_statement: 'Financial Statements',
  bond_issuance: 'Bond Issuances',
  other: 'Other',
};

/**
 * `file_type` values with a dedicated tab. The `other` tab is the inverse of
 * this set (plus NULL), so listing and counting both derive from it rather
 * than keeping their own copies.
 */
export const DEDICATED_FILE_TYPES: readonly Exclude<SmartFilesTab, 'other'>[] =
  SMART_FILES_TABS.filter((tab) => tab !== 'other') as Exclude<SmartFilesTab, 'other'>[];

export function isSmartFilesTab(value: string): value is SmartFilesTab {
  return (SMART_FILES_TABS as readonly string[]).includes(value);
}

/**
 * Categories a user may force on a file at upload time, overriding the
 * classifier. `banker_communications` is deliberately absent — that bucket is
 * driven by the CSV/MBOX shape of an email export rather than being something
 * a reviewer picks for an arbitrary document.
 */
export type SmartFilesUploadCategory = Exclude<SmartFilesTab, 'banker_communications'>;

export const SMART_FILES_UPLOAD_CATEGORIES: readonly SmartFilesUploadCategory[] =
  SMART_FILES_TABS.filter(
    (tab) => tab !== 'banker_communications',
  ) as SmartFilesUploadCategory[];
