import { eq, desc } from "drizzle-orm";
import { contactMessages } from "@/lib/db/schema";
import type { DbClient } from "./types";

export type ContactMessage = typeof contactMessages.$inferSelect;
export type ContactMessageInsert = typeof contactMessages.$inferInsert;

export class ContactMessageRepository {
  constructor(private db: DbClient) {}

  async findByContactId(contactId: string): Promise<ContactMessage[]> {
    return this.db
      .select()
      .from(contactMessages)
      .where(eq(contactMessages.contact_id, contactId))
      .orderBy(desc(contactMessages.sent_at));
  }

  async findById(id: string): Promise<ContactMessage | undefined> {
    const rows = await this.db
      .select()
      .from(contactMessages)
      .where(eq(contactMessages.id, id))
      .limit(1);
    return rows[0];
  }

  async findByFileId(fileId: string): Promise<ContactMessage[]> {
    return this.db
      .select()
      .from(contactMessages)
      .where(eq(contactMessages.file_id, fileId))
      .orderBy(desc(contactMessages.sent_at));
  }

  async insert(data: ContactMessageInsert): Promise<ContactMessage> {
    const [row] = await this.db.insert(contactMessages).values(data).returning();
    return row;
  }

  async insertMany(data: ContactMessageInsert[]): Promise<ContactMessage[]> {
    if (data.length === 0) return [];
    return this.db.insert(contactMessages).values(data).returning();
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(contactMessages).where(eq(contactMessages.id, id));
  }

  async deleteByFileId(fileId: string): Promise<void> {
    await this.db
      .delete(contactMessages)
      .where(eq(contactMessages.file_id, fileId));
  }
}
