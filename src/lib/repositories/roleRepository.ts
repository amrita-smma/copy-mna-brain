import { eq } from 'drizzle-orm';
import { roles } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert } from './types';

export class RoleRepository {
  constructor(private readonly db: DbClient) {}

  async findAll(): Promise<Tables<'roles'>[]> {
    return this.db.select().from(roles);
  }

  async findByName(name: string): Promise<Tables<'roles'> | undefined> {
    const [row] = await this.db.select().from(roles).where(eq(roles.name, name)).limit(1);
    return row;
  }

  async insert(data: TablesInsert<'roles'>): Promise<Tables<'roles'>> {
    const [row] = await this.db.insert(roles).values(data).returning();
    return row;
  }
}
