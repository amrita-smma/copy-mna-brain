import { and, eq } from "drizzle-orm";
import {
  emailParticipants,
  employerTeamMembers,
  users,
} from "@/lib/db/schema";
import type { DbClient } from "./types";

export type EmployerTeamMember = typeof employerTeamMembers.$inferSelect;

export interface TeamMember {
  id: string;
  name: string;
  email: string | null;
}

export class EmployerTeamRepository {
  constructor(private db: DbClient) {}

  async listForEmployer(employerId: string): Promise<TeamMember[]> {
    const rows = await this.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(employerTeamMembers)
      .innerJoin(users, eq(users.id, employerTeamMembers.user_id))
      .where(eq(employerTeamMembers.employer_id, employerId));
    return rows;
  }

  async add(employerId: string, userId: string): Promise<void> {
    await this.db
      .insert(employerTeamMembers)
      .values({ employer_id: employerId, user_id: userId })
      .onConflictDoNothing();
  }

  async remove(employerId: string, userId: string): Promise<void> {
    await this.db
      .delete(employerTeamMembers)
      .where(
        and(
          eq(employerTeamMembers.employer_id, employerId),
          eq(employerTeamMembers.user_id, userId),
        ),
      );
  }

  async setMembers(employerId: string, userIds: string[]): Promise<void> {
    await this.db
      .delete(employerTeamMembers)
      .where(eq(employerTeamMembers.employer_id, employerId));
    if (userIds.length === 0) return;
    await this.db
      .insert(employerTeamMembers)
      .values(userIds.map((user_id) => ({ employer_id: employerId, user_id })))
      .onConflictDoNothing();
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
