/**
 * Re-add every `job_type` value the schema knows to the live enum.
 *
 * Why this exists: `scripts/migrate.ts` applies every pending app migration
 * first and every pending pipeline migration second, and one pipeline
 * migration (`data-pipeline/migrations/20260724130200_drop_legacy_email_pipeline.sql`)
 * drops and recreates `public.job_type` from a fixed list of seven values. On
 * a database built from scratch — a fresh local stack, a reset preview branch,
 * any new environment — that rebuild therefore runs *after* the app's later
 * migrations and silently discards every value they added, while their
 * `__drizzle_migrations` rows stay recorded (so re-running migrate does not
 * help). The symptom is `invalid input value for enum job_type: "…"` on the
 * first job of that type.
 *
 * Applied migrations are never edited, so the repair is this step: after both
 * folders have run, add whatever `src/lib/db/schema.ts` lists and the database
 * lacks. `ADD VALUE IF NOT EXISTS` is idempotent and, run outside a
 * transaction, immediately usable. A no-op on a healthy database.
 */
import { jobType } from '../src/lib/db/schema';

/** The two statements this needs from a postgres.js client. */
export interface EnumSqlClient {
  unsafe(query: string): Promise<unknown>;
}

/** An enum label we are willing to splice into DDL (no parameters in ALTER TYPE). */
const LABEL = /^[a-z][a-z0-9_]*$/;

export const JOB_TYPE_LABELS_SQL = `select e.enumlabel as label
from pg_enum e
join pg_type t on t.oid = e.enumtypid
join pg_namespace n on n.oid = t.typnamespace
where n.nspname = 'public' and t.typname = 'job_type'`;

export function addJobTypeValueSql(value: string): string {
  if (!LABEL.test(value)) throw new Error(`Refusing to add job_type value ${JSON.stringify(value)}: not a plain label`);
  return `ALTER TYPE public.job_type ADD VALUE IF NOT EXISTS '${value}'`;
}

/**
 * Adds the schema's `job_type` values the database is missing, in schema
 * order. Returns the values it added.
 */
export async function reconcileJobTypeEnum(
  client: EnumSqlClient,
  values: readonly string[] = jobType.enumValues,
): Promise<string[]> {
  const rows = (await client.unsafe(JOB_TYPE_LABELS_SQL)) as { label: string }[];
  const present = new Set(rows.map((r) => r.label));
  const missing = values.filter((v) => !present.has(v));
  for (const value of missing) {
    await client.unsafe(addJobTypeValueSql(value));
  }
  return missing;
}
