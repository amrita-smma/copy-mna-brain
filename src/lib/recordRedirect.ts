import { redirect } from 'next/navigation';
import { isUuid } from '@/lib/uuid';

/**
 * Gate for a page whose URL ends in a record id (`/companies/<id>`,
 * `/insight/<id>`, …). Records are workspace-scoped, so switching workspace —
 * which keeps the path and swaps only the slug — lands on an id that doesn't
 * exist in the new workspace. Instead of a "not found" screen, send the user
 * to the same URL without the id (`/w/<slug>/companies/<id>` →
 * `/w/<slug>/companies`).
 *
 * `exists` runs only for a well-formed UUID; anything else can't match a row
 * and would make Postgres reject the cast. Call it outside any try/catch —
 * `redirect` throws to do its job.
 */
export async function redirectUnlessRecordExists(
  id: string,
  exists: (id: string) => Promise<boolean>,
  fallbackPath: string,
): Promise<void> {
  if (isUuid(id) && (await exists(id))) return;
  redirect(fallbackPath);
}
