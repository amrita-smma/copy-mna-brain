import { eq, sql } from 'drizzle-orm';
import { appSettings, users } from '@/lib/db/schema';
import type { DbClient } from './types';

/** A settings row plus the resolved name/email of whoever last changed it. */
export interface AppSettingsRow<T> {
  value: T;
  updatedAt: string | null;
  updatedBy: { id: string; name: string | null; email: string | null } | null;
}

/**
 * Generic key/value settings store. Each key maps to one JSON blob. Callers own
 * the shape of the value they read/write; this repo is pure data access.
 */
export class AppSettingsRepository {
  constructor(private db: DbClient) {}

  /** Read the JSON value for a key, or `null` when the key is unset. */
  async get<T>(key: string): Promise<T | null> {
    const [row] = await this.db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .limit(1);
    return (row?.value ?? null) as T | null;
  }

  /** Read the value plus audit metadata (who changed it last, and when). */
  async getRow<T>(key: string): Promise<AppSettingsRow<T> | null> {
    const [row] = await this.db
      .select({
        value: appSettings.value,
        updatedAt: appSettings.updated_at,
        updatedById: appSettings.updated_by,
        updatedByName: users.name,
        updatedByEmail: users.email,
      })
      .from(appSettings)
      .leftJoin(users, eq(users.id, appSettings.updated_by))
      .where(eq(appSettings.key, key))
      .limit(1);
    if (!row) return null;
    return {
      value: row.value as T,
      updatedAt: row.updatedAt ?? null,
      updatedBy: row.updatedById
        ? { id: row.updatedById, name: row.updatedByName ?? null, email: row.updatedByEmail ?? null }
        : null,
    };
  }

  /** Upsert the JSON value for a key, recording who changed it and when. */
  async set(key: string, value: unknown, updatedBy?: string | null): Promise<void> {
    await this.db
      .insert(appSettings)
      .values({ key, value, updated_by: updatedBy ?? null })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value, updated_by: updatedBy ?? null, updated_at: sql`now()` },
      });
  }
}
