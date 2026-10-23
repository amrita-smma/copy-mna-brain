/**
 * Sortable columns of the CRM Firms list (`GET /api/crm`, `EmployerRepository.list`).
 * Kept free of server imports so the CRM view can share the keys.
 */
const EMPLOYER_LIST_SORTS = [
  'name',
  'industry',
  'primary_pic',
  'response_p50',
  'last_contact',
  'emails',
  'team_members',
] as const;

export type EmployerListSort = (typeof EMPLOYER_LIST_SORTS)[number];

export type SortDirection = 'asc' | 'desc';

export const DEFAULT_EMPLOYER_LIST_SORT: EmployerListSort = 'last_contact';

/**
 * Direction a column starts in when first clicked: text and response time read
 * best ascending (A→Z, fastest first); dates and counts read best descending.
 */
export const EMPLOYER_LIST_SORT_DEFAULT_DIR: Record<EmployerListSort, SortDirection> = {
  name: 'asc',
  industry: 'asc',
  primary_pic: 'asc',
  response_p50: 'asc',
  last_contact: 'desc',
  emails: 'desc',
  team_members: 'desc',
};

/**
 * Parse `sort` / `dir` query params. An unknown sort falls back to the default
 * (latest contact first); a missing or unknown dir takes the column's default.
 */
export function parseEmployerListSort(
  sort: string | null,
  dir: string | null,
): { sort: EmployerListSort; dir: SortDirection } {
  const key = (EMPLOYER_LIST_SORTS as readonly string[]).includes(sort ?? '')
    ? (sort as EmployerListSort)
    : DEFAULT_EMPLOYER_LIST_SORT;
  const direction =
    dir === 'asc' || dir === 'desc' ? dir : EMPLOYER_LIST_SORT_DEFAULT_DIR[key];
  return { sort: key, dir: direction };
}
