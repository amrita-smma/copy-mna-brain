import { desc, eq } from "drizzle-orm";
import { employerNotes } from "@/lib/db/schema";
import type { DbClient } from "./types";

export type EmployerNote = typeof employerNotes.$inferSelect;
export type EmployerNoteInsert = typeof employerNotes.$inferInsert;
export type EmployerNoteUpdate = Partial<EmployerNoteInsert>;

export class EmployerNoteRepository {
  constructor(private db: DbClient) {}

  async findByEmployerId(employerId: string): Promise<EmployerNote[]> {
    return this.db
      .select()
      .from(employerNotes)
      .where(eq(employerNotes.employer_id, employerId))
      .orderBy(desc(employerNotes.created_at));
  }

  async findById(id: string): Promise<EmployerNote | undefined> {
    const rows = await this.db
      .select()
      .from(employerNotes)
      .where(eq(employerNotes.id, id))
      .limit(1);
    return rows[0];
  }

  async insert(data: EmployerNoteInsert): Promise<EmployerNote> {
    const [row] = await this.db
      .insert(employerNotes)
      .values(data)
      .returning();
    return row;
  }

  async update(
    id: string,
    data: EmployerNoteUpdate,
  ): Promise<EmployerNote | undefined> {
    const [row] = await this.db
      .update(employerNotes)
      .set({ ...data, updated_at: new Date().toISOString() })
      .where(eq(employerNotes.id, id))
      .returning();
    return row;
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(employerNotes).where(eq(employerNotes.id, id));
  }
}
