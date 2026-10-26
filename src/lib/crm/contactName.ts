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

/**
 * Local-part words that name a mailbox, not a person (`legal@`, `deal.team@`).
 * Mirrored in `20261026000001_derive_contact_names_from_email.sql`.
 */
export const GENERIC_MAILBOX_WORDS: ReadonlySet<string> = new Set([
  'account', 'accounts', 'admin', 'alerts', 'assistant', 'billing', 'bounce',
  'careers', 'compliance', 'contact', 'deal', 'deals', 'desk', 'enquiries',
  'enquiry', 'events', 'finance', 'group', 'hello', 'help', 'hr', 'info',
  'inquiries', 'investor', 'investors', 'invest', 'ir', 'jobs', 'kyc', 'legal',
  'mail', 'marketing', 'media', 'news', 'newsletter', 'no', 'noreply',
  'notifications', 'office', 'operations', 'ops', 'postmaster', 'press',
  'project', 'proposal', 'proposals', 'reception', 'relations', 'reply',
  'research', 'sales', 'secretary', 'service', 'services', 'support', 'team',
  'webmaster',
]);

/** `first.last`, `first_last` or `first-middle-last`: 2–3 alphabetic words of 2+ letters. */
const PERSON_LOCAL_PART = /^[a-z]{2,}(?:[._-][a-z]{2,}){1,2}$/;

/**
 * A display name spelled out of an address shaped like a person's —
 * `matthieu.simoncini@firm.com` → "Matthieu Simoncini" — or null when the
 * local part is a single word, has digits, or names a mailbox
 * ({@link GENERIC_MAILBOX_WORDS}). A `+tag` is ignored.
 *
 * Only ever a fallback for a contact whose name is still its address: it is
 * written by `CorrespondentRepository.fillAddressLikeNames`, which never
 * touches a real name, and a real name seen later replaces it.
 */
export function nameFromEmailLocalPart(email: string | null | undefined): string | null {
  const local = (email ?? '').trim().toLowerCase().split('@')[0]?.split('+')[0] ?? '';
  if (!PERSON_LOCAL_PART.test(local)) return null;
  const words = local.split(/[._-]/);
  if (words.some((w) => GENERIC_MAILBOX_WORDS.has(w))) return null;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
