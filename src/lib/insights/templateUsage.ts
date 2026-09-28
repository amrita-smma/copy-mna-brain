/**
 * "Used by 3 insights" / "Used by 1 insight" for a template's usage count, or
 * null when no live insight came from it (the library shows nothing then).
 * Shared by client and server — no server imports.
 */
export function formatTemplateUsage(count: number | null | undefined): string | null {
  if (!count || count < 1) return null;
  return `Used by ${count.toLocaleString('en-US')} ${count === 1 ? 'insight' : 'insights'}`;
}
