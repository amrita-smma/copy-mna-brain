/**
 * Canonical AI File Dump category tabs. Path segments under
 * `/ai-file-dump/<tab>` use these exact values (e.g. `/ai-file-dump/mom`,
 * `/ai-file-dump/shopping_list`).
 */
export const AI_FILE_DUMP_TABS = [
  'mom',
  'prospectus',
  'shopping_list',
  'banker_communications',
  'fund_updates',
  'market_study',
  'other',
] as const;

export type AiFileDumpTab = (typeof AI_FILE_DUMP_TABS)[number];

export function isAiFileDumpTab(value: string): value is AiFileDumpTab {
  return (AI_FILE_DUMP_TABS as readonly string[]).includes(value);
}
