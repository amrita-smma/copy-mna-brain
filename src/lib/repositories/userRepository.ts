import { asc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { users } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export type UserListItem = Pick<Tables<'users'>, 'id' | 'name' | 'email' | 'role'>;

export class UserRepository {
  constructor(private readonly db: DbClient) {}

  async findAll(): Promise<UserListItem[]> {
    return this.db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .orderBy(asc(users.name));
  }

  // Bulk id → name/email lookup. Used to attribute workforce-queue rows to
  // their submitter without an N+1 fetch from the client. Returns only the
  // ids present in the table; callers should treat missing rows as null.
  async findByIds(ids: string[]): Promise<Array<Pick<UserListItem, 'id' | 'name' | 'email'>>> {
    if (ids.length === 0) return [];
    return this.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, ids));
  }

  /** Case-insensitive bulk email lookup for ingestion pipelines. */
  async findByEmails(
    emails: string[],
  ): Promise<Array<Pick<UserListItem, 'id' | 'email'>>> {
    const normalized = [...new Set(
      emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
    )];
    if (normalized.length === 0) return [];

    return this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(sql<string>`lower(${users.email})`, normalized));
  }

  /**
   * Case-insensitive bulk name lookup. Used to resolve free-text PIC fields
   * (deal_sponsor / deal_captain / Track PIC) to platform users so they can
   * be emailed. Names are not unique — callers get every match.
   */
  async findByNames(
    names: string[],
  ): Promise<Array<Pick<UserListItem, 'id' | 'name' | 'email'>>> {
    const normalized = [...new Set(
      names.map((name) => name.trim().toLowerCase()).filter(Boolean),
    )];
    if (normalized.length === 0) return [];

    return this.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(sql<string>`lower(${users.name})`, normalized));
  }

  async findByEmail(email: string): Promise<Tables<'users'> | null> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(ilike(users.email, email.toLowerCase().trim()))
      .limit(1);
    return row ?? null;
  }

  async create(row: TablesInsert<'users'>): Promise<Tables<'users'>> {
    const [created] = await this.db.insert(users).values(row).returning();
    return created;
  }


  async update(id: string, updates: TablesUpdate<'users'>): Promise<void> {
    await this.db.update(users).set(updates).where(eq(users.id, id));
  }
}
