import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { employerNoteRevisions, employerNotes, users } from "@/lib/db/schema";
import type { DbClient } from "./types";

export type EmployerNote = typeof employerNotes.$inferSelect;
export type EmployerNoteInsert = typeof employerNotes.$inferInsert;
export type EmployerNoteUpdate = Partial<EmployerNoteInsert>;
export type EmployerNoteRevision = typeof employerNoteRevisions.$inferSelect;

/** A note as the Notes tab lists it: who wrote it and who last changed it. */
export type EmployerNoteListItem = EmployerNote & {
  author_name: string | null;
  updated_by_name: string | null;
};

/** One audit row, with the name of whoever made the change. */
export type EmployerNoteRevisionItem = EmployerNoteRevision & {
  changed_by_name: string | null;
};

const authors = alias(users, "note_authors");
const editors = alias(users, "note_editors");

export class EmployerNoteRepository {
  constructor(private db: DbClient) {}

  // Notes are always workspace-authored (no shared/auto case, unlike
  // correspondents) — workspace_id is a direct NOT NULL column, so scoping
  // is a plain filter, not a membership join. Soft-deleted notes are hidden
  // from every read; their history stays in employer_note_revisions.
  async findByEmployerId(
    employerId: string,
    workspaceId: string,
  ): Promise<EmployerNoteListItem[]> {
    const rows = await this.db
      .select({
        note: employerNotes,
        author_name: authors.name,
        updated_by_name: editors.name,
      })
      .from(employerNotes)
      .leftJoin(authors, eq(authors.id, employerNotes.author_user_id))
      .leftJoin(editors, eq(editors.id, employerNotes.updated_by))
      .where(
        and(
          eq(employerNotes.employer_id, employerId),
          eq(employerNotes.workspace_id, workspaceId),
          isNull(employerNotes.deleted_at),
        ),
      )
      .orderBy(desc(employerNotes.created_at));
    return rows.map((r) => ({
      ...r.note,
      author_name: r.author_name,
      updated_by_name: r.updated_by_name,
    }));
  }

  async findById(
    id: string,
    workspaceId: string,
  ): Promise<EmployerNote | undefined> {
    const rows = await this.db
      .select()
      .from(employerNotes)
      .where(
        and(
          eq(employerNotes.id, id),
          eq(employerNotes.workspace_id, workspaceId),
          isNull(employerNotes.deleted_at),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** Insert a note and its `create` revision atomically. */
  async createWithRevision(data: {
    employer_id: string;
    workspace_id: string;
    content: string;
    author_user_id: string | null;
  }): Promise<EmployerNote> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(employerNotes).values(data).returning();
      await tx.insert(employerNoteRevisions).values({
        workspace_id: data.workspace_id,
        note_id: row.id,
        action: "create",
        content_before: null,
        content_after: row.content,
        changed_by: data.author_user_id,
      });
      return row;
    });
  }

  /**
   * Replace a live note's content and record the before/after as an `edit`
   * revision, atomically. `undefined` when the note is missing, deleted or in
   * another workspace — nothing is written then.
   */
  async editWithRevision(
    id: string,
    workspaceId: string,
    content: string,
    userId: string | null,
  ): Promise<EmployerNote | undefined> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(employerNotes)
        .where(
          and(
            eq(employerNotes.id, id),
            eq(employerNotes.workspace_id, workspaceId),
            isNull(employerNotes.deleted_at),
          ),
        )
        .limit(1)
        .for("update");
      if (!current) return undefined;
      const [row] = await tx
        .update(employerNotes)
        .set({ content, updated_by: userId, updated_at: new Date().toISOString() })
        .where(eq(employerNotes.id, id))
        .returning();
      await tx.insert(employerNoteRevisions).values({
        workspace_id: workspaceId,
        note_id: id,
        action: "edit",
        content_before: current.content,
        content_after: content,
        changed_by: userId,
      });
      return row;
    });
  }

  /**
   * Soft-delete a live note and record a `delete` revision holding its last
   * content, atomically. Returns false when there was nothing to delete.
   */
  async softDeleteWithRevision(
    id: string,
    workspaceId: string,
    userId: string | null,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(employerNotes)
        .where(
          and(
            eq(employerNotes.id, id),
            eq(employerNotes.workspace_id, workspaceId),
            isNull(employerNotes.deleted_at),
          ),
        )
        .limit(1)
        .for("update");
      if (!current) return false;
      const now = new Date().toISOString();
      await tx
        .update(employerNotes)
        .set({ deleted_at: now, deleted_by: userId, updated_at: now })
        .where(eq(employerNotes.id, id));
      await tx.insert(employerNoteRevisions).values({
        workspace_id: workspaceId,
        note_id: id,
        action: "delete",
        content_before: current.content,
        content_after: null,
        changed_by: userId,
      });
      return true;
    });
  }

  /** A note's full history, oldest first — including a deleted note's. */
  async listRevisions(
    noteId: string,
    workspaceId: string,
  ): Promise<EmployerNoteRevisionItem[]> {
    const rows = await this.db
      .select({ revision: employerNoteRevisions, changed_by_name: users.name })
      .from(employerNoteRevisions)
      .leftJoin(users, eq(users.id, employerNoteRevisions.changed_by))
      .where(
        and(
          eq(employerNoteRevisions.note_id, noteId),
          eq(employerNoteRevisions.workspace_id, workspaceId),
        ),
      )
      .orderBy(asc(employerNoteRevisions.changed_at));
    return rows.map((r) => ({ ...r.revision, changed_by_name: r.changed_by_name }));
  }
}
