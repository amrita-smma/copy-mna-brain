import { and, asc, eq, inArray } from "drizzle-orm";
import {
  emailParticipants,
  employerTeamMembers,
  userWorkspaces,
  users,
} from "@/lib/db/schema";
import type { DbClient } from "./types";

export type EmployerTeamMember = typeof employerTeamMembers.$inferSelect;

export interface TeamMember {
  id: string;
  name: string;
  email: string | null;
}

export interface EmployerTeamAssignment {
  workspace_id: string;
  employer_id: string;
  user_id: string;
}

/**
 * Who on our side covers a firm. Per workspace since MB-687: every read and
 * write names the workspace, so one workspace's coverage (and the names of
 * its people) never shows on another workspace's card.
 */
export class EmployerTeamRepository {
  constructor(private db: DbClient) {}

  async listForEmployer(workspaceId: string, employerId: string): Promise<TeamMember[]> {
    const rows = await this.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(employerTeamMembers)
      .innerJoin(users, eq(users.id, employerTeamMembers.user_id))
      .where(
        and(
          eq(employerTeamMembers.workspace_id, workspaceId),
          eq(employerTeamMembers.employer_id, employerId),
        ),
      )
      .orderBy(asc(users.name));
    return rows;
  }

  /**
   * Batched counterpart to `listForEmployer` — coverage for many employers in
   * one query, ordered by employer first so callers can group in a single
   * pass. Use this instead of calling `listForEmployer` per employer.
   */
  async listForEmployers(
    workspaceId: string,
    employerIds: string[],
  ): Promise<Array<TeamMember & { employer_id: string }>> {
    if (employerIds.length === 0) return [];
    return this.db
      .select({
        employer_id: employerTeamMembers.employer_id,
        id: users.id,
        name: users.name,
        email: users.email,
      })
      .from(employerTeamMembers)
      .innerJoin(users, eq(users.id, employerTeamMembers.user_id))
      .where(
        and(
          eq(employerTeamMembers.workspace_id, workspaceId),
          inArray(employerTeamMembers.employer_id, employerIds),
        ),
      )
      .orderBy(asc(employerTeamMembers.employer_id), asc(users.name));
  }

  async add(workspaceId: string, employerId: string, userId: string): Promise<void> {
    await this.db
      .insert(employerTeamMembers)
      .values({ workspace_id: workspaceId, employer_id: employerId, user_id: userId })
      .onConflictDoNothing();
  }

  /**
   * Add employer/user coverage pairs without replacing manual assignments.
   * Duplicate input and already-persisted pairs are ignored.
   */
  async addMany(assignments: EmployerTeamAssignment[]): Promise<number> {
    const unique = [
      ...new Map(
        assignments.map((assignment) => [
          `${assignment.workspace_id}:${assignment.employer_id}:${assignment.user_id}`,
          assignment,
        ]),
      ).values(),
    ];
    if (unique.length === 0) return 0;

    const inserted = await this.db
      .insert(employerTeamMembers)
      .values(unique)
      .onConflictDoNothing()
      .returning({
        employer_id: employerTeamMembers.employer_id,
        user_id: employerTeamMembers.user_id,
      });
    return inserted.length;
  }

  async remove(workspaceId: string, employerId: string, userId: string): Promise<void> {
    await this.db
      .delete(employerTeamMembers)
      .where(
        and(
          eq(employerTeamMembers.workspace_id, workspaceId),
          eq(employerTeamMembers.employer_id, employerId),
          eq(employerTeamMembers.user_id, userId),
        ),
      );
  }

  /** Replace this workspace's coverage of a firm; other workspaces' stays. */
  async setMembers(
    workspaceId: string,
    employerId: string,
    userIds: string[],
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(employerTeamMembers)
        .where(
          and(
            eq(employerTeamMembers.workspace_id, workspaceId),
            eq(employerTeamMembers.employer_id, employerId),
          ),
        );
      if (userIds.length === 0) return;
      await tx
        .insert(employerTeamMembers)
        .values(
          userIds.map((user_id) => ({
            workspace_id: workspaceId,
            employer_id: employerId,
            user_id,
          })),
        )
        .onConflictDoNothing();
    });
  }

  /**
   * Members of one workspace — who the team picker may assign. Assigning a
   * user from another workspace would put their name on this workspace's card.
   */
  async listWorkspaceMembers(workspaceId: string): Promise<TeamMember[]> {
    return this.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(userWorkspaces)
      .innerJoin(users, eq(users.id, userWorkspaces.user_id))
      .where(eq(userWorkspaces.workspace_id, workspaceId))
      .orderBy(asc(users.name));
  }

  /**
   * Internal users that have **sent** at least one CRM email
   * (`email_participants.role = 'from'`). The previous version surfaced every
   * row in `users`, which polluted the team-member filter on the CRM page with
   * accounts that never reached out — only senders should show up.
   */
  async listAllTeamUsers(): Promise<TeamMember[]> {
    return this.db
      .selectDistinct({
        id: users.id,
        name: users.name,
        email: users.email,
      })
      .from(users)
      .innerJoin(
        emailParticipants,
        and(
          eq(emailParticipants.user_id, users.id),
          eq(emailParticipants.role, "from"),
        ),
      )
      .orderBy(users.name);
  }
}
