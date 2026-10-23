/**
 * Contact display-name rules shared by email ingest (in-batch dedupe in
 * `data-pipeline/src/handlers/emailProcessCrm.ts`) and the correspondent
 * upsert (`CorrespondentRepository.upsertBatch`, which mirrors the same rule
 * in SQL). Keep the two in step.
 */

/**
 * A name is "address-like" when it carries no real name: it is empty after
 * trimming, contains an `@`, or equals the contact's email (case-insensitive).
 */
export function isAddressLikeName(
  name: string | null | undefined,
  email: string | null | undefined,
): boolean {
  const n = (name ?? '').trim();
  if (!n) return true;
  if (n.includes('@')) return true;
  const e = (email ?? '').trim().toLowerCase();
  return e !== '' && n.toLowerCase() === e;
}

/**
 * Picks the name to keep when the same contact is seen twice. A real name
 * always beats an address-like one; between two real names the existing
 * (first-seen) one is kept; between two address-like names the existing one
 * is kept unless it is empty.
 */
export function pickBetterContactName(
  existing: string | null | undefined,
  incoming: string | null | undefined,
  email: string,
): string {
  const existingTrimmed = (existing ?? '').trim();
  const incomingTrimmed = (incoming ?? '').trim();
  if (existingTrimmed && !isAddressLikeName(existingTrimmed, email)) {
    return existingTrimmed;
  }
  if (incomingTrimmed && !isAddressLikeName(incomingTrimmed, email)) {
    return incomingTrimmed;
  }
  return existingTrimmed || incomingTrimmed || email;
}
