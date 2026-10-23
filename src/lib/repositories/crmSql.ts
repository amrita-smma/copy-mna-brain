import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * Shared pieces of the CRM repositories' raw SQL. Not re-exported from the
 * repositories barrel: only those repositories use it.
 *
 * The app's `DbClient` is node-postgres, so a raw `db.execute` returns
 * `{ rows }` with text[] as arrays, json as objects and booleans as booleans;
 * timestamps and bigint counts arrive as text.
 */

/**
 * A timestamp as ISO 8601, or null. Raw `execute` returns Postgres text
 * (`2026-10-17 08:00:00.123456+00`), which Safari's Date cannot parse, so the
 * client always gets the ISO form — never the raw string.
 */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A count / bigint column as a number (0 when null or unparseable). */
export function toCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** `$1, $2, …` for an `IN (…)` / `VALUES` list. Callers guard the empty list. */
export function sqlList(values: readonly string[]): SQL {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

/**
 * The email is in the workspace: its custodian mailbox belongs to a member.
 * Exact match on `custodian_email`, as the `email_workspace` view and its
 * index do.
 */
export function emailInWorkspace(custodianEmail: SQLWrapper, workspaceId: string): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM "public"."users" cu
    JOIN "public"."user_workspaces" cuw ON cuw.user_id = cu.id
    WHERE cu.email = ${custodianEmail}
      AND cuw.workspace_id = ${workspaceId}
  )`;
}

/**
 * Email notes are private to the people on the email: the viewer is on its
 * From/To/Cc, or it was synced from their own mailbox (Bcc and list mail reach
 * a custodian who is not on the header).
 */
export function viewerCanSeeEmail(
  emailId: SQLWrapper,
  custodianEmail: SQLWrapper,
  viewerUserId: string,
): SQL {
  return sql`(EXISTS (
    SELECT 1 FROM "analytics"."email_participants" vp
    WHERE vp.email_id = ${emailId} AND vp.user_id = ${viewerUserId}
  ) OR EXISTS (
    SELECT 1 FROM "public"."users" vu
    WHERE vu.id = ${viewerUserId} AND lower(vu.email) = lower(${custodianEmail})
  ))`;
}
