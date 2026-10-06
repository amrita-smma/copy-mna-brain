/** A deal's origin: introduced to us (inbound) or originated by us (outbound). */
export type SourceType = 'inbound' | 'outbound';

/**
 * What the Pipeline page's source picker is set to: one source type, or both
 * at once (`all`).
 */
export type SourceFilter = 'all' | SourceType;

/**
 * Resolve a stored `companies.source` value to a source type, tolerating case
 * and surrounding whitespace. Anything else (null, blank, unknown) is null.
 */
export function normalizeSourceType(
  source: string | null | undefined,
): SourceType | null {
  const value = source?.trim().toLowerCase();
  return value === 'inbound' || value === 'outbound' ? value : null;
}

/** Display label for a stored source value: "Inbound", "Outbound", or null. */
export function sourceTypeLabel(
  source: string | null | undefined,
): string | null {
  const type = normalizeSourceType(source);
  if (type === 'inbound') return 'Inbound';
  if (type === 'outbound') return 'Outbound';
  return null;
}

/**
 * Whether a deal belongs under the given source filter. `all` keeps every
 * deal, including ones with no recognised source.
 */
export function matchesSourceFilter(
  company: { source: string | null },
  filter: SourceFilter,
): boolean {
  return filter === 'all' || normalizeSourceType(company.source) === filter;
}
