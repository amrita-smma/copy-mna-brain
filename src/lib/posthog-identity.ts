/**
 * Who PostHog thinks the current user is.
 *
 * Identification deliberately does NOT happen on the login page. `identify()`
 * is a captured `$identify` event, and `before_send` drops everything captured
 * on `/login` (see `@/lib/posthog-events`) — so identifying there sent nothing.
 * It is instead driven off the resolved NextAuth session by
 * `PostHogIdentityTracker`, which only ever mounts on authenticated pages.
 *
 * The distinct id is the user's **UUID**, not their email: emails change (and
 * re-keying a person on a changed email splits their history in two), and an
 * email as the distinct id puts PII into every event's identity field.
 */

/**
 * Whether to stamp the user's email onto **every** event as a super property,
 * on top of the person property `identify` already sets.
 *
 * Interim measure while PostHog identities migrate from email-keyed to
 * UUID-keyed: it makes a user findable by raw event search without depending on
 * person profiles having merged correctly. The UUID needs no equivalent — it is
 * already the `distinct_id` on every event.
 *
 * **To stop sending emails, flip this to `false` — that is the whole removal.**
 * Don't just delete the `register` call: super properties persist in each
 * browser's localStorage, so a deleted call would leave every existing session
 * stamping email forever. `PostHogIdentityTracker` reads this flag and calls
 * `unregister` when it is off, which clears the stored value on next load.
 */
// Typed `boolean` rather than inferred as the literal `true`, so TypeScript
// doesn't narrow the off-branch into dead code that can't be typechecked or
// tested before the flip.
export const SEND_EMAIL_WITH_EVENTS: boolean = true;

/** Super property key for the email. Named so the `unregister` can't drift. */
export const EMAIL_SUPER_PROPERTY = 'email';

export interface IdentifiableUser {
  id: string;
  email?: string | null;
  name?: string | null;
}

/**
 * Person properties for `user`. Blank values are omitted rather than sent as
 * empty strings — `$set` overwrites, and an empty string would clobber a good
 * value already on the person.
 */
export function personPropertiesFor(user: IdentifiableUser): Record<string, string> {
  const properties: Record<string, string> = {};
  const email = user.email?.trim();
  const name = user.name?.trim();
  if (email) properties.email = email;
  if (name) properties.name = name;
  return properties;
}

/**
 * Whether `identify()` still needs to be called for `userId`.
 *
 * posthog-js ignores a repeat `identify()` with the same distinct id, but it
 * logs a warning when the id *changes* without an intervening `reset()`, so
 * we only call it when the id actually differs from what PostHog holds.
 */
export function needsIdentify(
  currentDistinctId: string | null | undefined,
  userId: string,
): boolean {
  return Boolean(userId) && currentDistinctId !== userId;
}

/**
 * Super properties to stamp on every event, or `null` when there is nothing to
 * register (email sending switched off, or the user has no usable email).
 *
 * A `null` return means "unregister", not "leave as-is" — see
 * `SEND_EMAIL_WITH_EVENTS` for why clearing matters.
 */
export function superPropertiesFor(
  user: IdentifiableUser,
  // Injected rather than read straight off the module constant so the
  // switched-off path is directly testable before it is switched off.
  sendEmail: boolean = SEND_EMAIL_WITH_EVENTS,
): Record<string, string> | null {
  if (!sendEmail) return null;
  const email = user.email?.trim();
  if (!email) return null;
  return { [EMAIL_SUPER_PROPERTY]: email };
}
