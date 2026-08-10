/**
 * Canonical Smart Files category tabs. Path segments under
 * `/smart-files/<tab>` use these exact values (e.g. `/smart-files/mom`,
 * `/smart-files/shopping_list`).
 */
export const SMART_FILES_TABS = [
  'mom',
  'prospectus',
  'shopping_list',
  'banker_communications',
  'fund_updates',
  'market_study',
  'other',
] as const;

export type SmartFilesTab = (typeof SMART_FILES_TABS)[number];

export function isSmartFilesTab(value: string): value is SmartFilesTab {
  return (SMART_FILES_TABS as readonly string[]).includes(value);
}
