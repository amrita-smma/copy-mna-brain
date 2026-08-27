/**
 * Where a single company lives in the app.
 *
 * `/companies/<id>` renders `CompanyDetail` — the same view as
 * `/pipeline/<dealId>`, which reads that company as a deal in the funnel. Both
 * segments are the company id. Links about a *company* (chat mentions, search
 * results) belong here; `/pipeline/<id>` stays for navigation that is genuinely
 * about the deal's pipeline position, and existing links to it keep working.
 *
 * Every company mention routes through this one helper so they can't disagree
 * on the destination.
 */
export function companyDetailPath(companyId: string): string {
  return `/companies/${encodeURIComponent(companyId)}`;
}

/** A company-shaped value that may or may not carry a linkable id. */
export interface CompanyRef {
  id?: string | null;
  target?: string | null;
  name?: string | null;
  project_name?: string | null;
}

/**
 * The company id to link to, or `null` when there is nothing to link.
 *
 * Company mentions reach the chat from several places — a resolved pipeline row,
 * a file's `matched_companies` (whose entries are sometimes bare name strings),
 * or a name the model produced for a company that isn't in the pipeline at all.
 * Only the first kind can be linked; the rest must stay inert rather than
 * pointing at `/pipeline/undefined`.
 */
export function companyLinkId(company: unknown): string | null {
  if (!company || typeof company !== 'object') return null;
  const id = (company as CompanyRef).id;
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
}
