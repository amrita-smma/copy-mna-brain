import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { companies, companyVoteBallots, companyVoteSessions } from '@/lib/db/schema';
import type { DbClient, Tables, TablesInsert, TablesUpdate } from './types';

export type VoteSessionRow = Tables<'company_vote_sessions'>;
export type VoteBallotRow = Tables<'company_vote_ballots'>;

/**
 * Data access for the company voting system: `company_vote_sessions` (one row
 * per voting round) and `company_vote_ballots` (one row per selected voter).
 *
 * Every read and every UPDATE/DELETE is workspace-scoped: sessions carry
 * `workspace_id` directly (stamped by `createSession`, never supplied by the
 * caller), and ballot statements additionally filter on
 * `workspaceSessionIds()`. `insertBallots` is the one exception — it trusts its
 * `vote_session_id`, so only call it with a session this repository just
 * created.
 */
export class CompanyVoteRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  /** Session ids visible to this workspace — the guard every ballot write goes through. */
  private workspaceSessionIds() {
    return this.db
      .select({ id: companyVoteSessions.id })
      .from(companyVoteSessions)
      .where(eq(companyVoteSessions.workspace_id, this.workspaceId));
  }

  async findSessionById(id: string): Promise<VoteSessionRow | null> {
    const [row] = await this.db
      .select()
      .from(companyVoteSessions)
      .where(
        and(
          eq(companyVoteSessions.id, id),
          eq(companyVoteSessions.workspace_id, this.workspaceId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** The open round for a company, if any. At most one exists (partial unique index). */
  async findActiveSessionByCompanyId(companyId: string): Promise<VoteSessionRow | null> {
    const [row] = await this.db
      .select()
      .from(companyVoteSessions)
      .where(
        and(
          eq(companyVoteSessions.company_id, companyId),
          eq(companyVoteSessions.workspace_id, this.workspaceId),
          eq(companyVoteSessions.status, 'active'),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * The most recent round for a company regardless of status — this is what the
   * Voting tab renders (an open round, or the last concluded one's results).
   */
  async findLatestSessionByCompanyId(companyId: string): Promise<VoteSessionRow | null> {
    const [row] = await this.db
      .select()
      .from(companyVoteSessions)
      .where(
        and(
          eq(companyVoteSessions.company_id, companyId),
          eq(companyVoteSessions.workspace_id, this.workspaceId),
        ),
      )
      .orderBy(desc(companyVoteSessions.created_at))
      .limit(1);
    return row ?? null;
  }

  /** Every round for a company, newest first. */
  async listSessionsByCompanyId(companyId: string): Promise<VoteSessionRow[]> {
    return this.db
      .select()
      .from(companyVoteSessions)
      .where(
        and(
          eq(companyVoteSessions.company_id, companyId),
          eq(companyVoteSessions.workspace_id, this.workspaceId),
        ),
      )
      .orderBy(desc(companyVoteSessions.created_at));
  }

  /**
   * Open sessions whose deadline has passed — the cron sweep's work list.
   * Ordered oldest-deadline-first so a backlog is drained in the order it
   * expired.
   */
  async findDueSessions(now: string): Promise<VoteSessionRow[]> {
    return this.db
      .select()
      .from(companyVoteSessions)
      .where(
        and(
          eq(companyVoteSessions.workspace_id, this.workspaceId),
          eq(companyVoteSessions.status, 'active'),
          lte(companyVoteSessions.deadline_at, now),
        ),
      )
      .orderBy(asc(companyVoteSessions.deadline_at));
  }

  /** `workspace_id` is stamped here, never taken from the caller. */
  async createSession(
    data: Omit<TablesInsert<'company_vote_sessions'>, 'workspace_id'>,
  ): Promise<VoteSessionRow> {
    const [row] = await this.db
      .insert(companyVoteSessions)
      .values({ ...data, workspace_id: this.workspaceId })
      .returning();
    return row;
  }

  /**
   * Update a session, optionally as a **compare-and-swap** on its current
   * status.
   *
   * `expectedStatus` is what makes closing and cancelling a round safe against
   * concurrency: two racing last-submits (or a last-submit racing the deadline
   * cron) both read `active`, but only one `UPDATE … WHERE status = 'active'`
   * matches a row. The loser gets `null` back and must not repeat the
   * side effects. Never replace it with a read-then-write.
   */
  async updateSession(
    id: string,
    updates: TablesUpdate<'company_vote_sessions'>,
    opts?: { expectedStatus?: VoteSessionRow['status'] },
  ): Promise<VoteSessionRow | null> {
    const conditions = [
      eq(companyVoteSessions.id, id),
      eq(companyVoteSessions.workspace_id, this.workspaceId),
    ];
    if (opts?.expectedStatus) {
      conditions.push(eq(companyVoteSessions.status, opts.expectedStatus));
    }
    const [row] = await this.db
      .update(companyVoteSessions)
      .set({ ...updates, updated_at: sql`now()` })
      .where(and(...conditions))
      .returning();
    return row ?? null;
  }

  /** Remove a session (and its ballots, via FK cascade). */
  async deleteSession(id: string): Promise<void> {
    await this.db
      .delete(companyVoteSessions)
      .where(
        and(
          eq(companyVoteSessions.id, id),
          eq(companyVoteSessions.workspace_id, this.workspaceId),
        ),
      );
  }

  async insertBallots(rows: Array<TablesInsert<'company_vote_ballots'>>): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(companyVoteBallots).values(rows);
  }

  /** Ballots for one session, ordered by voter name so the results grid is stable. */
  async listBallotsBySessionId(sessionId: string): Promise<VoteBallotRow[]> {
    return this.listBallotsBySessionIds([sessionId]);
  }

  /**
   * Batched ballot fetch. Ordered by session id first so a caller with many
   * sessions can group the result in a single pass — this is what keeps the
   * "vote history" read off an N+1.
   */
  async listBallotsBySessionIds(sessionIds: string[]): Promise<VoteBallotRow[]> {
    if (sessionIds.length === 0) return [];
    return this.db
      .select()
      .from(companyVoteBallots)
      .where(
        and(
          inArray(companyVoteBallots.vote_session_id, sessionIds),
          inArray(companyVoteBallots.vote_session_id, this.workspaceSessionIds()),
        ),
      )
      .orderBy(
        asc(companyVoteBallots.vote_session_id),
        asc(companyVoteBallots.created_at),
      );
  }

  async findBallot(sessionId: string, voterId: string): Promise<VoteBallotRow | null> {
    const [row] = await this.db
      .select()
      .from(companyVoteBallots)
      .where(
        and(
          eq(companyVoteBallots.vote_session_id, sessionId),
          eq(companyVoteBallots.voter_id, voterId),
          inArray(companyVoteBallots.vote_session_id, this.workspaceSessionIds()),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Update one ballot, optionally as a **compare-and-swap** on its status.
   *
   * `expectedStatus: 'draft'` is what actually enforces "a submitted vote can
   * no longer be changed": a service-level pre-check cannot, because an
   * autosave and a submit can both pass it before either writes. The loser gets
   * `null` back and the caller must surface a conflict.
   */
  async updateBallot(
    id: string,
    updates: TablesUpdate<'company_vote_ballots'>,
    opts?: { expectedStatus?: VoteBallotRow['status'] },
  ): Promise<VoteBallotRow | null> {
    const conditions = [
      eq(companyVoteBallots.id, id),
      inArray(companyVoteBallots.vote_session_id, this.workspaceSessionIds()),
    ];
    if (opts?.expectedStatus) {
      conditions.push(eq(companyVoteBallots.status, opts.expectedStatus));
    }
    const [row] = await this.db
      .update(companyVoteBallots)
      .set({ ...updates, updated_at: sql`now()` })
      .where(and(...conditions))
      .returning();
    return row ?? null;
  }

  /**
   * Flip every ballot of a session in one statement — used by "send back
   * submissions" (submitted → draft) and by the deadline sweep (draft →
   * submitted). Set-based on purpose: never SELECT-then-loop-and-update.
   */
  async updateBallotsBySessionId(
    sessionId: string,
    updates: TablesUpdate<'company_vote_ballots'>,
    opts?: {
      onlyStatus?: VoteBallotRow['status'];
      /**
       * Narrow to ballots that have (`false`) or lack (`true`) a recorded
       * choice. The deadline sweep needs both halves: a draft the voter already
       * picked a choice on keeps it, while one they never touched becomes
       * INCONCLUSIVE.
       */
      choiceIsNull?: boolean;
    },
  ): Promise<VoteBallotRow[]> {
    const conditions = [
      eq(companyVoteBallots.vote_session_id, sessionId),
      inArray(companyVoteBallots.vote_session_id, this.workspaceSessionIds()),
    ];
    if (opts?.onlyStatus) {
      conditions.push(eq(companyVoteBallots.status, opts.onlyStatus));
    }
    if (opts?.choiceIsNull !== undefined) {
      conditions.push(
        opts.choiceIsNull
          ? isNull(companyVoteBallots.choice)
          : isNotNull(companyVoteBallots.choice),
      );
    }
    return this.db
      .update(companyVoteBallots)
      .set({ ...updates, updated_at: sql`now()` })
      .where(and(...conditions))
      .returning();
  }

  /** Company name fields for the emails/results header, without pulling the whole row. */
  async findCompanyNames(
    companyId: string,
  ): Promise<Pick<Tables<'companies'>, 'id' | 'target' | 'project_name'> | null> {
    const [row] = await this.db
      .select({
        id: companies.id,
        target: companies.target,
        project_name: companies.project_name,
      })
      .from(companies)
      .where(
        and(eq(companies.id, companyId), eq(companies.workspace_id, this.workspaceId)),
      )
      .limit(1);
    return row ?? null;
  }
}
