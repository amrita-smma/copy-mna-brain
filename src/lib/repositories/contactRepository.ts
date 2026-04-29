import { eq, ilike, or, desc } from "drizzle-orm";
import { contacts } from "@/lib/db/schema";
import type { DbClient } from "./types";

export type Contact = typeof contacts.$inferSelect;
export type ContactInsert = typeof contacts.$inferInsert;

export class ContactRepository {
  constructor(private db: DbClient) {}

  async findAll(): Promise<Contact[]> {
    return this.db.select().from(contacts).orderBy(desc(contacts.created_at));
  }

  async findById(id: string): Promise<Contact | undefined> {
    const rows = await this.db
      .select()
      .from(contacts)
      .where(eq(contacts.id, id))
      .limit(1);
    return rows[0];
  }

  async findByEmail(email: string): Promise<Contact | undefined> {
    const rows = await this.db
      .select()
      .from(contacts)
      .where(eq(contacts.email, email))
      .limit(1);
    return rows[0];
  }

  async search(query: string): Promise<Contact[]> {
    const pattern = `%${query}%`;
    return this.db
      .select()
      .from(contacts)
      .where(
        or(
          ilike(contacts.name, pattern),
          ilike(contacts.email, pattern),
          ilike(contacts.company, pattern),
        ),
      )
      .orderBy(desc(contacts.created_at));
  }

  async insert(data: ContactInsert): Promise<Contact> {
    const [row] = await this.db.insert(contacts).values(data).returning();
    return row;
  }

  async update(
    id: string,
    data: Partial<ContactInsert>,
  ): Promise<Contact | undefined> {
    const [row] = await this.db
      .update(contacts)
      .set({ ...data, updated_at: new Date().toISOString() })
      .where(eq(contacts.id, id))
      .returning();
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(contacts).where(eq(contacts.id, id));
  }

  async findOrCreateByEmail(
    email: string,
    defaultData: Partial<ContactInsert>,
  ): Promise<Contact> {
    const existing = await this.findByEmail(email);
    if (existing) return existing;
    return this.insert({ email, name: defaultData.name || email, ...defaultData });
  }
}
