import { DEFAULT_RETURN_PATH, safeReturnPath } from '@/lib/meetingIntelligence/returnTo';

export { DEFAULT_RETURN_PATH, safeReturnPath };

/** The query param the Connected apps tab reads to toast the outcome. */
export const RESULT_PARAM = 'gmail';

/** `returnTo` on `origin` with the outcome (`connected` / `error`) appended. */
export function resultUrl(
  origin: string,
  returnTo: string,
  outcome: 'connected' | 'error',
  reason?: string,
): URL {
  const url = new URL(safeReturnPath(returnTo), origin);
  if (url.origin !== origin) return new URL(DEFAULT_RETURN_PATH, origin);
  url.searchParams.set(RESULT_PARAM, outcome);
  if (reason) url.searchParams.set(`${RESULT_PARAM}Reason`, reason.slice(0, 200));
  return url;
}
