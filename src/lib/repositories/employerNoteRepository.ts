import { and, desc, eq } from "drizzle-orm";
import { employerNotes } from "@/lib/db/schema";
import type { DbClient } from "./types";

export type EmployerNote = typeof employerNotes.$inferSelect;
export type EmployerNoteInsert = typeof employerNotes.$inferInsert;
export type EmployerNoteUpdate = Partial<EmployerNoteInsert>;

export class EmployerNoteRepository {
  constructor(private db: DbClient) {}

  // Notes are always workspace-authored (no shared/auto case, unlike
  // correspondents) — workspace_id is a direct NOT NULL column, so scoping
  // is a plain filter, not a membership join.
  async findByEmployerId(
    employerId: string,
    workspaceId: string,
  ): Promise<EmployerNote[]> {
    return this.db
      .select()
      .from(employerNotes)
      .where(
        and(
          eq(employerNotes.employer_id, employerId),
          eq(employerNotes.workspace_id, workspaceId),
        ),
      )
      .orderBy(desc(employerNotes.created_at));
  }

  async findById(
    id: string,
    workspaceId: string,
  ): Promise<EmployerNote | undefined> {
    const rows = await this.db
      .select()
      .from(employerNotes)
      .where(
        and(eq(employerNotes.id, id), eq(employerNotes.workspace_id, workspaceId)),
      )
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
    workspaceId: string,
  ): Promise<EmployerNote | undefined> {
    const [row] = await this.db
      .update(employerNotes)
      .set({ ...data, updated_at: new Date().toISOString() })
      .where(
        and(eq(employerNotes.id, id), eq(employerNotes.workspace_id, workspaceId)),
      )
      .returning();
    return row;
  }

  async delete(id: string, workspaceId: string): Promise<void> {
    await this.db
      .delete(employerNotes)
      .where(
        and(eq(employerNotes.id, id), eq(employerNotes.workspace_id, workspaceId)),
      );
  }
}
